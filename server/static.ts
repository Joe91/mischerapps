// Serves the built web app (dist/).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.txt', '.map']);

export function createStatic(dir: string) {
  const root = resolve(dir);
  const gz = new Map<string, Buffer>(); // gzip of files, keyed by path + mtime

  return async function serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel: string;
    try { rel = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { res.statusCode = 400; res.end('bad request'); return true; }
    const file = resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + sep)) { res.statusCode = 403; res.end('forbidden'); return true; }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!rel.endsWith('/')) { res.statusCode = 301; res.setHeader('Location', rel + '/'); res.end(); return true; } // relative asset URLs need the slash
      const index = resolve(file, 'index.html');
      info = await stat(index).catch(() => null);
      return info ? send(req, res, index, info.size, info.mtimeMs) : false;
    }
    return info?.isFile() ? send(req, res, file, info.size, info.mtimeMs) : false;
  };

  async function send(req: IncomingMessage, res: ServerResponse, file: string, size: number, mtimeMs: number): Promise<boolean> {
    const ext = extname(file).toLowerCase();
    const etag = `W/"${size}-${Math.round(mtimeMs)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // hashed build files never change; pages are re-checked so a new version shows up right away
    res.setHeader('Cache-Control', file.startsWith(root + sep + 'assets' + sep) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return true; }
    const wantsGzip = COMPRESSIBLE.has(ext) && size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (wantsGzip) {
      const key = `${file}:${etag}`;
      let body = gz.get(key);
      if (!body) { body = gzipSync(await readFile(file)); gz.set(key, body); }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', body.length);
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
    return true;
  }
}
