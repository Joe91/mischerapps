// Local stand-ins for server/upload.php and server/termine.php so both can be tested with
// `npm run dev` / `npm run preview`. They behave like the PHP scripts (token header, checks, status codes).
// Files land in ./uploads-dev/. Never part of the GitHub Pages build.
import type { Plugin, Connect } from 'vite';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { applyOp, OpError, type Op, type TermineData } from './apps/termine/src/model';

export const DEV_UPLOAD_TOKEN = 'dev-token';
const TARGET_DIR = resolve(__dirname, 'uploads-dev');
const TERMINE_FILE = resolve(TARGET_DIR, 'termine.json');
const MAX_BYTES = 80 * 1024 * 1024;

function handler(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/upload')) return next();
    const send = (code: number, body: string, json = false) => {
      res.statusCode = code;
      res.setHeader('Content-Type', json ? 'application/json' : 'text/plain; charset=utf-8');
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method !== 'POST') return send(405, 'method not allowed');
    if (req.headers['x-upload-token'] !== DEV_UPLOAD_TOKEN) return send(401, 'unauthorized');
    try {
      const request = new Request('http://localhost' + req.url, {
        method: 'POST',
        headers: req.headers as Record<string, string>,
        body: Readable.toWeb(req) as ReadableStream,
        duplex: 'half',
      } as RequestInit);
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return send(400, 'upload error');
      if (file.size > MAX_BYTES) return send(413, 'too large');
      const name = file.name.split(/[\\/]/).pop() ?? '';
      if (!/^[A-Za-z0-9._-]{1,120}\.mp3$/.test(name)) return send(400, 'bad name');
      const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
      const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
      const isFrame = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
      if (!isId3 && !isFrame) return send(415, 'not mp3');
      await mkdir(TARGET_DIR, { recursive: true });
      const dest = resolve(TARGET_DIR, name);
      if (await access(dest).then(() => true, () => false)) return send(409, 'exists');
      await writeFile(dest, new Uint8Array(await file.arrayBuffer()));
      send(200, JSON.stringify({ ok: true, file: name }), true);
    } catch (e) {
      send(500, 'move failed: ' + (e as Error).message);
    }
  };
}

function termineHandler(): Connect.NextHandleFunction {
  let queue = Promise.resolve(); // serializes read-modify-write like flock() in the PHP script
  return (req, res, next) => {
    if (!req.url?.startsWith('/api/termine')) return next();
    const send = (code: number, body: string, json = false) => {
      res.statusCode = code;
      res.setHeader('Content-Type', json ? 'application/json' : 'text/plain; charset=utf-8');
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, 'method not allowed');
    if (req.headers['x-termine-token'] !== DEV_UPLOAD_TOKEN) return send(401, 'unauthorized');
    queue = queue.then(async () => {
      try {
        const data: TermineData = await readFile(TERMINE_FILE, 'utf8').then(JSON.parse, () => ({ dates: {} }));
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          let op: Op;
          try { op = JSON.parse(body); } catch { return send(400, 'bad date'); }
          applyOp(data, op);
          data.dates = Object.fromEntries(Object.entries(data.dates).sort(([a], [b]) => a.localeCompare(b)));
          await mkdir(TARGET_DIR, { recursive: true });
          await writeFile(TERMINE_FILE, JSON.stringify(data, null, 2));
        }
        send(200, JSON.stringify(data), true);
      } catch (e) {
        if (e instanceof OpError) send(400, e.message);
        else send(500, (e as Error).message);
      }
    });
  };
}

export function devUploadPlugin(): Plugin {
  return {
    name: 'dev-upload',
    configureServer(server) { server.middlewares.use(handler()); server.middlewares.use(termineHandler()); },
    configurePreviewServer(server) { server.middlewares.use(handler()); server.middlewares.use(termineHandler()); },
  };
}
