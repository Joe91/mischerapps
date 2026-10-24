import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api';
import { createStatic } from '../server/static';
import { hashPassword, LoginLimiter, signSession, verifyPassword, verifySession } from '../server/auth';
import { parseConfig, ConfigError, type ServerConfig } from '../server/config';
import { isoDate } from '../packages/plan/cells';
import { readPlanXlsx } from '../packages/plan/plan';
import { tagMp3 } from '../packages/audio-core/tags';
import writeExcelFile from 'write-excel-file/universal';

let server: Server, base: string, dir: string;
const cfg = (): ServerConfig => ({
  users: { admin: 'admin-password', mischer: hashPassword('mischer-password') },
  dataDir: join(dir, 'data'), staticDir: join(dir, 'dist'), sessionSecret: 'test-secret-test-secret', sessionDays: 30, maxUploadMb: 1, secureCookies: false, cloud: null,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mischer-test-'));
  await mkdir(join(dir, 'dist/apps/termine'), { recursive: true });
  await mkdir(join(dir, 'dist/assets'), { recursive: true });
  await writeFile(join(dir, 'dist/index.html'), '<h1>home</h1>');
  await writeFile(join(dir, 'dist/apps/termine/index.html'), '<h1>termine</h1>');
  await writeFile(join(dir, 'dist/assets/app.js'), 'x'.repeat(5000));
  const c = cfg(), api = createApi(c), serve = createStatic(c.staticDir);
  server = createServer(async (req, res) => {
    if (await api(req, res)) return;
    if (await serve(req, res)) return;
    res.statusCode = 404; res.end('not found');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

async function login(user: string, password: string) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password }) });
  return { res, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}
const as = (cookie: string) => ({ headers: { Cookie: cookie } });
const json = (cookie: string, method: string, body: unknown) =>
  ({ method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const mp3 = (cookie: string, name: string, body: BodyInit = 'ID3\x03\x00\x00\x00\x00\x00\x00fake', type = 'audio/mpeg') =>
  fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type }, body, duplex: 'half' } as RequestInit);

describe('login', () => {
  it('needs a session for everything but login', async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/termine`)).status).toBe(401);
    expect((await mp3('', 'a.mp3')).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('logs in with plain and hashed passwords and sets a hardened cookie', async () => {
    const a = await login('Admin', 'admin-password');
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect(await (await fetch(`${base}/api/me`, as(a.cookie))).json()).toEqual({ user: 'admin', role: 'admin', target: 'NAS' });
    const m = await login('mischer', 'mischer-password');
    expect(await (await fetch(`${base}/api/me`, as(m.cookie))).json()).toEqual({ user: 'mischer', role: 'mischer', target: 'NAS' });
  });

  it('rejects wrong passwords and unknown users', async () => {
    expect((await login('admin', 'nope')).res.status).toBe(401);
    expect((await login('root', 'admin-password')).res.status).toBe(401);
    expect((await login('admin', 'admin-password')).res.status).toBe(200); // success resets the counter
  });

  it('blocks an address after repeated wrong passwords, but not other addresses', async () => {
    const attempt = (ip: string, password: string) => fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.1.1.1, ${ip}` }, body: JSON.stringify({ user: 'admin', password }),
    });
    expect((await Promise.all(Array.from({ length: 8 }, () => attempt('9.9.9.9', 'wrong')))).every(r => r.status === 401)).toBe(true);
    const blocked = await attempt('9.9.9.9', 'admin-password'); // even the right password is refused now
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await attempt('8.8.8.8', 'admin-password')).status).toBe(200);
  });

  it('ignores forged and tampered cookies', async () => {
    const { cookie } = await login('mischer', 'mischer-password');
    const forged = cookie.replace('mischer', 'admin');
    expect((await fetch(`${base}/api/me`, as(forged))).status).toBe(401);
    expect((await fetch(`${base}/api/me`, as('mischer_session=admin.99999999999999.abc'))).status).toBe(401);
  });
});

