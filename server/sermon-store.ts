// Where the published sermons live: a folder in OpenCloud, reached via WebDAV with a user's app token (the single
// source of truth, others read there as well), or – without "cloud" in the config, e.g. in development – the
// folder predigten/ in the data directory.
import { createReadStream, openAsBlob } from 'node:fs';
import { link, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Agent, fetch as undiciFetch } from 'undici';
import type { CloudConfig } from './config';

/**
 * Node's fetch gives up when the other side has not answered after 5 minutes (undici's headersTimeout and
 * bodyTimeout) – too short for 20 MB over a slow upstream, and the upload is lost. Requests to OpenCloud use a
 * connection without those limits; WebDav.request sets its own (30 min for files, 1 min otherwise).
 */
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const cloudFetch = ((url: string, init?: RequestInit) =>
  undiciFetch(url, { ...init, dispatcher: patient } as never)) as unknown as typeof fetch;

export interface StoredFile { name: string; size: number; modified: string; }

export interface SermonStore {
  /** "OpenCloud" or "NAS", shown in the app */
  readonly label: string;
  list(): Promise<StoredFile[]>;
  exists(name: string): Promise<boolean>;
  /** null if there is no such file; `version` tells versions apart (ETag in OpenCloud) */
  read(name: string): Promise<{ size: number; body: Readable; version: string | null } | null>;
  /** the file's current version (as in `read`), null if there is no such file */
  version(name: string): Promise<string | null>;
  /**
   * Stores the local file `src` as `name` and removes `src`. `replace`: overwrites the existing file;
   * otherwise refuses with StoreError 409 if the name is taken. `onProgress`: share sent so far (0–1).
   */
  write(name: string, src: string, replace: boolean, onProgress?: (share: number) => void): Promise<void>;
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
    return s?.isFile() ? { size: s.size, body: createReadStream(join(this.dir, name)), version: `${s.mtimeMs}-${s.size}` } : null;
  }

  async version(name: string) {
    const s = await stat(join(this.dir, name)).catch(() => null);
    return s?.isFile() ? `${s.mtimeMs}-${s.size}` : null;
  }

  async write(name: string, src: string, replace: boolean, onProgress?: (share: number) => void) {
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, name);
    if (replace) { await rename(src, target); onProgress?.(1); return; }
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

  constructor(cloud: Pick<CloudConfig, 'user' | 'token'>, private fetchImpl: typeof fetch = cloudFetch) {
    this.auth = 'Basic ' + Buffer.from(`${cloud.user}:${cloud.token}`).toString('base64');
  }

  /** Any answer from the cloud; unreachable → StoreError 502 "cloud unreachable". `timeoutMs`: for the whole exchange. */
  async request(method: string, url: string, init: RequestInit = {}, timeoutMs = method === 'PUT' || method === 'GET' ? 30 * 60_000 : 60_000): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init, method, redirect: 'manual',
        headers: { Authorization: this.auth, ...init.headers as Record<string, string> },
        signal: AbortSignal.timeout(timeoutMs),
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

  constructor(private cloud: CloudConfig, fetchImpl: typeof fetch = cloudFetch) {
    this.dav = new WebDav(cloud, fetchImpl);
  }

  private url(name = '') { return this.cloud.url + encodeURIComponent(name); }
  private request(method: string, url: string, init?: RequestInit, timeoutMs?: number) { return this.dav.request(method, url, init, timeoutMs); }
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
    return {
      size: Number(res.headers.get('content-length')) || 0, version: res.headers.get('etag'),
      body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    };
  }

  async version(name: string) {
    const res = await this.request('HEAD', this.url(name));
    if (res.status === 404) return null;
    if (!res.ok) throw this.failed(res);
    return res.headers.get('etag');
  }

  async write(name: string, src: string, replace: boolean, onProgress?: (share: number) => void) {
    try {
      // OpenCloud ignores "If-None-Match: *" on PUT, so the check comes first (the window in between is short)
      if (!replace && await this.exists(name)) throw new StoreError(409, 'exists');
      const { size } = await stat(src);
      if (size >= TUS_FROM && await this.tus(name, src, size, onProgress)) return;
      const res = await this.request('PUT', this.url(name), {
        headers: { 'Content-Type': 'audio/mpeg' }, body: await openAsBlob(src),
      });
      if (res.status !== 201 && res.status !== 204) throw this.failed(res);
      onProgress?.(1);
    } finally {
      await unlink(src).catch(() => undefined);
    }
  }

  /**
   * Uploads in pieces with the TUS protocol (OpenCloud supports it): each piece is a short request, a piece that
   * fails or hangs is sent again from where the server stands. A slow or interrupted line costs time, not the
   * upload. Resolves false if the server does not offer TUS (then one PUT is used).
   */
  private async tus(name: string, src: string, size: number, onProgress?: (share: number) => void): Promise<boolean> {
    const tus = { 'Tus-Resumable': '1.0.0' };
    const create = await this.request('POST', this.url(), {
      headers: { ...tus, 'Upload-Length': String(size), 'Upload-Metadata': `filename ${Buffer.from(name).toString('base64')}`, 'Content-Length': '0' },
    });
    const location = create.headers.get('location');
    if (create.status !== 201 || !location) {
      if (create.status === 405 || create.status === 412 || create.status === 501) { create.body?.cancel().catch(() => undefined); return false; }
      throw this.failed(create);
    }
    create.body?.cancel().catch(() => undefined);
    const upload = new URL(location, this.cloud.url).href;
    const file = await openAsBlob(src);
    let offset = 0, failures = 0;
    while (offset < size) {
      const end = Math.min(offset + TUS_PIECE, size);
      try {
        const res = await this.request('PATCH', upload, {
          headers: { ...tus, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: file.slice(offset, end),
        }, PIECE_TIMEOUT);
        res.body?.cancel().catch(() => undefined);
        if (res.status === 204) {
          offset = Number(res.headers.get('upload-offset')) || end;
          failures = 0;
          onProgress?.(offset / size);
          continue;
        }
        // 409: the server stands elsewhere; 5xx: try again – anything else (401, 404 expired …) is final
        if (res.status !== 409 && res.status < 500) throw this.failed(res);
      } catch (e) {
        if (!(e instanceof StoreError && e.message.startsWith('cloud unreachable'))) throw e;
      }
      if (++failures > PIECE_RETRIES) throw new StoreError(502, `cloud unreachable (Upload hängt bei ${Math.round(offset / size * 100)} %)`);
      await new Promise(r => setTimeout(r, failures * RETRY_PAUSE_MS));
      // a piece may have arrived although its answer did not: ask where the upload stands
      const head = await this.request('HEAD', upload, { headers: tus }).catch(() => null);
      head?.body?.cancel().catch(() => undefined);
      const at = Number(head?.headers.get('upload-offset'));
      if (head?.ok && Number.isFinite(at)) offset = at;
    }
    return true;
  }
}

/** Files from this size go up in pieces (TUS); a piece is sent again if it takes longer than PIECE_TIMEOUT. */
const TUS_FROM = 1024 * 1024;
const TUS_PIECE = 4 * 1024 * 1024;
const PIECE_TIMEOUT = 2 * 60_000;
const PIECE_RETRIES = 5;
const RETRY_PAUSE_MS = 2000;
