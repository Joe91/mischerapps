// Local stand-ins for server/upload.php and for a cloud folder (Termine spreadsheet) so both can be tested with
// `npm run dev` / `npm run preview`. They behave like the real thing (token, checks, status codes).
// Files land in ./uploads-dev/. Never part of the GitHub Pages build.
import type { Plugin, Connect } from 'vite';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';

export const DEV_UPLOAD_TOKEN = 'dev-token';
const TARGET_DIR = resolve(__dirname, 'uploads-dev');
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

/** Stand-in for a cloud folder shared as a public link (OpenCloud: /dav/public-files/<token>/, Nextcloud:
 *  /public.php/dav/files/<token>/): GET / HEAD / PUT of single files with ETag and If-Match / If-None-Match,
 *  like the real WebDAV servers. The Termine app keeps its spreadsheet here. Token and password: dev-token. */
function davHandler(): Connect.NextHandleFunction {
  let queue = Promise.resolve(); // one request at a time, so the ETag check and the write cannot interleave
  const etagOf = (buf: Buffer) => `"${createHash('sha1').update(buf).digest('hex')}"`;
  return (req, res, next) => {
    const m = /^\/(?:dav\/public-files|public\.php\/dav\/files)\/([^/]+)\/([^/?]+)$/.exec(req.url ?? '');
    if (!m) return next();
    const send = (code: number, body: string | Buffer = '', headers: Record<string, string> = {}) => {
      res.statusCode = code;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204);
    queue = queue.then(async () => {
      try {
        const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        if (m[1] !== DEV_UPLOAD_TOKEN || !/^(public|anonymous):dev-token$/.test(auth)) return send(401, 'unauthorized');
        const name = decodeURIComponent(m[2]);
        if (!/^[^\\/:*?"<>|\s][^\\/:*?"<>|]*\.xlsx$/i.test(name)) return send(403, 'only .xlsx files in the dev folder');
        const file = resolve(TARGET_DIR, name);
        const current = await readFile(file).catch(() => null);
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!current) return send(404, 'not found');
          return send(200, req.method === 'GET' ? current : '', { ETag: etagOf(current), 'Content-Type': 'application/octet-stream' });
        }
        if (req.method !== 'PUT') return send(405, 'method not allowed');
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const ifMatch = req.headers['if-match'], ifNone = req.headers['if-none-match'];
        if ((ifMatch && (!current || ifMatch !== etagOf(current))) || (ifNone === '*' && current)) return send(412, 'precondition failed');
        await mkdir(TARGET_DIR, { recursive: true });
        const body = Buffer.concat(chunks);
        await writeFile(file, body);
        send(current ? 204 : 201, '', { ETag: etagOf(body) });
      } catch (e) {
        send(500, (e as Error).message);
      }
    });
  };
}

export function devUploadPlugin(): Plugin {
  return {
    name: 'dev-upload',
    configureServer(server) { server.middlewares.use(handler()); server.middlewares.use(davHandler()); },
    configurePreviewServer(server) { server.middlewares.use(handler()); server.middlewares.use(davHandler()); },
  };
}