describe('termine (answers in the Einsatzplan)', () => {
  // the dates and answers live in the Einsatzplan: one for this block (removed afterwards, the plan tests start without one)
  const planFile = () => join(dir, 'data/einsatzplan.xlsx');
  const answer = (cookie: string, date: string, sign: string, a: string | null) => fetch(`${base}/api/termine`, json(cookie, 'POST', { date, sign, answer: a }));
  const votes = async (date: string) => (await readPlanXlsx(new Blob([new Uint8Array(await readFile(planFile()))]))).entries.find(e => e.date === date)?.votes;
  beforeAll(async () => {
    const header = ['Datum', 'Mischer', 'Mischer möglich', 'nicht möglich', 'Beamer', 'Beamer möglich', 'nicht möglich'];
    const rows = ['2030-01-06', '2030-02-03', '2030-03-03'].map(d => [d, 'JD', 'KL', null, 'MS', 'MS', 'RR']);
    await writeFile(planFile(), Buffer.from(await (await writeExcelFile([header, ...rows] as never).toBlob()).arrayBuffer()));
  });
  afterAll(async () => { await rm(planFile(), { force: true }); });

  it('lets everybody answer; the answers go into "Mischer möglich" / "nicht möglich" and come back with the plan', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await answer(m, '2030-01-06', 'jd', 'yes')).status).toBe(204);
    expect((await answer(a, '2030-01-06', 'MK', 'maybe')).status).toBe(204);
    expect((await answer(m, '2030-01-06', 'AS', 'no')).status).toBe(204);
    expect(await votes('2030-01-06')).toEqual({ KL: 'yes', JD: 'yes', MK: 'maybe', AS: 'no' });
    const plan = await (await fetch(`${base}/api/plan`, as(m))).json();
    expect(plan.entries.find((e: { date: string }) => e.date === '2030-01-06').votes).toEqual({ KL: 'yes', JD: 'yes', MK: 'maybe', AS: 'no' });
    expect((await (await fetch(`${base}/api/plan`)).json()).entries.every((e: { votes: object }) => !Object.keys(e.votes).length)).toBe(true); // not for visitors
    expect((await answer(m, '2030-01-06', 'JD', null)).status).toBe(204); // withdrawn
    expect((await votes('2030-01-06'))?.JD).toBeUndefined();
  });

  it('keeps simultaneous answers', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    const signs = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH'];
    const res = await Promise.all(signs.map(sign => answer(m, '2030-02-03', sign, 'yes')));
    expect(res.every(r => r.status === 204)).toBe(true);
    expect(Object.keys((await votes('2030-02-03'))!).sort()).toEqual([...signs, 'KL'].sort());
  });

  it('only takes answers for dates of the plan, and rejects invalid input', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    const refused = await answer(m, '2030-06-02', 'JD', 'yes');
    expect([refused.status, await refused.text()]).toEqual([400, 'unknown date']);
    expect((await answer(m, '2030-13-01', 'JD', 'yes')).status).toBe(400);
    expect((await answer(m, '2030-03-03', '', 'yes')).status).toBe(400);
    expect((await answer(m, '2030-03-03', 'JD', 'sure')).status).toBe(400);
    expect((await fetch(`${base}/api/termine`, { method: 'POST', headers: { Cookie: m }, body: '{}' })).status).toBe(415);
    expect((await answer('', '2030-03-03', 'JD', 'yes')).status).toBe(401);
    for (const gone of ['/api/termine', '/api/termine/export', '/api/termine/template']) {
      expect((await fetch(`${base}${gone}`, as(m))).status).toBe(404); // no spreadsheet of its own any more
    }
  });
});

