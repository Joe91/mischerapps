// What the ID3 tag at the start of each published sermon says, for the admin's list: the app's mark (Tags.processed,
// see packages/audio-core/tags.ts) and which required details are missing (missingTags in tagging.ts). Read once per
// version (name, size, time) and remembered in dataDir/marks.json, so that only new or changed files cost a request
// when the admin lists the folder.
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { id3Length, readTags } from '../packages/audio-core/tags';
import { missingTags } from '../apps/predigt-schnitt/src/tagging';
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

/** `processed`: the app's mark (null: none); `missing`: required details the tag lacks (labels, e.g. "Prediger/in"). */
export interface TagSummary { processed: string | null; missing: string[]; }

const summarize = (head: Uint8Array): TagSummary => {
  const t = readTags(head);
  return { processed: t.processed ?? null, missing: missingTags(t) };
};

const isSummary = (v: unknown): v is TagSummary => !!v && typeof v === 'object' && Array.isArray((v as TagSummary).missing);

export class Marks {
  private file: string;
  private known: Record<string, TagSummary> = {};

  constructor(dataDir: string, private originals: string) {
    this.file = join(dataDir, 'marks.json');
    try {
      // entries in an older form are read again
      this.known = Object.fromEntries(Object.entries(JSON.parse(readFileSync(this.file, 'utf8'))).filter(([, v]) => isSummary(v))) as Record<string, TagSummary>;
    } catch { /* none yet, or damaged: read again */ }
  }

  /**
   * The summary of each published file and, for those replaced before, the mark of the first version kept on the
   * NAS (null: none – reprocessing starts from there). Files that cannot be read just now count as unmarked and
   * complete, without being remembered.
   */
  async of(store: SermonStore, files: StoredFile[]): Promise<Map<string, TagSummary & { originalProcessed?: string | null }>> {
    const next: Record<string, TagSummary> = {};
    const out = new Map<string, TagSummary & { originalProcessed?: string | null }>();
    const remember = async (key: string, read: () => Promise<Uint8Array | null>): Promise<TagSummary> => {
      if (key in this.known) return (next[key] = this.known[key]);
      const head = await read().catch(() => null);
      if (!head) return { processed: null, missing: [] };
      return (next[key] = summarize(head));
    };
    const todo = [...files];
    const worker = async (): Promise<void> => {
      for (let f = todo.shift(); f; f = todo.shift()) {
        const name = f.name;
        const current = await remember(`${name}|${f.size}|${f.modified}`, async () => {
          const file = await store.read(name);
          return file && readHead(file.body);
        });
        const original = join(this.originals, name);
        if (!existsSync(original)) { out.set(name, current); continue; }
        const s = statSync(original);
        const first = await remember(`original/${name}|${s.size}|${s.mtimeMs}`, () => readHead(createReadStream(original)));
        out.set(name, { ...current, originalProcessed: first.processed });
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
