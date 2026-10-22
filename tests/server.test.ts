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
import { writeTermineXlsx } from '../apps/termine/src/xlsx';

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
const mp3 = (name: string, bytes = 'ID3\x03\x00\x00\x00\x00\x00\x00fake') => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return form;
};

describe('login', () => {
  it('needs a session for everything but login', async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/termine`)).status).toBe(401);
    expect((await fetch(`${base}/api/upload`, { method: 'POST', body: mp3('a.mp3') })).status).toBe(401);
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

  it('refuses requests from another origin', async () => {
    const { cookie } = await login('admin', 'admin-password');
    const res = await fetch(`${base}/api/termine`, { ...json(cookie, 'POST', { action: 'vote', date: '2030-01-06', sign: 'JD', answer: 'yes' }), headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('termine', () => {
  it('lets everybody answer, shows the same data to all, and keeps it in a spreadsheet', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie, a = (await login('admin', 'admin-password')).cookie;
    expect((await fetch(`${base}/api/termine`, json(m, 'POST', { action: 'vote', date: '2030-01-06', sign: 'jd', answer: 'yes' }))).status).toBe(200);
    await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'vote', date: '2030-01-06', sign: 'MK', answer: 'maybe' }));
    const seen = await (await fetch(`${base}/api/termine`, as(m))).json();
    expect(seen.dates['2030-01-06'].votes).toEqual({ JD: 'yes', MK: 'maybe' });
    expect((await readFile(join(dir, 'data/termine.xlsx'))).subarray(0, 2).toString()).toBe('PK'); // a real xlsx (zip)
  });

  it('keeps simultaneous answers', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
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

  it('rejects invalid input', async () => {
    const a = (await login('admin', 'admin-password')).cookie;
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

  it('never overwrites a spreadsheet it cannot read', async () => {
    const a = (await login('admin', 'admin-password')).cookie;
    const file = join(dir, 'data/termine.xlsx');
    const before = await readFile(file);
    await writeFile(file, 'not a spreadsheet');
    expect((await fetch(`${base}/api/termine`, json(a, 'POST', { action: 'vote', date: '2030-01-06', sign: 'JD', answer: 'yes' }))).status).toBe(500);
    expect((await readFile(file)).toString()).toBe('not a spreadsheet');
    await writeFile(file, before);
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
  });
});

describe('upload', () => {
  it('stores MP3 files without ever overwriting', async () => {
    const m = (await login('mischer', 'mischer-password')).cookie;
    const up = (f: FormData) => fetch(`${base}/api/upload`, { method: 'POST', headers: { Cookie: m }, body: f });
    expect((await up(mp3('predigt_2030-01-06.mp3'))).status).toBe(200);
    expect((await readFile(join(dir, 'data/predigten/predigt_2030-01-06.mp3'))).length).toBeGreaterThan(5);
    expect((await up(mp3('predigt_2030-01-06.mp3'))).status).toBe(409);
    expect((await up(mp3('../evil.mp3'))).status).toBe(200); // path part is stripped…
    expect((await readFile(join(dir, 'data/predigten/evil.mp3'))).length).toBeGreaterThan(0); // …and it stays inside the folder
    expect((await up(mp3('bad name.mp3'))).status).toBe(400);
    expect((await up(mp3('x.txt'))).status).toBe(400);
    expect((await up(mp3('notmp3.mp3', 'hello world'))).status).toBe(415);
    expect((await up(mp3('big.mp3', 'ID3' + 'x'.repeat(2 * 1024 * 1024)))).status).toBe(413);
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
    expect(() => parseConfig({}, {})).toThrow(ConfigError);
  });
});
