// Where the published sermons live: a folder in OpenCloud, reached via WebDAV with a user's app token (the single
// source of truth, others read there as well), or – without "cloud" in the config, e.g. in development – the
// folder predigten/ in the data directory.
import { createReadStream, openAsBlob } from 'node:fs';
import { link, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CloudConfig } from './config';

export interface StoredFile { name: string; size: number; modified: string; }

export interface SermonStore {
  /** "OpenCloud" or "NAS", shown in the app */
  readonly label: string;
  list(): Promise<StoredFile[]>;
  exists(name: string): Promise<boolean>;
  /** null if there is no such file */
  read(name: string): Promise<{ size: number; body: Readable } | null>;
  /**
   * Stores the local file `src` as `name` and removes `src`. `replace`: overwrites the existing file;
   * otherwise refuses with StoreError 409 if the name is taken.
   */
  write(name: string, src: string, replace: boolean): Promise<void>;
}

/** `status`: what the API answers – 409 name taken, 502 the cloud failed (`message` says how). */
export class StoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** A German explanation for the log and the setup check. */
export function describeStoreError(e: unknown): string {
  const m = e instanceof StoreError ? e.message : String((e as Error)?.message ?? e);
  if (m === 'cloud 401') return 'Anmeldung abgelehnt (401) – Benutzername oder App-Token falsch oder abgelaufen.';
  if (m === 'cloud 404') return 'Ordner nicht gefunden (404) – cloud.url prüfen (WebDAV-Adresse des Ordners).';
  if (m === 'cloud 403') return 'Zugriff verweigert (403) – darf der Benutzer in diesem Ordner schreiben?';
  if (m.startsWith('cloud unreachable')) return `nicht erreichbar ${m.slice('cloud unreachable'.length).trim()} – Adresse und Netzwerk prüfen.`.replace('  ', ' ');
  return m;
}

export function createStore(cloud: CloudConfig | null, dataDir: string): SermonStore {
  return cloud ? new WebDavStore(cloud) : new LocalStore(join(dataDir, 'predigten'));
}

export class LocalStore implements SermonStore {
  readonly label = 'NAS';
  constructor(private dir: string) {}

  async list() {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const files = await Promise.all(names.map(async name => {
      const s = await stat(join(this.dir, name)).catch(() => null);
      return s?.isFile() ? { name, size: s.size, modified: s.mtime.toISOString() } : null;
    }));
    return files.filter(f => f !== null);
  }

  async exists(name: string) {
    return !!(await stat(join(this.dir, name)).catch(() => null))?.isFile();
  }

  async read(name: string) {
    const s = await stat(join(this.dir, name)).catch(() => null);
    return s?.isFile() ? { size: s.size, body: createReadStream(join(this.dir, name)) } : null;
  }

  async write(name: string, src: string, replace: boolean) {
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, name);
    if (replace) { await rename(src, target); return; }
    try {
      // a hard link fails if the name is taken, so two uploads of the same name cannot overwrite each other
      await link(src, target).catch(e => {
        throw (e as NodeJS.ErrnoException).code === 'EEXIST' ? new StoreError(409, 'exists') : e;
      });
    } finally {
      await unlink(src).catch(() => undefined);
    }
  }
}

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>';

/** The text of the first <prefix:name> element in `xml` (namespace prefixes vary between servers). */
export const element = (xml: string, name: string) =>
  new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml)?.[1];
const blocks = (xml: string, name: string) => xml.split(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`)).slice(1);
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The files in a WebDAV multistatus answer (PROPFIND, Depth 1); folders are left out. */
export function parseMultistatus(xml: string): StoredFile[] {
  const files: StoredFile[] = [];
  for (const response of blocks(xml, 'response')) {
    const href = element(response, 'href');
    // only properties the server found (a second propstat lists the missing ones as 404)
    const props = blocks(response, 'propstat').filter(p => /\s200\s/.test(element(p, 'status') ?? '')).join('');
    if (!href || /<(?:[\w-]+:)?collection\b/.test(props)) continue;
    const name = decodeURIComponent(unescapeXml(href).replace(/\/$/, '').split('/').pop() ?? '');
    const modified = new Date(element(props, 'getlastmodified') ?? '');
    files.push({ name, size: Number(element(props, 'getcontentlength')) || 0, modified: isNaN(+modified) ? '' : modified.toISOString() });
  }
  return files;
}

/** Requests to OpenCloud with the app token (Basic auth) and its errors, shared by the sermon folder and CloudFile. */
export class WebDav {
  private auth: string;

  constructor(cloud: Pick<CloudConfig, 'user' | 'token'>, private fetchImpl: typeof fetch = fetch) {
    this.auth = 'Basic ' + Buffer.from(`${cloud.user}:${cloud.token}`).toString('base64');
  }

  /** Any answer from the cloud; unreachable → StoreError 502 "cloud unreachable". */
  async request(method: string, url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init, method, redirect: 'manual',
        headers: { Authorization: this.auth, ...init.headers as Record<string, string> },
        signal: AbortSignal.timeout(method === 'PUT' || method === 'GET' ? 30 * 60_000 : 60_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      throw new StoreError(502, `cloud unreachable${cause ? ` (${cause})` : ''}`);
    }
  }

  /** 401: token wrong or expired, 404: not found, … – the client turns these into messages. */
  failed(res: Response): StoreError {
    res.body?.cancel().catch(() => undefined);
    return new StoreError(502, `cloud ${res.status}`);
  }
}

export class WebDavStore implements SermonStore {
  readonly label = 'OpenCloud';
  private dav: WebDav;

  constructor(private cloud: CloudConfig, fetchImpl: typeof fetch = fetch) {
    this.dav = new WebDav(cloud, fetchImpl);
  }

  private url(name = '') { return this.cloud.url + encodeURIComponent(name); }
  private request(method: string, url: string, init?: RequestInit) { return this.dav.request(method, url, init); }
  private failed(res: Response) { return this.dav.failed(res); }

  async list() {
    const res = await this.request('PROPFIND', this.url(), {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY,
    });
    if (res.status !== 207) throw this.failed(res);
    return parseMultistatus(await res.text());
  }

  async exists(name: string) {
    const res = await this.request('HEAD', this.url(name));
    if (res.status === 404) return false;
    if (!res.ok) throw this.failed(res);
    return true;
  }

  async read(name: string) {
    const res = await this.request('GET', this.url(name));
    if (res.status === 404) { res.body?.cancel().catch(() => undefined); return null; }
    if (!res.ok || !res.body) throw this.failed(res);
    return { size: Number(res.headers.get('content-length')) || 0, body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream) };
  }

  async write(name: string, src: string, replace: boolean) {
    try {
      // OpenCloud ignores "If-None-Match: *" on PUT, so the check comes first (the window in between is short)
      if (!replace && await this.exists(name)) throw new StoreError(409, 'exists');
      const res = await this.request('PUT', this.url(name), {
        headers: { 'Content-Type': 'audio/mpeg' }, body: await openAsBlob(src),
      });
      if (res.status !== 201 && res.status !== 204) throw this.failed(res);
    } finally {
      await unlink(src).catch(() => undefined);
    }
  }
}
