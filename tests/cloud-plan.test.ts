import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import writeExcelFile from 'write-excel-file/universal';
import { createApi } from '../server/api';
import { hashPassword } from '../server/auth';
import { LocalStore } from '../server/sermon-store';
import { setMischer } from '../server/plan-store';
import { readPlanXlsx } from '../packages/plan/plan';
import { planSheet } from './plan.test';

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const day = (iso: string) => ({ value: new Date(`${iso}T00:00:00Z`), format: 'dd.mm.yyyy' });

/** Files in OpenCloud as WebDAV serves them: version tags, PUT only with the current one (If-Match), locks. */
function fakeCloud() {
  const files = new Map<string, { data: Uint8Array; version: number }>();
  const state = { down: false, locked: false, puts: 0, beforePut: null as null | ((path: string) => void) };
  const etag = (path: string) => `"v${files.get(path)?.version}"`;
  const body = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return new Uint8Array(Buffer.concat(c)); };
  const server = createServer(async (req, res) => {
    if (state.down) { req.socket.destroy(); return; }
    if (req.headers.authorization !== 'Basic ' + Buffer.from('dejo:token words').toString('base64')) { res.statusCode = 401; res.end(); return; }
    const path = decodeURIComponent(req.url ?? '');
    const file = files.get(path);
    if (req.method === 'PROPFIND') {
      await body(req);
      if (!file) { res.statusCode = 404; res.end(); return; }
      res.statusCode = 207;
      res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:getetag>${etag(path)}</d:getetag>` +
        '<d:getlastmodified>Fri, 23 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
    } else if (req.method === 'GET') {
      if (!file) { res.statusCode = 404; res.end(); return; }
      res.setHeader('ETag', etag(path));
      res.setHeader('Last-Modified', 'Fri, 23 Oct 2026 10:00:00 GMT');
      res.end(file.data);
    } else if (req.method === 'PUT') {
      const data = await body(req);
      state.puts++;
      state.beforePut?.(path); // someone else saves just now
      state.beforePut = null;
      if (state.locked) { res.statusCode = 423; res.end(); return; }
      if (req.headers['if-match'] && req.headers['if-match'] !== etag(path)) { res.statusCode = 412; res.end(); return; }
      files.set(path, { data, version: (file?.version ?? 0) + 1 });
      res.statusCode = file ? 204 : 201;
      res.end();
    } else { res.statusCode = 405; res.end(); }
  });
  return { server, files, state };
}

describe('Einsatzplan and eAg-Übersicht in OpenCloud', () => {
  const cloud = fakeCloud();
  let dir: string, api: Server, base: string, admin: string, mischer: string;
  const PLAN = '/dav/spaces/x/Musik/Musik_Mischer_Beamer.xlsx', OVERVIEW = '/dav/spaces/x/Allgemein/eAg_Übersicht.xlsx';
  const login = async (user: string, password: string) =>
    ((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password }) }))
      .headers.get('set-cookie') ?? '').split(';')[0];
  const getPlan = async () => (await fetch(`${base}/api/plan`, { headers: { Cookie: admin } })).json();
  const assign = (cookie: string, date: string, name: string) =>
    fetch(`${base}/api/plan/mischer`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ date, mischer: name }) });
  const cloudPlan = async () => (await readPlanXlsx(new Blob([cloud.files.get(PLAN)!.data as Uint8Array<ArrayBuffer>]))).entries;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mischer-plan-'));
    await new Promise<void>(r => cloud.server.listen(0, '127.0.0.1', r));
    const host = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
    cloud.files.set(PLAN, { data: await bytes(await planSheet()), version: 1 });
    cloud.files.set(OVERVIEW, { version: 1, data: await bytes(await writeExcelFile([
      ['Datum', null, null, null, null, null, 'Predigtreihe', null, null, null, 'Prediger'],
      [day('2026-11-01'), null, null, null, null, null, 'Zeit', null, null, null, 'Pfr. A'],
      [day('2026-11-15'), null, null, null, null, null, 'Zeit', null, null, null, 'Pfr. B'],
    ] as never).toBlob()) });
    const handle = createApi({
      users: { admin: 'admin-password', mischer: hashPassword('mischer-password') }, dataDir: join(dir, 'data'), staticDir: dir,
      sessionSecret: 'test-secret-test-secret', sessionDays: 30, maxUploadMb: 1, secureCookies: false,
      cloud: { url: `${host}/dav/spaces/x/Predigten/`, user: 'dejo', token: 'token words', plan: host + PLAN, overview: host + encodeURI(OVERVIEW) },
    }, new LocalStore(join(dir, 'predigten')));
    api = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    admin = await login('admin', 'admin-password');
    mischer = await login('mischer', 'mischer-password');
  });
  afterAll(async () => { cloud.server.close(); api.close(); await rm(dir, { recursive: true, force: true }); });

  it('reads the plan from OpenCloud and keeps a copy on the NAS', async () => {
    const plan = await getPlan();
    expect(plan).toMatchObject({ source: 'OpenCloud', syncError: null, updated: '2026-10-23T10:00:00.000Z' });
    expect(plan.entries.map((e: { date: string }) => e.date)).toEqual(['2026-11-01', '2026-11-15', '2026-11-29']);
    expect((await readFile(join(dir, 'data/einsatzplan.xlsx'))).length).toBe(cloud.files.get(PLAN)!.data.length);
    const anonymous = await (await fetch(`${base}/api/plan`)).json();
    expect(anonymous).toMatchObject({ public: true, syncError: null });
    const imported = await fetch(`${base}/api/plan/import`, { method: 'POST', headers: { Cookie: admin }, body: await planSheet() });
    expect(imported.status).toBe(409); // the plan is maintained in OpenCloud
  });

  it('lets the admin assign the Mischer, written into the file in OpenCloud', async () => {
    expect((await assign(mischer, '2026-11-29', 'JD')).status).toBe(403);
    const version = cloud.files.get(PLAN)!.version;
    expect((await assign(admin, '2026-11-29', 'JD')).status).toBe(204);
    expect(cloud.files.get(PLAN)!.version).toBe(version + 1);
    expect((await cloudPlan()).find(e => e.date === '2026-11-29')?.mischer).toBe('JD');
    expect((await getPlan()).entries.find((e: { date: string }) => e.date === '2026-11-29').mischer).toBe('JD'); // at once, not after minutes
    expect((await assign(admin, '2027-01-03', 'JD')).status).toBe(404);
    expect((await assign(admin, 'tomorrow', 'JD')).status).toBe(400);
  });

  it('applies the assignment to the new version when someone saved the file meanwhile, keeping their change', async () => {
    cloud.state.beforePut = path => {
      const f = cloud.files.get(path)!;
      cloud.files.set(path, { data: setMischer(f.data, '2026-11-01', 'KL'), version: f.version + 1 });
    };
    expect((await assign(admin, '2026-11-15', 'AS')).status).toBe(204);
    const entries = await cloudPlan();
    expect(entries.find(e => e.date === '2026-11-01')?.mischer).toBe('KL'); // the other change survived
    expect(entries.find(e => e.date === '2026-11-15')?.mischer).toBe('AS');
  });

  it('reports a locked file and an unreachable cloud, showing the last copy meanwhile', async () => {
    cloud.state.locked = true;
    const locked = await assign(admin, '2026-11-15', 'RR');
    expect([locked.status, await locked.text()]).toEqual([423, 'locked']);
    cloud.state.locked = false;

    cloud.state.down = true;
    await fetch(`${base}/api/plan/refresh`, { method: 'POST', headers: { Cookie: admin } });
    const plan = await getPlan();
    expect(plan.syncError).toMatch(/nicht erreichbar/);
    expect(plan.entries.length).toBe(3);
    cloud.state.down = false;
    expect((await fetch(`${base}/api/plan/refresh`, { method: 'POST', headers: { Cookie: admin } })).status).toBe(204);
    expect((await getPlan()).syncError).toBeNull();
  });

  it('looks up series, its number and the preacher in the eAg-Übersicht', async () => {
    const find = (date: string, cookie = mischer) => fetch(`${base}/api/overview?date=${date}`, { headers: { Cookie: cookie } });
    expect(await (await find('2026-11-15')).json()).toEqual({ date: '2026-11-15', series: 'Zeit', index: 2, preacher: 'Pfr. B' });
    expect((await find('2026-12-24')).status).toBe(404);
    expect((await find('x')).status).toBe(400);
    expect((await find('2026-11-15', '')).status).toBe(401);
  });
});