describe('einsatzplan', () => {
  const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
  const sheet = async () => Buffer.from(await (await writeExcelFile([
    ['Datum', 'Musikteam', 'Teamleitung', 'Mischer', 'Name', 'Beamer', 'Bemerkungen'],
    [inDays(-7), 'A-Team', 'Anna', 'KL', null, 'MS', null],
    [inDays(0), 'H-Team', 'Berta', 'AS', null, 'RR', 'Mikro 3 defekt'],
    [inDays(5), 'kein eAg', null, null, null, null, null],
    [inDays(7), 'J-Team', 'Carla', 'KL', null, 'MS', null],
    [inDays(14), 'N-Team', 'Dora', 'AS', null, 'RR', null],
    [inDays(21), 'A-Team', 'Anna', 'KL', null, 'MS', null],
    [null, null, null, 'KL', 'Karl Lang', null, null],
  ] as never).toBlob()).arrayBuffer());
  const plan = async (cookie = '') => (await fetch(`${base}/api/plan`, cookie ? as(cookie) : {})).json();

  it('is empty until the admin imports a spreadsheet (only the admin may)', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect(await plan()).toEqual({ entries: [], names: {}, updated: null, public: true, source: 'NAS', syncError: null });
    expect((await fetch(`${base}/api/plan/import`, { method: 'POST', body: await sheet() })).status).toBe(401);
    expect((await fetch(`${base}/api/plan/import`, { method: 'POST', headers: { Cookie: m }, body: await sheet() })).status).toBe(403);
    expect((await fetch(`${base}/api/plan/import`, { method: 'POST', headers: { Cookie: a }, body: 'garbage' })).status).toBe(400);
    const upload = await sheet();
    const ok = await fetch(`${base}/api/plan/import`, { method: 'POST', headers: { Cookie: a }, body: upload });
    expect(await ok.json()).toEqual({ dates: 5, hidden: 1 });
    expect((await readFile(join(dir, 'data/einsatzplan.xlsx'))).equals(upload)).toBe(true); // stored as uploaded
  });

  it('shows visitors the next three dates without names and remarks, logged-in users everything', async () => {
    const visitor = await plan();
    expect(visitor.public).toBe(true);
    expect(visitor.names).toEqual({});
    expect(visitor.entries.map((e: { date: string }) => e.date)).toEqual([inDays(0), inDays(7), inDays(14)]);
    expect(visitor.entries[0]).toMatchObject({ mischer: 'AS', note: '' });

    const m = (await login('mischer', 'mischer-password')).cookie;
    const member = await plan(m);
    expect(member.public).toBe(false);
    expect(member.names).toEqual({ KL: 'Karl Lang' });
    expect(member.entries.map((e: { date: string }) => e.date)).toEqual([inDays(-7), inDays(0), inDays(7), inDays(14), inDays(21)]);
    expect(member.entries[1].note).toBe('Mikro 3 defekt');
    expect(Date.parse(member.updated)).toBeGreaterThan(0);
  });

  it('keeps the old plan if an upload cannot be read', async () => {
    const a = (await login('admin', 'admin-password')).cookie;
    const wrong = Buffer.from(await (await writeExcelFile([['Datum', 'Anlass'], [inDays(1), 'x']] as never).toBlob()).arrayBuffer());
    expect((await fetch(`${base}/api/plan/import`, { method: 'POST', headers: { Cookie: a }, body: wrong })).status).toBe(400);
    expect((await plan(a)).entries).toHaveLength(5);
  });
});

describe('shared settings', () => {
  it('are readable by everybody, writable by the admin, and filtered', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect(await (await fetch(`${base}/api/settings/predigt`, as(m))).json()).toEqual({});
    expect((await fetch(`${base}/api/settings/predigt`, json(m, 'PUT', { fadeIn: 2 }))).status).toBe(403);
    const put = await fetch(`${base}/api/settings/predigt`, json(a, 'PUT', { fadeIn: 2, namePattern: 'p_{datum}', profiles: [{ token: 'secret' }], highpass: 'yes' }));
    expect(await put.json()).toEqual({ fadeIn: 2, namePattern: 'p_{datum}' }); // unknown keys and wrong types dropped
    expect(await (await fetch(`${base}/api/settings/predigt`, as(m))).json()).toEqual({ fadeIn: 2, namePattern: 'p_{datum}' });
    expect((await fetch(`${base}/api/settings/unknown`, json(a, 'PUT', {}))).status).toBe(404);
    expect((await fetch(`${base}/api/settings/constructor`, as(m))).status).toBe(404); // no Object.prototype members
    expect((await fetch(`${base}/api/settings/constructor`, json(a, 'PUT', {}))).status).toBe(404);
  });

  it('never overwrites a damaged settings.json', async () => {
    const a = (await login('admin', 'admin-password')).cookie;
    const file = join(dir, 'data/settings.json');
    const before = await readFile(file, 'utf8');
    await writeFile(file, '{ "predigt": { "fadeIn": 2, } }'); // trailing comma, edited by hand
    expect((await fetch(`${base}/api/settings/predigt`, as(a))).status).toBe(500);
    expect((await fetch(`${base}/api/settings/predigt`, json(a, 'PUT', { fadeIn: 3 }))).status).toBe(500);
    expect(await readFile(file, 'utf8')).toBe('{ "predigt": { "fadeIn": 2, } }');
    await writeFile(file, before);
  });
});

