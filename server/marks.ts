// Which published sermons carry the app's mark (Tags.processed, see packages/audio-core/tags.ts). It sits in the ID3
// tag at the start of each file: read once per version (name, size, time) and remembered in dataDir/marks.json, so
// that only new or changed files cost a request when the admin lists the folder.
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { id3Length, readTags } from '../packages/audio-core/tags';
import type { SermonStore, StoredFile } from './sermon-store';

/** The start of a stream up to the end of its ID3 tag (at most `max` bytes); the rest is not read. */
export async function readHead(body: Readable, max = 2 << 20): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0, need = 10;
  for await (const chunk of body) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (need === 10 && size >= 10) need = Math.min(max, Math.max(10, id3Length(Buffer.concat(chunks).subarray(0, 10))));
    if (size >= need) break; // ends the stream (and the download behind it)
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, need));
}

const markIn = (head: Uint8Array) => readTags(head).processed ?? null;

export class Marks {
  private file: string;
  private known: Record<string, string | null> = {};

  constructor(dataDir: string, private originals: string) {
    this.file = join(dataDir, 'marks.json');
    try { this.known = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* none yet, or damaged: read again */ }
  }

  /**
   * The mark of each published file (null: none) and, for those replaced before, of the first version kept on the NAS
   * (null: none – reprocessing starts from there). Files that cannot be read just now count as unmarked, without being remembered.
   */
  async of(store: SermonStore, files: StoredFile[]): Promise<Map<string, { processed: string | null; originalProcessed?: string | null }>> {
    const next: Record<string, string | null> = {};
    const out = new Map<string, { processed: string | null; originalProcessed?: string | null }>();
    const remember = async (key: string, read: () => Promise<Uint8Array | null>) => {
      if (key in this.known) return (next[key] = this.known[key]);
      const head = await read().catch(() => null);
      if (!head) return null;
      return (next[key] = markIn(head));
    };
    const todo = [...files];
    const worker = async (): Promise<void> => {
      for (let f = todo.shift(); f; f = todo.shift()) {
        const name = f.name;
        const processed = await remember(`${name}|${f.size}|${f.modified}`, async () => {
          const file = await store.read(name);
          return file && readHead(file.body);
        });
        const original = join(this.originals, name);
        if (!existsSync(original)) { out.set(name, { processed }); continue; }
        const s = statSync(original);
        const originalProcessed = await remember(`original/${name}|${s.size}|${s.mtimeMs}`, () => readHead(createReadStream(original)));
        out.set(name, { processed, originalProcessed });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    // only what is still there
    if (JSON.stringify(next) !== JSON.stringify(this.known)) {
      this.known = next;
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next));
      renameSync(`${this.file}.tmp`, this.file);
    }
    return out;
  }
}
