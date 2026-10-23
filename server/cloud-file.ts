// Single files in OpenCloud that other people maintain (Einsatzplan, eAg-Übersicht): read together with their
// version tag (ETag), checked for changes at most every few minutes, and written only if nobody changed them in
// the meantime (If-Match – OpenCloud answers 412 otherwise).
import type { CloudConfig } from './config';
import { element, StoreError, WebDav } from './sermon-store';

export interface FileVersion { data: Uint8Array; etag: string; modified: string; }

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STAT_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/></d:prop></d:propfind>';
/** `"abc"` and `W/"abc"` from different answers mean the same version */
const sameTag = (a: string, b: string) => a.replace(/^W\//, '').replace(/"/g, '') === b.replace(/^W\//, '').replace(/"/g, '');
const isoTime = (http: string | null | undefined) => { const d = new Date(http ?? ''); return isNaN(+d) ? '' : d.toISOString(); };

export class CloudFile {
  private dav: WebDav;

  constructor(readonly url: string, cloud: Pick<CloudConfig, 'user' | 'token'>, fetchImpl: typeof fetch = fetch) {
    this.dav = new WebDav(cloud, fetchImpl);
  }

  /** Version tag and modification time, without downloading the file. */
  async stat(): Promise<{ etag: string; modified: string }> {
    const res = await this.dav.request('PROPFIND', this.url, { headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: STAT_BODY });
    if (res.status !== 207) throw this.dav.failed(res);
    const xml = await res.text();
    return { etag: element(xml, 'getetag') ?? '', modified: isoTime(element(xml, 'getlastmodified')) };
  }

  async get(): Promise<FileVersion> {
    const res = await this.dav.request('GET', this.url);
    if (!res.ok) throw this.dav.failed(res);
    return { data: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get('etag') ?? '', modified: isoTime(res.headers.get('last-modified')) };
  }

  /** Uploads `data` if the file is still at version `etag`: StoreError 409 "changed" if not, 423 "locked" while it is opened for editing. */
  async put(data: Uint8Array, etag: string): Promise<void> {
    const res = await this.dav.request('PUT', this.url, {
      headers: { 'If-Match': etag, 'Content-Type': XLSX_TYPE }, body: data as Uint8Array<ArrayBuffer>,
    });
    if (res.status === 412) { res.body?.cancel().catch(() => undefined); throw new StoreError(409, 'changed'); }
    if (res.status === 423) { res.body?.cancel().catch(() => undefined); throw new StoreError(423, 'locked'); }
    if (res.status !== 201 && res.status !== 204) throw this.dav.failed(res);
  }
}

/** The latest version of a CloudFile, kept in memory; asks OpenCloud for changes at most every `maxAgeMs`. */
export class SyncedFile {
  private current: FileVersion | null = null;
  private checked = 0;
  /** the last check failed: reported until a check succeeds (retried no more often than checks) */
  private error: unknown = null;
  private running: Promise<FileVersion> | null = null;

  /** `onChange` sees each new version before it is used (it may throw to refuse a broken file). */
  constructor(readonly file: CloudFile, private maxAgeMs: number, private onChange?: (v: FileVersion) => Promise<void> | void) {}

  /** The latest version; downloads only if the version tag changed. `force`: ask now. Rejects while OpenCloud fails. */
  get(force = false): Promise<FileVersion> {
    if (!force && Date.now() - this.checked < this.maxAgeMs) {
      if (this.error) return Promise.reject(this.error);
      if (this.current) return Promise.resolve(this.current);
    }
    this.running ??= this.refresh().finally(() => { this.running = null; });
    return this.running;
  }

  /** The last version that could be read, even while OpenCloud fails (null before the first). */
  get last(): FileVersion | null { return this.current; }

  private async refresh(): Promise<FileVersion> {
    try {
      const { etag } = await this.file.stat();
      if (!this.current || !sameTag(this.current.etag, etag)) {
        const next = await this.file.get();
        await this.onChange?.(next);
        this.current = next;
      }
      this.error = null;
      return this.current;
    } catch (e) {
      this.error = e;
      throw e;
    } finally {
      this.checked = Date.now();
    }
  }
}
