// The Termine live in one human-readable spreadsheet (dataDir/termine.xlsx, see apps/termine/src/xlsx.ts).
// It is read on every request, so edits made by hand on the NAS show up immediately. Changes are applied
// one at a time and written atomically, so simultaneous answers cannot overwrite each other.
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyOp, type Op, type TermineData } from '../apps/termine/src/model';
import { readTermineXlsx, writeTermineXlsx } from '../apps/termine/src/xlsx';

export interface Loaded { data: TermineData; /** spreadsheet rows ignored because of a missing/invalid date */ skipped: number; }

const toBuffer = async (blob: Blob) => Buffer.from(await blob.arrayBuffer());

export class TermineStore {
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string) { this.file = join(dir, 'termine.xlsx'); }

  /** An unreadable file throws (and is never overwritten). A missing file is an empty list. */
  async read(): Promise<Loaded> {
    let buf: Buffer;
    try { buf = await readFile(this.file); } catch { return { data: { dates: {} }, skipped: 0 }; }
    return readTermineXlsx(new Blob([new Uint8Array(buf)]));
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(data: TermineData) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, await toBuffer(await writeTermineXlsx(data)));
    await rename(tmp, this.file);
  }

  /** Applies one change. Throws OpError for invalid input. */
  apply(op: Op): Promise<Loaded> {
    return this.serialize(async () => {
      const { data, skipped } = await this.read();
      applyOp(data, op);
      await this.write(data);
      return { data, skipped };
    });
  }

  async exportXlsx(): Promise<Buffer> {
    const { data } = await this.read();
    return toBuffer(await writeTermineXlsx(data));
  }

  /** Replaces all dates with the content of an uploaded spreadsheet; the previous file is kept as termine.backup.xlsx. */
  importXlsx(buf: Buffer): Promise<{ dates: number; skipped: number }> {
    return this.serialize(async () => {
      const { data, skipped } = await readTermineXlsx(new Blob([new Uint8Array(buf)])); // throws if it is not a spreadsheet
      await copyFile(this.file, join(this.dir, 'termine.backup.xlsx')).catch(() => undefined);
      await this.write(data);
      return { dates: Object.keys(data.dates).length, skipped };
    });
  }
}
