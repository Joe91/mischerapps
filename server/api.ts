// The HTTP API under /api: login, Termine, Einsatzplan, shared settings and MP3 upload.
// Used by server/main.ts (production) and dev-server.ts (npm run dev / preview).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { OpError, isoDate, type Op } from '../apps/termine/src/model';
import { publicPlan, type PlanResponse } from '../packages/plan/plan';
import { XLSX_MIME } from '../apps/termine/src/xlsx';
import { LoginLimiter, signSession, verifyPassword, verifySession } from './auth';
import { ROLES, type Role, type ServerConfig } from './config';
import { PlanFormatError, PlanStore } from './plan-store';
import { DamagedSettings, SharedSettings } from './shared-settings';
import { InvalidSpreadsheet, TermineStore } from './termine-store';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const COOKIE = 'mischer_session';
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}\.mp3$/;
/** subfolder of predigten/ with the files as first published, before an admin replaced them */
const ORIGINALS = 'original';

function secretFor(cfg: ServerConfig): string {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  const file = join(cfg.dataDir, '.session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(cfg.dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json expected');
  try { return JSON.parse((await readBody(req, limit)).toString('utf8')); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'bad json');
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer = '', headers: Record<string, string | string[]> = {}) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string | string[]> = {}) =>
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
const sendText = (res: ServerResponse, status: number, text: string) =>
  send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8' });

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** Returns a handler for /api/*: resolves to false if the request is not for the API. */
export function createApi(cfg: ServerConfig) {
  const secret = secretFor(cfg);
  const termine = new TermineStore(cfg.dataDir);
  const shared = new SharedSettings(cfg.dataDir);
  const plan = new PlanStore(cfg.dataDir);
  const limiter = new LoginLimiter();
  const maxUpload = cfg.maxUploadMb * 1024 * 1024;
  const predigten = join(cfg.dataDir, 'predigten');

  const clientIp = (req: IncomingMessage) => {
    // behind the NAS reverse proxy: the last entry was added by the proxy itself
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return fwd.at(-1) || String(req.headers['x-real-ip'] ?? '') || req.socket.remoteAddress || 'unknown';
  };
  const isHttps = (req: IncomingMessage) => cfg.secureCookies || req.headers['x-forwarded-proto'] === 'https';

  function sessionOf(req: IncomingMessage): Role | null {
    const cookie = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
    return cookie ? verifySession(secret, cfg.users, decodeURIComponent(cookie.slice(COOKIE.length + 1))) : null;
  }

  function cookieHeader(req: IncomingMessage, value: string, maxAgeSec: number) {
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
  }

  function login(req: IncomingMessage, res: ServerResponse, body: unknown) {
    const ip = clientIp(req);
    const wait = limiter.blockedFor(ip);
    if (wait) { res.setHeader('Retry-After', String(wait)); throw new HttpError(429, `too many attempts, retry in ${wait}s`); }
    const { user, password } = (body && typeof body === 'object' ? body : {}) as { user?: unknown; password?: unknown };
    const role = ROLES.find(r => r === String(user ?? '').trim().toLowerCase());
    if (!role || typeof password !== 'string' || !verifyPassword(cfg.users[role], password)) {
      limiter.fail(ip);
      log(`login failed for "${String(user ?? '').slice(0, 30)}" from ${ip}`);
      return new Promise<void>(resolve => setTimeout(() => { sendText(res, 401, 'wrong user or password'); resolve(); }, 400));
    }
    limiter.reset(ip);
    log(`login ${role} from ${ip}`);
    const maxAge = cfg.sessionDays * 86400;
    sendJson(res, 200, { user: role, role }, { 'Set-Cookie': cookieHeader(req, signSession(secret, role, cfg.users[role], Date.now() + maxAge * 1000), maxAge) });
  }

  /**
   * POST /api/upload?name=<file>.mp3 with the MP3 as the body (Content-Type audio/mpeg). Written to disk while
   * it arrives, so the server never holds the file in memory. Never overwrites an existing file.
   */
  async function upload(req: IncomingMessage, res: ServerResponse) {
    const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
    if (!FILE_NAME.test(name)) throw new HttpError(400, 'bad name');
    const size = await receiveMp3(req, join(predigten, name));
    log(`upload ${name} (${Math.round(size / 1024)} kB)`);
    sendJson(res, 200, { ok: true, file: name });
  }

  /**
   * PUT /api/uploads/<file>.mp3 (admin): replaces a published file with a reprocessed one. The first
   * replacement keeps the file as published in predigten/original/, later ones overwrite only the current file.
   */
  async function replace(req: IncomingMessage, res: ServerResponse, name: string) {
    const target = join(predigten, name);
    if (!existsSync(target)) throw new HttpError(404, 'not found');
    const tmp = join(predigten, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
    const size = await receiveMp3(req, tmp);
    const original = join(predigten, ORIGINALS, name);
    try {
      if (!existsSync(original)) {
        await mkdir(join(predigten, ORIGINALS), { recursive: true });
        await rename(target, original);
      }
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    log(`replaced ${name} (${Math.round(size / 1024)} kB)`);
    sendJson(res, 200, { ok: true, file: name });
  }

  /** Streams the request body to `target` (a new file); checks type and size first. */
  async function receiveMp3(req: IncomingMessage, target: string): Promise<number> {
    // audio/mpeg is no "simple" type: a foreign page cannot send it without a CORS preflight (which is refused)
    if (!String(req.headers['content-type'] ?? '').startsWith('audio/mpeg')) throw new HttpError(415, 'not mp3');
    if (Number(req.headers['content-length'] ?? 0) > maxUpload) throw new HttpError(413, 'too large');
    const body = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    try {
      return await receive(body, target);
    } catch (e) {
      // read the rest anyway, otherwise the browser may wait forever for the error answer
      (async () => { while (!(await body.next()).done); })().catch(() => undefined);
      throw e;
    }
  }

  async function receive(body: AsyncIterator<Buffer>, target: string): Promise<number> {
    // the first bytes decide whether it is an MP3 at all, before a file is created
    let head = Buffer.alloc(0);
    while (head.length < 3) {
      const next = await body.next();
      if (next.done) break;
      head = Buffer.concat([head, next.value]);
    }
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const isFrame = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    if (head.length < 3 || (!isId3 && !isFrame)) throw new HttpError(415, 'not mp3');

    await mkdir(predigten, { recursive: true });
    const out = await open(target, 'wx').catch(e => { // 'wx': never overwrite
      throw (e as NodeJS.ErrnoException).code === 'EEXIST' ? new HttpError(409, 'exists') : e;
    });
    let size = 0;
    async function* chunks() {
      for (let chunk: Buffer | undefined = head; chunk; ) {
        size += chunk.length;
        if (size > maxUpload) throw new HttpError(413, 'too large');
        yield chunk;
        const next = await body.next();
        chunk = next.done ? undefined : next.value;
      }
    }
    try {
      await pipeline(chunks(), out.createWriteStream());
    } catch (e) {
      await out.close().catch(() => undefined);
      await unlink(target).catch(() => undefined); // no half-written file (too large, connection lost)
      throw e;
    }
    return size;
  }

  /** GET /api/uploads/<file>.mp3 (admin), with ?original=1 the file as first published (see replace). */
  async function sendUpload(req: IncomingMessage, res: ServerResponse, name: string) {
    const original = new URL(req.url ?? '', 'http://x').searchParams.get('original') === '1';
    const file = original ? join(predigten, ORIGINALS, name) : join(predigten, name);
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) throw new HttpError(404, 'not found');
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(s.size));
    res.setHeader('Content-Disposition', `attachment; filename="${original ? name.replace(/\.mp3$/, '-original.mp3') : name}"`);
    await pipeline(createReadStream(file), res);
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const post = method === 'POST';

    if (path === '/api/health') return sendJson(res, 200, { ok: true });
    if (path === '/api/login' && post) return login(req, res, await readJson(req, 4096));
    if (path === '/api/logout' && post) return send(res, 204, '', { 'Set-Cookie': cookieHeader(req, '', 0) });

    const role = sessionOf(req);
    // the Einsatzplan is the only content without login: visitors see just the next few dates (see publicPlan)
    if (path === '/api/plan' && method === 'GET') {
      const stored = await plan.read();
      const value = stored ? (role ? stored.plan : publicPlan(stored.plan, isoDate(new Date()))) : { entries: [], names: {} };
      return sendJson(res, 200, { ...value, updated: stored?.updated ?? null, public: !role } satisfies PlanResponse);
    }
    if (!role) throw new HttpError(401, 'unauthorized');
    const admin = () => { if (role !== 'admin') throw new HttpError(403, 'forbidden'); };

    if (path === '/api/me' && method === 'GET') return sendJson(res, 200, { user: role, role });

    if (path === '/api/termine' && method === 'GET') {
      const { data, skipped } = await termine.read();
      return sendJson(res, 200, { dates: data.dates, skipped });
    }
    if (path === '/api/termine' && post) {
      const op = await readJson(req) as Op;
      if (op?.action !== 'vote') admin(); // everybody answers, only the admin edits dates
      const { data, skipped } = await termine.apply(op);
      return sendJson(res, 200, { dates: data.dates, skipped });
    }
    if (path === '/api/termine/export' && method === 'GET') {
      admin();
      return send(res, 200, await termine.exportXlsx(), {
        'Content-Type': XLSX_MIME, 'Content-Disposition': 'attachment; filename="termine.xlsx"',
      });
    }
    if (path === '/api/termine/template' && method === 'GET') {
      admin();
      return send(res, 200, await termine.templateXlsx(), {
        'Content-Type': XLSX_MIME, 'Content-Disposition': 'attachment; filename="termine-vorlage.xlsx"',
      });
    }
    if (path === '/api/termine/import' && post) {
      admin();
      let result;
      try { result = await termine.importXlsx(await readBody(req, 5 * 1024 * 1024)); } catch (e) {
        if (e instanceof InvalidSpreadsheet) throw new HttpError(400, 'not a valid xlsx file');
        throw e;
      }
      log(`termine imported: ${result.dates} dates, ${result.skipped} rows skipped`);
      return sendJson(res, 200, result);
    }

    if (path === '/api/plan/import' && post) {
      admin();
      let result;
      try { result = await plan.importXlsx(await readBody(req, 10 * 1024 * 1024)); } catch (e) {
        if (e instanceof PlanFormatError) throw new HttpError(400, e.message);
        throw e;
      }
      log(`plan imported: ${result.dates} dates, ${result.hidden} without service hidden`);
      return sendJson(res, 200, result);
    }

    const settingsMatch = /^\/api\/settings\/([a-z]+)$/.exec(path);
    if (settingsMatch) {
      const app = settingsMatch[1];
      if (method === 'GET') {
        const values = await shared.get(app);
        if (!values) throw new HttpError(404, 'unknown app');
        return sendJson(res, 200, values);
      }
      if (method === 'PUT') {
        admin();
        const values = SharedSettings.sanitize(app, await readJson(req, 2 * 1024 * 1024));
        if (!values) throw new HttpError(404, 'unknown app');
        await shared.set(app, values);
        return sendJson(res, 200, values);
      }
    }

    if (path === '/api/upload' && post) return upload(req, res);
    if (path === '/api/uploads' && method === 'GET') {
      admin();
      const names = (await readdir(predigten).catch(() => [])).filter(n => FILE_NAME.test(n)).sort().reverse();
      return sendJson(res, 200, await Promise.all(names.map(async name => {
        const s = await stat(join(predigten, name));
        return { name, size: s.size, modified: s.mtime.toISOString(), original: existsSync(join(predigten, ORIGINALS, name)) };
      })));
    }
    const uploadMatch = /^\/api\/uploads\/([^/]+)$/.exec(path);
    if (uploadMatch) {
      admin();
      let name;
      try { name = decodeURIComponent(uploadMatch[1]); } catch { throw new HttpError(400, 'bad name'); }
      if (!FILE_NAME.test(name)) throw new HttpError(400, 'bad name');
      if (method === 'GET') return sendUpload(req, res, name);
      if (method === 'PUT') return replace(req, res, name);
    }
    throw new HttpError(404, 'not found');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/')) return false;
    try {
      // CSRF: the login cookie is SameSite=Strict, and JSON bodies cannot be sent cross-site without a CORS preflight
      await route(req, res, path);
    } catch (e) {
      if (res.headersSent) { res.end(); return true; }
      if (e instanceof HttpError) sendText(res, e.status, e.message);
      else if (e instanceof OpError) sendText(res, 400, e.message);
      else if (e instanceof PlanFormatError) { console.error(`einsatzplan.xlsx: ${e.message}`); sendText(res, 500, 'einsatzplan.xlsx is damaged'); }
      else if (e instanceof DamagedSettings) { console.error(e.message); sendText(res, 500, 'settings.json is damaged'); }
      else { console.error(e); sendText(res, 500, 'server error'); }
    }
    return true;
  };
}
