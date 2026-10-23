import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { LocalStore, parseMultistatus, StoreError, WebDavStore, type SermonStore } from '../server/sermon-store';
import { createApi } from '../server/api';
import { hashPassword } from '../server/auth';

// as OpenCloud 8.1 answers a PROPFIND on a folder shared with the user (a missing property in a 404 propstat)
const OPENCLOUD_PROPFIND = '<d:multistatus xmlns:s="http://sabredav.org/ns" xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:response><d:href>/dav/spaces/a0ca$a0ca%21cf73:6ce5:8ca3/</d:href><d:propstat><d:prop><d:getlastmodified>Fri, 23 Oct 2026 10:58:58 GMT</d:getlastmodified>' +
  '<d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength></d:getcontentlength>' +
  '</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>' +
  '<d:response><d:href>/dav/spaces/a0ca$a0ca%21cf73:6ce5:8ca3/predigt-eag-261018.mp3</d:href><d:propstat><d:prop><d:getcontentlength>13</d:getcontentlength>' +
  '<d:getlastmodified>Fri, 23 Oct 2026 10:58:58 GMT</d:getlastmodified><d:resourcetype></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

describe('parseMultistatus', () => {
  it('lists the files of an OpenCloud folder, without the folder itself', () => {
    expect(parseMultistatus(OPENCLOUD_PROPFIND)).toEqual([{ name: 'predigt-eag-261018.mp3', size: 13, modified: '2026-10-23T10:58:58.000Z' }]);
  });

  it('copes with other namespace prefixes and escaped names', () => {
    const xml = '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/f/a%20b.mp3</D:href><D:propstat><D:prop><D:getcontentlength>5</D:getcontentlength>' +
      '<D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
    expect(parseMultistatus(xml)).toEqual([{ name: 'a b.mp3', size: 5, modified: '' }]);
  });
});

/** A WebDAV folder like OpenCloud's: Basic auth with the app token, PUT overwrites (If-None-Match is ignored). */
function fakeCloud(user: string, token: string) {
  const files = new Map<string, Buffer>();
  const puts: string[] = [];
  const gets: string[] = [];
  /** TUS uploads in progress; `breakPiece`: the next PATCH loses its answer (the piece arrives, the reply does not) */
  const uploads = new Map<string, { name: string; length: number; data: Buffer }>();
  const tus = { patches: 0, breakPiece: false };
  const version = (n: string) => `"${files.get(n)?.length}-${puts.filter(p => p === n).length}"`;
  const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  const body = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== auth) { res.statusCode = 401; res.end(); return; }
    const up = /^\/data\/(\w+)$/.exec(req.url ?? '');
    if (up) { // TUS: HEAD tells the offset, PATCH appends a piece
      const u = uploads.get(up[1]);
      if (!u) { res.statusCode = 404; res.end(); return; }
      if (req.method === 'HEAD') { res.setHeader('Upload-Offset', u.data.length); res.end(); return; }
      const piece = await body(req);
      tus.patches++;
      if (Number(req.headers['upload-offset']) !== u.data.length) { res.statusCode = 409; res.end(); return; }
      u.data = Buffer.concat([u.data, piece]);
      if (u.data.length === u.length) { files.set(u.name, u.data); puts.push(u.name); uploads.delete(up[1]); }
      if (tus.breakPiece) { tus.breakPiece = false; req.socket.destroy(); return; }
      res.statusCode = 204;
      res.setHeader('Upload-Offset', u.data.length);
      res.end();
      return;
    }
    const m = /^\/dav\/spaces\/share\/(.*)$/.exec(req.url ?? '');
    if (!m) { res.statusCode = 404; res.end(); return; }
    const name = decodeURIComponent(m[1]);
    if (req.method === 'POST' && name === '') { // TUS: create an upload in the folder
      const meta = /filename (\S+)/.exec(String(req.headers['upload-metadata']))?.[1] ?? '';
      const id = Math.random().toString(36).slice(2);
      uploads.set(id, { name: Buffer.from(meta, 'base64').toString(), length: Number(req.headers['upload-length']), data: Buffer.alloc(0) });
      res.statusCode = 201;
      res.setHeader('Location', `/data/${id}`);
      res.end();
    } else if (req.method === 'PROPFIND') {
      await body(req);
      res.statusCode = 207;
      res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/spaces/share/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        [...files].map(([n, b]) => `<d:response><d:href>/dav/spaces/share/${encodeURIComponent(n)}</d:href><d:propstat><d:prop><d:getcontentlength>${b.length}</d:getcontentlength>` +
          '<d:getlastmodified>Fri, 23 Oct 2026 10:58:58 GMT</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('') +
        '</d:multistatus>');
    } else if (req.method === 'HEAD' || req.method === 'GET') {
      const f = files.get(name);
      if (req.method === 'GET') gets.push(name);
      res.statusCode = f ? 200 : 404;
      if (f) { res.setHeader('Content-Length', f.length); res.setHeader('ETag', version(name)); }
      res.end(req.method === 'GET' ? f : undefined);
    } else if (req.method === 'PUT') {
      const existed = files.has(name);
      files.set(name, await body(req));
      puts.push(name);
      res.statusCode = existed ? 204 : 201;
      res.end();
    } else { res.statusCode = 405; res.end(); }
  });
  return { server, files, puts, gets, tus };
}

