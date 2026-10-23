// Checks the OpenCloud access in the config file before (or after) deploying:
//   npm run cloud-check -- pfad/zur/config.json     (im Container: node dist-server/cloud-check.mjs)
// Lists the target folder with the app token and, with --write, also uploads and deletes a small test file.
// --big uploads 20 MB (hidden name, deleted afterwards) and shows every 2 s how much has gone out – to tell a slow
// line from one that gets stuck on large uploads; --ipv4 does that over IPv4 only, for comparison.
// Einsatzplan and eAg-Übersicht (cloud.plan / cloud.overview) are only looked at, never changed.
import { writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config';
import { describeStoreError, WebDavStore } from './sermon-store';
import { CloudFile } from './cloud-file';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--')) ?? process.env.CONFIG_FILE ?? '/config/config.json';
let cfg;
try { cfg = loadConfig(file); } catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
}
if (!cfg.cloud) {
  console.error(`${file}: kein Abschnitt "cloud" – die Predigten würden im Datenverzeichnis gespeichert.`);
  process.exit(1);
}
const store = new WebDavStore(cfg.cloud);
try {
  const files = await store.list();
  console.log(`✓ Ordner erreichbar: ${cfg.cloud.url}`);
  console.log(`  ${files.length} Datei(en)${files.length ? `, z. B. ${files.slice(0, 3).map(f => f.name).join(', ')}` : ''}`);
  if (args.includes('--write')) {
    const name = `.mischer-app-test-${Date.now()}.mp3`, tmp = join(tmpdir(), name);
    writeFileSync(tmp, 'ID3 test');
    await store.write(name, tmp, false);
    const res = await fetch(cfg.cloud.url + encodeURIComponent(name), {
      method: 'DELETE', headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.cloud.user}:${cfg.cloud.token}`).toString('base64') },
    });
    console.log(`✓ Schreiben erlaubt (Testdatei hochgeladen${res.ok ? ' und wieder gelöscht' : `, Löschen fehlgeschlagen: ${res.status} – ${name} bitte von Hand löschen`})`);
  }
} catch (e) {
  console.error(`✗ ${describeStoreError(e)}`);
  process.exit(1);
}
if (args.includes('--big')) await bigUpload(cfg.cloud.url, cfg.cloud.user, cfg.cloud.token, args.includes('--ipv4'));

let failed = false;
for (const [key, label] of [['plan', 'Einsatzplan'], ['overview', 'eAg-Übersicht']] as const) {
  const url = cfg.cloud[key];
  if (!url) { console.log(`– ${label}: nicht eingetragen (cloud.${key})`); continue; }
  try {
    const { modified } = await new CloudFile(url, cfg.cloud).stat();
    console.log(`✓ ${label} erreichbar, zuletzt geändert ${new Date(modified).toLocaleString('de-DE')}`);
  } catch (e) {
    console.error(`✗ ${label}: ${describeStoreError(e)}`);
    failed = true;
  }
}
if (failed) process.exit(1);

/** 20 MB to the folder, with the progress of sending and the time until OpenCloud answers. */
async function bigUpload(folder: string, user: string, token: string, ipv4: boolean) {
  const host = new URL(folder).hostname;
  const addresses = await lookup(host, { all: true }).catch(() => []);
  console.log(`\nGroßer Test (20 MB) nach ${host} – Adressen: ${addresses.map(a => `${a.address} (IPv${a.family})`).join(', ') || '?'}${ipv4 ? ' – nur IPv4' : ''}`);
  const size = 20 * 1024 * 1024, chunk = 64 * 1024;
  let sent = 0, lastSent = 0, lastChange = Date.now();
  const t0 = Date.now();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= size) { c.close(); return; }
      const n = Math.min(chunk, size - sent), part = new Uint8Array(n);
      for (let i = 0; i < n; i++) part[i] = ((sent + i) * 2654435761) >>> 24; // not compressible
      if (sent === 0) part.set([0x49, 0x44, 0x33]);
      sent += n;
      c.enqueue(part);
    },
  });
  const tick = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    if (sent !== lastSent) { lastSent = sent; lastChange = Date.now(); }
    const stuck = Math.round((Date.now() - lastChange) / 1000);
    // what the network has taken (the system's send buffer fills first, then drains at the speed of the line)
    console.log(`  ${s.toFixed(0).padStart(4)} s: ${(sent / 1e6).toFixed(1)} MB ans Netzwerk übergeben${sent >= size ? ' – alles übergeben, warte auf Antwort' : stuck >= 10 ? ` – nimmt seit ${stuck} s nichts mehr an` : ''}`);
  }, 2000);
  const name = `.mischer-app-big-test-${Date.now()}.mp3`;
  const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: ipv4 ? { family: 4 } : undefined });
  try {
    const res = await undiciFetch(folder + encodeURIComponent(name), {
      method: 'PUT', body: body as never, duplex: 'half', dispatcher: agent, signal: AbortSignal.timeout(10 * 60_000),
      headers: { Authorization: auth, 'Content-Type': 'audio/mpeg', 'Content-Length': String(size) },
    });
    const s = (Date.now() - t0) / 1000;
    console.log(`${res.ok ? '✓' : '✗'} Antwort ${res.status} nach ${s.toFixed(1)} s – im Mittel ${(size * 8 / 1e6 / s).toFixed(1)} Mbit/s`);
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    console.log(`✗ abgebrochen nach ${((Date.now() - t0) / 1000).toFixed(1)} s (${cause}), übergeben: ${(sent / 1e6).toFixed(1)} MB`);
  } finally {
    clearInterval(tick);
    const del = await undiciFetch(folder + encodeURIComponent(name), { method: 'DELETE', headers: { Authorization: auth }, dispatcher: agent }).catch(() => null);
    if (del && !del.ok && del.status !== 404) console.log(`  Testdatei ${name} bitte von Hand löschen (${del.status})`);
    await agent.close();
  }
}
