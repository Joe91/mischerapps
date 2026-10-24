// Puts the app's mark (Tags.processed, TXXX "Mischer-App") into the published sermons: into those that have none yet,
// or with --note into all whose mark differs from that text (e.g. after processing all of them again).
//   npm run mark-processed -- pfad/zur/config.json [--note "bearbeitet 24.10.2026 · …"] [--write]
//   (im Container: node dist-server/mark-processed.mjs --note "…" --write)
// Without --write it only counts. Only the ID3 tag changes (the mark goes into its padding); the audio stays byte for
// byte, which is checked before each upload. OpenCloud keeps the previous version of each file.
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { id3Length, readTags, setProcessedMark } from '../packages/audio-core/tags';
import { ConfigError, loadConfig } from './config';
import { createStore, describeStoreError } from './sermon-store';
import { readHead } from './marks';

/** for files without any mark, if no --note is given */
const NOTE = 'bearbeitet (vor dem 24.10.2026, nachträglich markiert)';
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}\.mp3$/;

const args = parseArgs({ allowPositionals: true, options: { note: { type: 'string' }, write: { type: 'boolean' } } });
const file = args.positionals[0] ?? process.env.CONFIG_FILE ?? '/config/config.json';
const write = !!args.values.write;
const note = args.values.note?.trim() || NOTE;
/** what counts as done: with --note exactly that text, otherwise any mark */
const done = (mark: string | undefined) => (args.values.note ? mark === note : !!mark);
let cfg;
try { cfg = loadConfig(file); } catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
}
const store = createStore(cfg.cloud, cfg.dataDir);
const tmp = await mkdtemp(join(tmpdir(), 'mark-processed-'));
let marked = 0, already = 0, failed = 0;
try {
  const files = (await store.list()).filter(f => FILE_NAME.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`${store.label}: ${files.length} Predigten · Markierung: ${note}${write ? '' : ' (nur zählen – mit --write markieren)'}`);
  for (const f of files) {
    try {
      const head = await store.read(f.name);
      if (!head) throw new Error('verschwunden');
      if (done(readTags(await readHead(head.body)).processed)) { already++; continue; }
      if (!write) { marked++; continue; }
      const path = join(tmp, f.name);
      const current = await store.read(f.name);
      if (!current) throw new Error('verschwunden');
      await pipeline(current.body, createWriteStream(path));
      const before = new Uint8Array(readFileSync(path));
      const after = setProcessedMark(before, note);
      if (!after) throw new Error('ID3-Tag in einer Form, die das Skript nicht ändert');
      // the audio behind the tag must be the same, byte for byte
      if (Buffer.compare(before.subarray(id3Length(before)), after.subarray(id3Length(after))) !== 0) throw new Error('Audio wäre verändert');
      if (readTags(after).processed !== note) throw new Error('Markierung nicht lesbar');
      writeFileSync(path, after);
      await store.write(f.name, path, true);
      marked++;
      console.log(`✓ ${f.name}${after.length === before.length ? '' : ` (Tag vergrößert, +${after.length - before.length} Bytes)`}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${f.name}: ${describeStoreError(e)}`);
    }
  }
} catch (e) {
  console.error(`✗ ${describeStoreError(e)}`);
  process.exit(1);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log(`${write ? 'markiert' : 'zu markieren'}: ${marked} · schon so markiert: ${already}${failed ? ` · Fehler: ${failed}` : ''}`);
process.exit(failed ? 1 : 0);
