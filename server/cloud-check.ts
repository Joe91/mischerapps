// Checks the OpenCloud access in the config file before (or after) deploying:
//   npm run cloud-check -- pfad/zur/config.json     (im Container: node dist-server/cloud-check.mjs)
// Lists the target folder with the app token and, with --write, also uploads and deletes a small test file.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config';
import { describeStoreError, WebDavStore } from './sermon-store';

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
