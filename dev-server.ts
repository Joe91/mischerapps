// The real API (server/api.ts) inside `npm run dev` / `npm run preview`, with a throw-away configuration.
// Logins: admin / admin and mischer / mischer. Data lands in ./uploads-dev/. Never part of the build.
import type { Plugin, Connect } from 'vite';
import { resolve } from 'node:path';
import { createApi } from './server/api';

function handler(): Connect.NextHandleFunction {
  const api = createApi({
    users: { admin: 'admin', mischer: 'mischer' },
    dataDir: resolve(__dirname, 'uploads-dev'),
    staticDir: resolve(__dirname, 'dist'),
    sessionSecret: 'dev-secret-dev-secret',
    sessionDays: 30,
    maxUploadMb: 150,
    secureCookies: false,
  });
  return (req, res, next) => { api(req, res).then(handled => { if (!handled) next(); }, next); };
}

export function devUploadPlugin(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) { server.middlewares.use(handler()); },
    configurePreviewServer(server) { server.middlewares.use(handler()); },
  };
}
