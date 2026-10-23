import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseMultistatus, StoreError, WebDavStore } from '../server/sermon-store';
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
  const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  const body = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== auth) { res.statusCode = 401; res.end(); return; }
    const m = /^\/dav\/spaces\/share\/(.*)$/.exec(req.url ?? '');
    if (!m) { res.statusCode = 404; res.end(); return; }
    const name = decodeURIComponent(m[1]);
    if (req.method === 'PROPFIND') {
      await body(req);
      res.statusCode = 207;
      res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/spaces/share/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        [...files].map(([n, b]) => `<d:response><d:href>/dav/spaces/share/${encodeURIComponent(n)}</d:href><d:propstat><d:prop><d:getcontentlength>${b.length}</d:getcontentlength>` +
          '<d:getlastmodified>Fri, 23 Oct 2026 10:58:58 GMT</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('') +
        '</d:multistatus>');
    } else if (req.method === 'HEAD' || req.method === 'GET') {
      const f = files.get(name);
      res.statusCode = f ? 200 : 404;
      if (f) res.setHeader('Content-Length', f.length);
      res.end(req.method === 'GET' ? f : undefined);
    } else if (req.method === 'PUT') {
      const existed = files.has(name);
      files.set(name, await body(req));
      puts.push(name);
      res.statusCode = existed ? 204 : 201;
      res.end();
    } else { res.statusCode = 405; res.end(); }
  });
  return { server, files, puts };
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

    expect((await send('PUT', '/api/uploads/predigt-eag-261018.mp3', 'ID3 v2')).status).toBe(200);
    expect((await send('PUT', '/api/uploads/predigt-eag-261018.mp3', 'ID3 v3')).status).toBe(200);
    expect(cloud.files.get('predigt-eag-261018.mp3')?.toString()).toBe('ID3 v3');
    expect(await readFile(join(dir, 'data/original/predigt-eag-261018.mp3'), 'latin1')).toBe('ID3 v1');
    expect((await send('PUT', '/api/uploads/other.mp3', 'ID3 x')).status).toBe(404);

    const list = await (await fetch(`${base}/api/uploads`, { headers: { Cookie: cookie } })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'predigt-eag-261018.mp3', size: 6, original: true })]);
    expect(await (await fetch(`${base}/api/uploads/predigt-eag-261018.mp3`, { headers: { Cookie: cookie } })).text()).toBe('ID3 v3');
    expect(await readdir(join(dir, 'data/tmp'))).toEqual([]);
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
    const res = await fetch(`${b}/api/upload?name=x.mp3`, { method: 'POST', headers: { Cookie: (login.headers.get('set-cookie') ?? '').split(';')[0], 'Content-Type': 'audio/mpeg' }, body: 'ID3 x' });
    expect([res.status, await res.text()]).toEqual([502, 'cloud 401']);
    srv.close();
  });
});
