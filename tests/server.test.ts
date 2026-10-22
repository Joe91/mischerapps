import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api';
import { createStatic } from '../server/static';
import { hashPassword, LoginLimiter, signSession, verifyPassword, verifySession } from '../server/auth';
import { parseConfig, ConfigError, type ServerConfig } from '../server/config';
import { readTermineXlsx, writeTermineXlsx } from '../apps/termine/src/xlsx';
import { isoDate } from '../apps/termine/src/model';
import writeExcelFile from 'write-excel-file/universal';

let server: Server, base: string, dir: string;
const cfg = (): ServerConfig => ({
  users: { admin: 'admin-password', mischer: hashPassword('mischer-password') },
  dataDir: join(dir, 'data'), staticDir: join(dir, 'dist'), sessionSecret: 'test-secret-test-secret', sessionDays: 30, maxUploadMb: 1, secureCookies: false,
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
    expect(await (await fetch(`${base}/api/me`, as(a.cookie))).json()).toEqual({ user: 'admin', role: 'admin' });
    const m = await login('mischer', 'mischer-password');
    expect(await (await fetch(`${base}/api/me`, as(m.cookie))).json()).toEqual({ user: 'mischer', role: 'mischer' });
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

describe('termine', () => {
  const add = (cookie: string, date: string) => fetch(`${base}/api/termine`, json(cookie, 'POST', { action: 'add', date }));

  it('lets everybody answer, shows the same data to all, and keeps it in a spreadsheet', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    await add(a, '2030-01-06');
    expect((await fetch(`${base}/api/termine`, json(m, 'POST', { action: 'vote', date: '2030-01-06', sign: 'jd', answer: 'yes' }))).status).toBe(200);
    await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'vote', date: '2030-01-06', sign: 'MK', answer: 'maybe' }));
    const seen = await (await fetch(`${base}/api/termine`, as(m))).json();
    expect(seen.dates['2030-01-06'].votes).toEqual({ JD: 'yes', MK: 'maybe' });
    expect((await readFile(join(dir, 'data/termine.xlsx'))).subarray(0, 2).toString()).toBe('PK'); // a real xlsx (zip)
  });

  it('keeps simultaneous answers', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    await add((await login('admin', 'admin-password')).cookie, '2030-02-03');
    const signs = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH'];
    const res = await Promise.all(signs.map(sign => fetch(`${base}/api/termine`, json(m, 'POST', { action: 'vote', date: '2030-02-03', sign, answer: 'yes' }))));
    expect(res.every(r => r.status === 200)).toBe(true);
    const { dates } = await (await fetch(`${base}/api/termine`, as(m))).json();
    expect(Object.keys(dates['2030-02-03'].votes).sort()).toEqual(signs);
  });

  it('only lets the admin edit dates', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    const edit = { action: 'update', date: '2030-03-03', title: 'Abendmahl', time: '10:00', assigned: 'JD', note: '' };
    expect((await fetch(`${base}/api/termine`, json(m, 'POST', edit))).status).toBe(403);
    expect((await fetch(`${base}/api/termine`, json(a, 'POST', edit))).status).toBe(200);
    expect((await (await fetch(`${base}/api/termine`, as(m))).json()).dates['2030-03-03'].title).toBe('Abendmahl');
  });

  it('lets the admin delete a date, but not the mischer', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    await add(a, '2030-04-07');
    await fetch(`${base}/api/termine`, json(m, 'POST', { action: 'vote', date: '2030-04-07', sign: 'JD', answer: 'yes' }));
    expect((await fetch(`${base}/api/termine`, json(m, 'POST', { action: 'delete', date: '2030-04-07' }))).status).toBe(403);
    expect((await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'delete', date: '2030-04-07' }))).status).toBe(200);
    expect((await (await fetch(`${base}/api/termine`, as(m))).json()).dates['2030-04-07']).toBeUndefined();
  });

  it('only lets the admin choose the dates, and only dates on the list can be answered', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await add(m, '2030-05-05')).status).toBe(403);
    const vote = { action: 'vote', date: '2030-05-05', sign: 'JD', answer: 'yes' };
    const refused = await fetch(`${base}/api/termine`, json(m, 'POST', vote));
    expect([refused.status, await refused.text()]).toEqual([400, 'unknown date']);
    expect((await add(a, '2030-05-05')).status).toBe(200);
    expect((await (await fetch(`${base}/api/termine`, as(m))).json()).dates['2030-05-05']).toMatchObject({ votes: {} }); // listed without any answers
    expect((await fetch(`${base}/api/termine`, json(m, 'POST', vote))).status).toBe(200);
  });

  it('rejects invalid input', async () => {
    const a = (await login('admin', 'admin-password')).cookie;
    await add(a, '2030-03-03');
    expect((await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'vote', date: '2030-13-01', sign: 'JD', answer: 'yes' }))).status).toBe(400);
    expect((await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'vote', date: '2030-03-03', sign: '', answer: 'yes' }))).status).toBe(400);
    expect((await fetch(`${base}/api/termine`, { method: 'POST', headers: { Cookie: a }, body: '{}' })).status).toBe(415);
  });

  it('exports and imports the spreadsheet (admin only) and keeps a backup', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await fetch(`${base}/api/termine/export`, as(m))).status).toBe(403);
    const exported = await fetch(`${base}/api/termine/export`, as(a));
    expect(exported.headers.get('content-disposition')).toContain('termine.xlsx');
    expect((await exported.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const sheet = Buffer.from(await (await writeTermineXlsx({ dates: { '2031-05-04': { title: 'Import', time: '', assigned: '', note: '', votes: { XY: 'no' } } } })).arrayBuffer());
    expect((await fetch(`${base}/api/termine/import`, { method: 'POST', headers: { Cookie: m }, body: sheet })).status).toBe(403);
    expect((await fetch(`${base}/api/termine/import`, { method: 'POST', headers: { Cookie: a }, body: 'garbage' })).status).toBe(400);
    const ok = await fetch(`${base}/api/termine/import`, { method: 'POST', headers: { Cookie: a }, body: sheet });
    expect(await ok.json()).toEqual({ dates: 1, skipped: 0 });
    expect(Object.keys((await (await fetch(`${base}/api/termine`, as(a))).json()).dates)).toEqual(['2031-05-04']);
    expect((await readFile(join(dir, 'data/termine.backup.xlsx'))).length).toBeGreaterThan(0);
  });

  it('offers a template with the coming Sundays (admin only) that keeps the existing dates', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await fetch(`${base}/api/termine/template`, as(m))).status).toBe(403);
    const res = await fetch(`${base}/api/termine/template`, as(a));
    expect(res.headers.get('content-disposition')).toContain('termine-vorlage.xlsx');
    const { data } = await readTermineXlsx(new Blob([await res.arrayBuffer()]));
    const dates = Object.keys(data.dates);
    expect(dates.length).toBeGreaterThanOrEqual(52);
    expect(dates).toContain('2031-05-04');                       // existing (imported in the test above)
    expect(data.dates['2031-05-04'].votes).toEqual({ XY: 'no' }); // with its answers
    const sundaysOnly = dates.filter(d => d !== '2031-05-04');
    expect(sundaysOnly.every(d => new Date(`${d}T12:00:00Z`).getUTCDay() === 0)).toBe(true);
  });

  it('never overwrites a spreadsheet it cannot read', async () => {
    const a = (await login('admin', 'admin-password')).cookie;
    await add(a, '2030-01-06');
    const file = join(dir, 'data/termine.xlsx');
    const before = await readFile(file);
    await writeFile(file, 'not a spreadsheet');
    expect((await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'vote', date: '2030-01-06', sign: 'JD', answer: 'yes' }))).status).toBe(500);
    expect((await readFile(file)).toString()).toBe('not a spreadsheet');
    await writeFile(file, before);
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
    expect(await plan()).toEqual({ entries: [], names: {}, updated: null, public: true });
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

  it('lists uploads for the admin', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await fetch(`${base}/api/uploads`, as(m))).status).toBe(403);
    const list = await (await fetch(`${base}/api/uploads`, as(a))).json();
    expect(list.map((f: { name: string }) => f.name)).toContain('predigt_2030-01-06.mp3');
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
  });
});