describe('upload', () => {
  it('stores MP3 files without ever overwriting', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    expect((await mp3(m, 'predigt_2030-01-06.mp3')).status).toBe(200);
    expect((await readFile(join(dir, 'data/predigten/predigt_2030-01-06.mp3'), 'latin1'))).toBe('ID3\x03\x00\x00\x00\x00\x00\x00fake');
    expect((await mp3(m, 'predigt_2030-01-06.mp3')).status).toBe(409);
    expect((await mp3(m, '../evil.mp3')).status).toBe(400); // no paths
    expect((await mp3(m, 'bad name.mp3')).status).toBe(400);
    expect((await mp3(m, 'x.txt')).status).toBe(400);
    expect((await mp3(m, 'notmp3.mp3', 'hello world')).status).toBe(415);
    expect((await mp3(m, 'form.mp3', 'ID3…', 'multipart/form-data; boundary=x')).status).toBe(415); // only the bare file
    expect((await mp3(m, 'big.mp3', 'ID3' + 'x'.repeat(2 * 1024 * 1024))).status).toBe(413);
    await expect(readFile(join(dir, 'data/predigten/notmp3.mp3'))).rejects.toThrow();
  });

  it('stops a too large upload without a declared size and leaves no partial file', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    const chunk = new Uint8Array(256 * 1024).fill(0x41);
    chunk.set([0x49, 0x44, 0x33]);
    let sent = 0;
    const body = new ReadableStream({ pull(c) { if (sent++ < 8) c.enqueue(chunk); else c.close(); } }); // 2 MB, streamed
    expect((await mp3(m, 'stream.mp3', body)).status).toBe(413);
    await expect(readFile(join(dir, 'data/predigten/stream.mp3'))).rejects.toThrow();
    // a streamed file below the limit arrives complete
    sent = 6;
    expect((await mp3(m, 'stream.mp3', new ReadableStream({ pull(c) { if (sent++ < 8) c.enqueue(chunk); else c.close(); } }))).status).toBe(200);
    expect((await readFile(join(dir, 'data/predigten/stream.mp3'))).length).toBe(2 * chunk.length);
  });

  it('tells everybody whether a name is published already', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    expect(await (await fetch(`${base}/api/published?name=predigt_2030-01-06.mp3`, as(m))).json()).toEqual({ exists: true });
    expect(await (await fetch(`${base}/api/published?name=predigt_2099-01-06.mp3`, as(m))).json()).toEqual({ exists: false });
    expect((await fetch(`${base}/api/published?name=../x.mp3`, as(m))).status).toBe(400);
    expect((await fetch(`${base}/api/published?name=x.mp3`)).status).toBe(401);
  });

  it('lists uploads for the admin', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await fetch(`${base}/api/uploads`, as(m))).status).toBe(403);
    const list = await (await fetch(`${base}/api/uploads`, as(a))).json();
    expect(list.map((f: { name: string }) => f.name)).toContain('predigt_2030-01-06.mp3');
  });

  it('tells which files carry the app\'s mark, also for the first version kept on the NAS', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
    const marked = (note: string) => new Blob([tagMp3(frame, { title: 'x', processed: note }) as Uint8Array<ArrayBuffer>]);
    const entry = async (name: string) => (await (await fetch(`${base}/api/uploads`, as(a))).json() as
      { name: string; processed: string | null; originalProcessed?: string | null }[]).find(f => f.name === name);
    expect((await mp3(m, 'marked.mp3', marked('bearbeitet 24.10.2026'))).status).toBe(200);
    expect((await mp3(m, 'raw.mp3', new Blob([tagMp3(frame, { title: 'x' }) as Uint8Array<ArrayBuffer>]))).status).toBe(200);
    expect(await entry('marked.mp3')).toMatchObject({ processed: 'bearbeitet 24.10.2026' });
    expect(await entry('raw.mp3')).toMatchObject({ processed: null });
    // replaced by a processed version: the first version (where reprocessing starts) has no mark
    const put = await fetch(`${base}/api/uploads/raw.mp3`, { method: 'PUT', headers: { Cookie: a, 'Content-Type': 'audio/mpeg' }, body: marked('bearbeitet 25.10.2026') });
    expect(put.status).toBe(200);
    expect(await entry('raw.mp3')).toMatchObject({ processed: 'bearbeitet 25.10.2026', originalProcessed: null });
    // remembered for the next list, per version
    const known = Object.keys(JSON.parse(await readFile(join(dir, 'data/marks.json'), 'utf8')));
    expect(known.some(k => k.startsWith('marked.mp3|')) && known.some(k => k.startsWith('original/raw.mp3|'))).toBe(true);
  });

  it('lets the admin download and replace a published file, keeping the first version', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    const url = `${base}/api/uploads/replace-me.mp3`;
    const put = (cookie: string, body: BodyInit, target = url, type = 'audio/mpeg') =>
      fetch(target, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': type }, body });
    const listed = async () => (await (await fetch(`${base}/api/uploads`, as(a))).json() as { name: string; original: boolean }[])
      .find(f => f.name === 'replace-me.mp3');

    expect((await put(a, 'ID3 v1')).status).toBe(404); // only published files
    expect((await mp3(m, 'replace-me.mp3', 'ID3 v1')).status).toBe(200);
    expect((await fetch(url, as(m))).status).toBe(403);
    expect((await put(m, 'ID3 v2')).status).toBe(403);
    const got = await fetch(url, as(a));
    expect([got.status, got.headers.get('content-type'), await got.text()]).toEqual([200, 'audio/mpeg', 'ID3 v1']);
    expect((await fetch(`${url}?original=1`, as(a))).status).toBe(404);
    expect((await listed())?.original).toBe(false);

    expect((await put(a, 'ID3 v2')).status).toBe(200);
    expect((await put(a, 'ID3 v3')).status).toBe(200);
    expect(await (await fetch(url, as(a))).text()).toBe('ID3 v3');
    const first = await fetch(`${url}?original=1`, as(a));
    expect(await first.text()).toBe('ID3 v1'); // the first version stays
    expect(first.headers.get('content-disposition')).toBe('attachment; filename="replace-me-original.mp3"');
    expect((await listed())?.original).toBe(true);

    expect((await put(a, 'not an mp3')).status).toBe(415);
    expect((await put(a, 'ID3' + 'x'.repeat(2 * 1024 * 1024))).status).toBe(413);
    expect(await (await fetch(url, as(a))).text()).toBe('ID3 v3'); // a failed replacement changes nothing
    expect((await fetch(`${base}/api/uploads/..%2Fsettings.json`, as(a))).status).toBe(400);
    expect((await fetch(`${base}/api/uploads/%E0%A4%A.mp3`, as(a))).status).toBe(400);
    expect((await fetch(`${base}/api/uploads/missing.mp3`, as(a))).status).toBe(404);
    expect((await readdir(join(dir, 'data/tmp'))).filter(n => n.endsWith('.mp3'))).toEqual([]); // no temporary files left
    expect(await readFile(join(dir, 'data/original/replace-me.mp3'), 'latin1')).toBe('ID3 v1');
  });
});

