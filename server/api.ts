// The HTTP API under /api: login, Termine, shared settings and MP3 upload.
// Used by server/main.ts (production) and dev-server.ts (npm run dev / preview).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { OpError, type Op } from '../apps/termine/src/model';
import { LoginLimiter, signSession, verifyPassword, verifySession } from './auth';
import { ROLES, type Role, type ServerConfig } from './config';
import { SharedSettings } from './shared-settings';
import { InvalidSpreadsheet, TermineStore } from './termine-store';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const COOKIE = 'mischer_session';
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}\.mp3$/;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

  async function upload(req: IncomingMessage, res: ServerResponse) {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'upload error');
    const body = await readBody(req, maxUpload + 1024 * 1024);
    const form = await new Response(body as unknown as BodyInit, { headers: { 'content-type': type } }).formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) throw new HttpError(400, 'upload error');
    if (file.size > maxUpload) throw new HttpError(413, 'too large');
    const name = file.name.split(/[\\/]/).pop() ?? '';
    if (!FILE_NAME.test(name)) throw new HttpError(400, 'bad name');
    const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const isFrame = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    if (!isId3 && !isFrame) throw new HttpError(415, 'not mp3');
    await mkdir(predigten, { recursive: true });
    const target = join(predigten, name);
    try {
      // 'wx': never overwrite; streamed, so the file is not copied once more in memory
      await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(target, { flags: 'wx' }));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'exists');
      await unlink(target).catch(() => undefined); // no half-written file
      throw e;
    }
    log(`upload ${name} (${Math.round(file.size / 1024)} kB)`);
    sendJson(res, 200, { ok: true, file: name });
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const post = method === 'POST';

    if (path === '/api/health') return sendJson(res, 200, { ok: true });
    if (path === '/api/login' && post) return login(req, res, await readJson(req, 4096));
    if (path === '/api/logout' && post) return send(res, 204, '', { 'Set-Cookie': cookieHeader(req, '', 0) });

    const role = sessionOf(req);
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

    const settingsMatch = /^\/api\/settings\/([a-z]+)$/.exec(path);
    if (settingsMatch) {
      const app = settingsMatch[1];
      if (method === 'GET') return sendJson(res, 200, await shared.get(app));
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
        return { name, size: s.size, modified: s.mtime.toISOString() };
      })));
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
      else { console.error(e); sendText(res, 500, 'server error'); }
    }
    return true;
  };
}
