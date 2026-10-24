// The HTTP API under /api: login, Einsatzplan (with the answers of the Termine), shared settings and publishing MP3s (to OpenCloud, see sermon-store.ts).
// Used by server/main.ts (production) and dev-server.ts (npm run dev / preview).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { isoDate } from '../packages/plan/cells';
import { ANSWERS, normalizeSign, type Answer } from '../apps/termine/src/model';
import { publicPlan, type PlanResponse } from '../packages/plan/plan';
import { LoginLimiter, signSession, verifyPassword, verifySession } from './auth';
import { ROLES, type Role, type ServerConfig } from './config';
import { PlanDateMissing, PlanFormatError, PlanReadOnly, PlanStore } from './plan-store';
import { OverviewStore } from './overview-store';
import { CloudFile } from './cloud-file';
import { DamagedSettings, SharedSettings } from './shared-settings';
import { createStore, StoreError, type SermonStore } from './sermon-store';
import { Marks } from './marks';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const COOKIE = 'mischer_session';
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}\.mp3$/;
/** folder in dataDir with the files as first published, before an admin replaced them (a backup, not published) */
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
/**
 * `syncWaitMs`: how long an upload request waits for OpenCloud before answering 202 with a job to ask about – the
 * DSM reverse proxy gives up on requests after 60 s (504), and a slow upstream needs longer for 20 MB.
 */