describe('static files', () => {
  it('serves pages, redirects folders without slash, compresses and caches', async () => {
    expect(await (await fetch(`${base}/`)).text()).toBe('<h1>home</h1>');
    const redirect = await fetch(`${base}/apps/termine`, { redirect: 'manual' });
    expect([redirect.status, redirect.headers.get('location')]).toEqual([301, '/apps/termine/']);
    for (const evil of ['/%2Fevil.com%2F..%2Fapps', '//evil.com/../apps', '/%5Cevil.com/../apps']) { // never a link to another site
      const r = await fetch(`${base}${evil}`, { redirect: 'manual' });
      if (r.status === 301) expect(r.headers.get('location')).toBe('/apps/');
    }
    expect(await (await fetch(`${base}/apps/termine/`)).text()).toBe('<h1>termine</h1>');
    const asset = await fetch(`${base}/assets/app.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-encoding')).toBe('gzip');
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
  });

  it('does not leave the web root', async () => {
    const res = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('root:');
  });
});

describe('auth helpers and config', () => {
  it('verifies plain and scrypt passwords', () => {
    expect(verifyPassword('geheim-123', 'geheim-123')).toBe(true);
    expect(verifyPassword('geheim-123', 'geheim-124')).toBe(false);
    const hash = hashPassword('geheim-123');
    expect(hash).toMatch(/^scrypt\$/);
    expect(verifyPassword(hash, 'geheim-123')).toBe(true);
    expect(verifyPassword(hash, 'falsch')).toBe(false);
  });

  it('invalidates sessions when the password changes or the session expired', () => {
    const users = { admin: 'a-password', mischer: 'm-password' };
    const token = signSession('s'.repeat(20), 'admin', users.admin, Date.now() + 1000);
    expect(verifySession('s'.repeat(20), users, token)).toBe('admin');
    expect(verifySession('s'.repeat(20), { ...users, admin: 'changed-pw' }, token)).toBeNull();
    expect(verifySession('s'.repeat(20), users, token, Date.now() + 5000)).toBeNull();
    expect(verifySession('x'.repeat(20), users, token)).toBeNull();
  });

  it('blocks an address after too many failures', () => {
    const l = new LoginLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.fail('ip', 0);
    expect(l.blockedFor('ip', 500)).toBeGreaterThan(0);
    expect(l.blockedFor('other', 500)).toBe(0);
    expect(l.blockedFor('ip', 1500)).toBe(0);
  });

  it('refuses placeholder and weak passwords', () => {
    const ok = { users: { admin: { password: 'long-enough-1' }, mischer: { password: 'long-enough-2' } } };
    expect(parseConfig(ok, {}).users.admin).toBe('long-enough-1');
    expect(() => parseConfig({ users: { admin: { password: 'CHANGE-ME' }, mischer: { password: 'long-enough-2' } } }, {})).toThrow(ConfigError);
    expect(() => parseConfig({ users: { admin: { password: 'short' }, mischer: { password: 'long-enough-2' } } }, {})).toThrow(/zu kurz/);
    expect(() => parseConfig({ users: { admin: { password: 'same-password' }, mischer: { password: 'same-password' } } }, {})).toThrow(/verschiedene/);
    expect(() => parseConfig({ ...ok, sessionSecret: 'short' }, {})).toThrow(/sessionSecret/);
    expect(() => parseConfig({}, {})).toThrow(ConfigError);
    expect(parseConfig(ok, {}).cloud).toBeNull();
    const cloud = { url: 'https://cloud.example.org/dav/spaces/a$b!c', user: 'jo', token: 'two words ' };
    expect(parseConfig({ ...ok, cloud }, {}).cloud).toEqual({ url: 'https://cloud.example.org/dav/spaces/a$b!c/', user: 'jo', token: 'two words ' });
    const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    expect(() => parseConfig({ ...ok, cloud: example.cloud }, {})).toThrow(/cloud.url ist noch der Platzhalter/);
    expect(() => parseConfig({ ...ok, cloud: { ...cloud, token: '' } }, {})).toThrow(/cloud.token fehlt/);
    expect(() => parseConfig({ ...ok, cloud: { ...cloud, url: 'ftp://x/' } }, {})).toThrow(/https/);
    const files = { plan: 'https://cloud.example.org/dav/spaces/a$b/Musik/Plan.xlsx', overview: 'https://cloud.example.org/dav/spaces/a$b/Allgemein/eAg_Übersicht.xlsx' };
    expect(parseConfig({ ...ok, cloud: { ...cloud, ...files } }, {}).cloud).toMatchObject({
      plan: files.plan, overview: 'https://cloud.example.org/dav/spaces/a$b/Allgemein/eAg_%C3%9Cbersicht.xlsx',
    });
    expect(() => parseConfig({ ...ok, cloud: { ...cloud, plan: example.cloud.plan } }, {})).toThrow(/cloud.plan ist noch der Platzhalter/);
  });
});