describe('WebDavStore and the API with OpenCloud', () => {
  const cloud = fakeCloud('jo', 'quarterly halogen outnumber');
  let dir: string, folder: string, api: Server, base: string, store: WebDavStore;
  const srcFile = async (text: string) => { const f = join(dir, `${Math.random()}.mp3`); await writeFile(f, text); return f; };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mischer-cloud-'));
    await new Promise<void>(r => cloud.server.listen(0, '127.0.0.1', r));
    folder = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}/dav/spaces/share/`;
    store = new WebDavStore({ url: folder, user: 'jo', token: 'quarterly halogen outnumber' });
    const handle = createApi({
      users: { admin: 'admin-password', mischer: hashPassword('mischer-password') }, dataDir: join(dir, 'data'), staticDir: dir,
      sessionSecret: 'test-secret-test-secret', sessionDays: 30, maxUploadMb: 1, secureCookies: false, cloud: { url: folder, user: 'jo', token: 'quarterly halogen outnumber' },
    }, store);
    api = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(async () => { cloud.server.close(); api.close(); await rm(dir, { recursive: true, force: true }); });

  it('writes, lists, reads and never overwrites unless asked to', async () => {
    const first = await srcFile('ID3 one');
    await store.write('a.mp3', first, false);
    await expect(readFile(first)).rejects.toThrow(); // the temporary file is gone
    expect(cloud.files.get('a.mp3')?.toString()).toBe('ID3 one');
    expect((await store.list()).map(f => [f.name, f.size])).toEqual([['a.mp3', 7]]);
    expect(await store.exists('a.mp3')).toBe(true);
    expect(await store.exists('b.mp3')).toBe(false);

    const second = await srcFile('ID3 two');
    await expect(store.write('a.mp3', second, false)).rejects.toMatchObject({ status: 409 });
    await expect(readFile(second)).rejects.toThrow();
    expect(cloud.files.get('a.mp3')?.toString()).toBe('ID3 one');
    await store.write('a.mp3', await srcFile('ID3 three'), true);
    const r = await store.read('a.mp3');
    expect([r?.size, (await r!.body.toArray()).join('')]).toEqual([9, 'ID3 three']);
    expect(await store.read('missing.mp3')).toBeNull();
  });

  it('sends large files in pieces (TUS) and goes on where the server stands after a lost answer', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const src = join(dir, 'big.mp3');
    await writeFile(src, big);
    const shares: number[] = [];
    cloud.tus.breakPiece = true; // the first piece arrives, its answer is lost
    const before = cloud.tus.patches;
    await store.write('big.mp3', src, false, p => shares.push(p));
    expect(cloud.files.get('big.mp3')?.equals(big)).toBe(true);
    expect(cloud.tus.patches - before).toBe(3); // 4 + 4 + 1 MB, none sent twice
    expect(shares.at(-1)).toBe(1);
    await expect(readFile(src)).rejects.toThrow();
  });

  it('reports a wrong token and an unreachable cloud', async () => {
    const wrong = new WebDavStore({ url: folder, user: 'jo', token: 'expired' });
    await expect(wrong.list()).rejects.toEqual(new StoreError(502, 'cloud 401'));
    const gone = new WebDavStore({ url: 'http://127.0.0.1:9/dav/', user: 'jo', token: 'x' });
    await expect(gone.list()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/^cloud unreachable/) });
  });

  it('publishes uploads to the cloud and keeps the first version on the NAS when replacing', async () => {
    cloud.files.clear();
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin-password' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const send = (method: string, path: string, body: string) =>
      fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body });

    expect(await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).toMatchObject({ target: 'OpenCloud' });
    expect((await send('POST', '/api/upload?name=predigt-eag-261018.mp3', 'ID3 v1')).status).toBe(200);
    expect(cloud.files.get('predigt-eag-261018.mp3')?.toString()).toBe('ID3 v1');
    const puts = cloud.puts.length;
    expect((await send('POST', '/api/upload?name=predigt-eag-261018.mp3', 'ID3 again')).status).toBe(409);
    expect(cloud.puts.length).toBe(puts); // refused before anything was sent to the cloud

    // the admin opens the file (it passes through the server): replacing it then needs no second download
    expect(await (await fetch(`${base}/api/uploads/predigt-eag-261018.mp3`, { headers: { Cookie: cookie } })).text()).toBe('ID3 v1');
    const gets = cloud.gets.length;
    expect((await send('PUT', '/api/uploads/predigt-eag-261018.mp3', 'ID3 v2')).status).toBe(200);
    expect(cloud.gets.length).toBe(gets);
    expect((await send('PUT', '/api/uploads/predigt-eag-261018.mp3', 'ID3 v3')).status).toBe(200);
    expect(cloud.files.get('predigt-eag-261018.mp3')?.toString()).toBe('ID3 v3');
    expect(await readFile(join(dir, 'data/original/predigt-eag-261018.mp3'), 'latin1')).toBe('ID3 v1');
    expect((await send('PUT', '/api/uploads/other.mp3', 'ID3 x')).status).toBe(404);

    const list = await (await fetch(`${base}/api/uploads`, { headers: { Cookie: cookie } })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'predigt-eag-261018.mp3', size: 6, original: true })]);
    expect(await (await fetch(`${base}/api/uploads/predigt-eag-261018.mp3`, { headers: { Cookie: cookie } })).text()).toBe('ID3 v3');
    expect((await readdir(join(dir, 'data/tmp'))).filter(n => n.endsWith('.mp3'))).toEqual([]);
    expect(await readdir(join(dir, 'data/tmp/opened'))).toEqual([]); // the opened copy became the backup
    expect(await readdir(join(dir, 'data'))).not.toContain('predigten'); // nothing published on the NAS
  });

  it('answers 502 with the reason when the cloud refuses', async () => {
    const handle = createApi({
      users: { admin: 'admin-password', mischer: hashPassword('mischer-password') }, dataDir: join(dir, 'data2'), staticDir: dir,
      sessionSecret: 'test-secret-test-secret', sessionDays: 30, maxUploadMb: 1, secureCookies: false, cloud: null,
    }, new WebDavStore({ url: folder, user: 'jo', token: 'expired' }));
    const srv = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'mischer', password: 'mischer-password' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await fetch(`${b}/api/upload?name=x.mp3`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body: 'ID3 x' });
    expect([res.status, await res.text()]).toEqual([502, 'cloud 401']);
    // refused before the upload arrived (Node discards the rest): the answer still comes through, the connection stays usable
    const big = new Uint8Array(900 * 1024).fill(0x41);
    big.set([0x49, 0x44, 0x33]);
    for (let i = 0; i < 2; i++) {
      const again = await fetch(`${b}/api/upload?name=x.mp3`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body: big });
      expect([again.status, await again.text()]).toEqual([502, 'cloud 401']);
    }
    srv.close();
  });
});

describe('slow uploads: answered at once, finished in the background', () => {
  it('answers 202 with a job when OpenCloud takes long, and the job tells how it ended', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mischer-slow-'));
    const local = new LocalStore(join(dir, 'predigten'));
    let fail: StoreError | null = null;
    // like OpenCloud over a slow line: writing takes longer than the request may wait
    const slow: SermonStore = {
      label: 'OpenCloud', list: () => local.list(), exists: n => local.exists(n), read: n => local.read(n), version: n => local.version(n),
      write: async (name, src, replace) => {
        await new Promise(r => setTimeout(r, 300));
        if (fail) { await rm(src, { force: true }); throw fail; }
        return local.write(name, src, replace);
      },
    };
    const handle = createApi({
      users: { admin: 'admin-password', mischer: hashPassword('mischer-password') }, dataDir: join(dir, 'data'), staticDir: dir,
      sessionSecret: 'test-secret-test-secret', sessionDays: 30, maxUploadMb: 1, secureCookies: false, cloud: null,
    }, slow, { syncWaitMs: 50 });
    const srv = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin-password' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const send = (method: string, path: string) => fetch(`${b}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body: 'ID3 x' });
    const until = async (id: string) => {
      for (;;) {
        const job = await (await fetch(`${b}/api/jobs/${id}`, { headers: { Cookie: cookie } })).json();
        if (job.state !== 'running') return job;
        await new Promise(r => setTimeout(r, 50));
      }
    };

    const first = await send('POST', '/api/upload?name=a.mp3');
    expect(first.status).toBe(202);
    const { job } = await first.json();
    expect(await until(job)).toMatchObject({ state: 'done', file: 'a.mp3', status: null, error: null });
    expect(await local.exists('a.mp3')).toBe(true);

    fail = new StoreError(502, 'cloud 423');
    const replaced = await send('PUT', '/api/uploads/a.mp3');
    expect(replaced.status).toBe(202);
    expect(await until((await replaced.json()).job)).toMatchObject({ state: 'failed', file: 'a.mp3', status: 502, error: 'cloud 423' });
    expect((await fetch(`${b}/api/jobs/0123456789abcdef`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${b}/api/jobs/${job}`)).status).toBe(401);
    expect(await readdir(join(dir, 'data/tmp'))).toEqual([]);
    srv.close();
    await rm(dir, { recursive: true, force: true });
  });
});