export function createApi(cfg: ServerConfig, store: SermonStore = createStore(cfg.cloud, cfg.dataDir), { syncWaitMs = 20_000 } = {}) {
  const secret = secretFor(cfg);
  const shared = new SharedSettings(cfg.dataDir);
  const cloudFile = (url?: string) => (cfg.cloud && url ? new CloudFile(url, cfg.cloud) : null);
  const plan = new PlanStore(cfg.dataDir, cloudFile(cfg.cloud?.plan));
  const overview = new OverviewStore(cloudFile(cfg.cloud?.overview));
  const limiter = new LoginLimiter();
  const maxUpload = cfg.maxUploadMb * 1024 * 1024;
  const originals = join(cfg.dataDir, ORIGINALS);
  const marks = new Marks(cfg.dataDir, originals);
  // uploads arrive here before they go to the store (same disk as predigten/ for the local store)
  const incoming = join(cfg.dataDir, 'tmp');
  rmSync(incoming, { recursive: true, force: true }); // left over from an interrupted upload
  mkdirSync(incoming, { recursive: true });
  const tmpFile = () => join(incoming, `${randomBytes(8).toString('hex')}.mp3`);
  /** published files as the admin opened them, with their version: the backup before replacing (see keepOriginal) */
  const opened = join(incoming, 'opened');

  /** Uploads still being passed on to OpenCloud after the request was answered (GET /api/jobs/<id>). */
  interface Job { state: 'running' | 'done' | 'failed'; file: string; progress: number; status?: number; error?: string; ended?: number; }
  const jobs = new Map<string, Job>();

  /**
   * Runs `task` (passing an upload on to the store) and answers as soon as it is done – or, if it takes longer
   * than `syncWaitMs`, at once with 202 and a job id: the browser then asks until it is done.
   */
  async function finish(res: ServerResponse, name: string, run: (progress: (share: number) => void) => Promise<void>) {
    const job: Job = { state: 'running', file: name, progress: 0 };
    const started = Date.now();
    const done = run(share => { job.progress = share; }).then(() => { job.state = 'done'; }, e => {
      const known = e instanceof HttpError || e instanceof StoreError;
      Object.assign(job, { state: 'failed', status: known ? e.status : 500, error: known ? e.message : 'server error' });
      if (!known) console.error(e);
      else if (e.status === 502) console.error(`${store.label}: ${name}: ${e.message} (nach ${Math.round((Date.now() - started) / 1000)} s)`);
    }).finally(() => { job.ended = Date.now(); });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise(r => { timer = setTimeout(r, syncWaitMs); })]);
    clearTimeout(timer);
    if (job.state === 'done') return sendJson(res, 200, { ok: true, file: name });
    if (job.state === 'failed') return sendText(res, job.status!, job.error!);
    for (const [id, j] of jobs) if (j.ended && Date.now() - j.ended > 3600_000) jobs.delete(id); // answered long ago
    const id = randomBytes(8).toString('hex');
    jobs.set(id, job);
    sendJson(res, 202, { ok: true, file: name, job: id });
  }

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
    sendJson(res, 200, { user: role, role, target: store.label }, { 'Set-Cookie': cookieHeader(req, signSession(secret, role, cfg.users[role], Date.now() + maxAge * 1000), maxAge) });
  }

  /**
   * POST /api/upload?name=<file>.mp3 with the MP3 as the body (Content-Type audio/mpeg): publishes it. The body is
   * written to disk while it arrives (the server never holds the file in memory), then passed to the store.
   * Never overwrites an existing file.
   */
  async function upload(req: IncomingMessage, res: ServerResponse) {
    const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
    if (!FILE_NAME.test(name)) throw new HttpError(400, 'bad name');
    if (await store.exists(name)) throw new HttpError(409, 'exists'); // before receiving megabytes in vain
    const tmp = tmpFile();
    const size = await receiveMp3(req, tmp);
    const started = Date.now();
    return finish(res, name, async progress => {
      await store.write(name, tmp, false, progress);
      log(`published ${name} to ${store.label} (${Math.round(size / 1024)} kB, ${Math.round((Date.now() - started) / 1000)} s)`);
    });
  }

  /**
   * PUT /api/uploads/<file>.mp3 (admin): replaces a published file with a reprocessed one. Before the first
   * replacement the server keeps the file as published in dataDir/original/; later ones only overwrite.
   */
  async function replace(req: IncomingMessage, res: ServerResponse, name: string) {
    if (!(await store.exists(name))) throw new HttpError(404, 'not found');
    const tmp = tmpFile();
    const size = await receiveMp3(req, tmp);
    const started = Date.now();
    return finish(res, name, async progress => {
      try {
        const how = await keepOriginal(name);
        if (how !== 'kept') log(`kept the first version of ${name} (${how === 'opened' ? 'as opened' : 'downloaded'}, ${Math.round((Date.now() - started) / 1000)} s)`);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
      await store.write(name, tmp, true, progress);
      log(`replaced ${name} in ${store.label} (${Math.round(size / 1024)} kB, ${Math.round((Date.now() - started) / 1000)} s)`);
    });
  }

  /**
   * The first version of a published file before it is replaced: "kept" already, taken from the copy made when the
   * admin opened it ("opened" – if OpenCloud still has that version), or downloaded once more.
   */
  async function keepOriginal(name: string): Promise<'kept' | 'opened' | 'downloaded'> {
    const target = join(originals, name);
    if (existsSync(target)) return 'kept';
    mkdirSync(originals, { recursive: true });
    const copy = join(opened, name);
    if (existsSync(copy)) {
      const seen = readFileSync(`${copy}.version`, 'utf8');
      if (seen && seen === await store.version(name)) {
        await rename(copy, target);
        await unlink(`${copy}.version`).catch(() => undefined);
        return 'opened';
      }
    }
    const current = await store.read(name);
    if (!current) throw new HttpError(404, 'not found');
    const tmp = tmpFile();
    await pipeline(current.body, createWriteStream(tmp));
    await rename(tmp, target);
    return 'downloaded';
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

    const out = await open(target, 'wx');
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
    let file: { size: number; body: NodeJS.ReadableStream; version?: string | null } | null;
    if (original) {
      const s = await stat(join(originals, name)).catch(() => null);
      file = s?.isFile() ? { size: s.size, body: createReadStream(join(originals, name)) } : null;
    } else {
      file = await store.read(name);
    }
    if (!file) throw new HttpError(404, 'not found');
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'audio/mpeg');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${original ? name.replace(/\.mp3$/, '-original.mp3') : name}"`);
    // not replaced yet: keep a copy as it passes through – replacing it then needs no second download (keepOriginal)
    const keep = !original && file.version && !existsSync(join(originals, name)) ? tmpFile() : null;
    let copied: Promise<unknown> | null = null;
    if (keep) {
      const out = createWriteStream(keep);
      copied = new Promise<void>((ok, fail) => { out.on('finish', () => ok()); out.on('error', fail); });
      file.body.pipe(out);
    }
    try {
      await pipeline(file.body, res);
      if (keep) {
        await copied;
        if (!file.size || (await stat(keep)).size === file.size) {
          mkdirSync(opened, { recursive: true });
          await rename(keep, join(opened, name));
          writeFileSync(join(opened, `${name}.version`), file.version!);
        }
      }
    } finally {
      if (keep) await unlink(keep).catch(() => undefined);
    }
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
      return sendJson(res, 200, {
        ...value, updated: stored?.updated ?? null, public: !role, source: plan.source, syncError: role ? stored?.syncError ?? null : null,
      } satisfies PlanResponse);
    }
    if (!role) throw new HttpError(401, 'unauthorized');
    const admin = () => { if (role !== 'admin') throw new HttpError(403, 'forbidden'); };

    // `target`: where uploads are published ("OpenCloud", or "NAS" without cloud configuration)
    if (path === '/api/me' && method === 'GET') return sendJson(res, 200, { user: role, role, target: store.label });

    // Termine: whether someone can mix on a date – written into the Einsatzplan ("Mischer möglich" / "nicht möglich")
    if (path === '/api/termine' && post) {
      const { date, sign, answer } = (await readJson(req, 4096) ?? {}) as { date?: unknown; sign?: unknown; answer?: unknown };
      const code = normalizeSign(String(sign ?? ''));
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'bad date');
      if (!code) throw new HttpError(400, 'bad sign');
      if (answer !== null && !ANSWERS.includes(answer as Answer)) throw new HttpError(400, 'bad answer');
      // only dates of the plan; a page that is out of date must not write into a row that is gone
      const stored = await plan.read();
      if (!stored?.plan.entries.some(e => e.date === date)) throw new HttpError(400, 'unknown date');
      await plan.answer(date, code, answer as Answer | null);
      return send(res, 204);
    }

    if (path === '/api/plan/import' && post) {
      admin();
      let result;
      try { result = await plan.importXlsx(await readBody(req, 10 * 1024 * 1024)); } catch (e) {
        if (e instanceof PlanFormatError) throw new HttpError(400, e.message);
        if (e instanceof PlanReadOnly) throw new HttpError(409, 'plan comes from OpenCloud');
        throw e;
      }
      log(`plan imported: ${result.dates} dates, ${result.hidden} without service hidden`);
      return sendJson(res, 200, result);
    }
    if (path === '/api/plan/refresh' && post) {
      admin();
      await plan.sync(true);
      return send(res, 204);
    }
    // the admin enters who mixes on a date; written into the Einsatzplan (in OpenCloud: only that cell)
    if (path === '/api/plan/mischer' && post) {
      admin();
      const { date, mischer } = (await readJson(req, 4096) ?? {}) as { date?: unknown; mischer?: unknown };
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'bad date');
      if (typeof mischer !== 'string' || mischer.length > 60 || /[\r\n]/.test(mischer)) throw new HttpError(400, 'bad mischer');
      await plan.assign(date, mischer.trim());
      log(`plan: Mischer ${date} = "${mischer.trim()}"`);
      return send(res, 204);
    }
    // what the eAg-Übersicht says about a date: series, its number in the series, preacher (for the tags)
    if (path === '/api/overview' && method === 'GET') {
      const date = new URL(req.url ?? '', 'http://x').searchParams.get('date') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'bad date');
      if (!overview.configured) throw new HttpError(404, 'no overview');
      const entry = await overview.find(date);
      if (!entry) throw new HttpError(404, 'date not in overview');
      return sendJson(res, 200, entry);
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
    // an upload that took longer than one request (see finish): running, done, or failed with the reason
    const jobMatch = /^\/api\/jobs\/([0-9a-f]{16})$/.exec(path);
    if (jobMatch && method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) throw new HttpError(404, 'unknown job');
      return sendJson(res, 200, { state: job.state, file: job.file, progress: job.progress, status: job.status ?? null, error: job.error ?? null });
    }
    // is a sermon of this name published already? (for everybody: the export warns before the work is done)
    if (path === '/api/published' && method === 'GET') {
      const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
      if (!FILE_NAME.test(name)) throw new HttpError(400, 'bad name');
      return sendJson(res, 200, { exists: await store.exists(name) });
    }
    if (path === '/api/uploads' && method === 'GET') {
      admin();
      const files = (await store.list()).filter(f => FILE_NAME.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
      // the app's mark in the file and in its first version: made with the app already, not to be processed again
      const marked = await marks.of(store, files);
      return sendJson(res, 200, files.map(f => ({ ...f, original: existsSync(join(originals, f.name)), processed: null, ...marked.get(f.name) })));
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
      else if (e instanceof StoreError) {
        if (e.status === 502) console.error(`${store.label}: ${e.message}`);
        sendText(res, e.status, e.message);
      }
      else if (e instanceof PlanDateMissing) sendText(res, 404, 'date not in plan');
      else if (e instanceof PlanFormatError) { console.error(`einsatzplan.xlsx: ${e.message}`); sendText(res, 500, 'einsatzplan.xlsx is damaged'); }
      else if (e instanceof DamagedSettings) { console.error(e.message); sendText(res, 500, 'settings.json is damaged'); }
      else { console.error(e); sendText(res, 500, 'server error'); }
    }
    return true;
  };
}
