// Production server: the web app + API in one process (see Dockerfile).
import { createServer } from 'node:http';
import { createApi } from './api';
import { ConfigError, loadConfig } from './config';
import { createStatic } from './static';

const port = Number(process.env.PORT ?? 8080);
const configFile = process.env.CONFIG_FILE ?? '/config/config.json';

let cfg;
try { cfg = loadConfig(configFile); } catch (e) {
  if (e instanceof ConfigError) { console.error(`Konfigurationsfehler: ${e.message}`); process.exit(1); }
  throw e;
}

const api = createApi(cfg);
const serveStatic = createStatic(cfg.staticDir);

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    if (await serveStatic(req, res)) return;
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end('server error'); } else res.end();
  }
});
server.requestTimeout = 0; // large uploads over slow mobile links
server.listen(port, '0.0.0.0', () => console.log(`Mischer-App läuft auf Port ${port} (Daten: ${cfg.dataDir}, Konfiguration: ${configFile})`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
