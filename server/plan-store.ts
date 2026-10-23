// The Einsatzplan (see packages/plan/plan.ts). With "cloud.plan" in the config it is the church's spreadsheet in
// OpenCloud (Musik_Mischer_Beamer.xlsx): read from there, checked for changes every few minutes, and the admin's
// Mischer assignments are written into it. dataDir/einsatzplan.xlsx is then the last copy read, used while
// OpenCloud cannot be reached. Without "cloud.plan" that file is the plan itself, imported by the admin.
// It is parsed again only when the file changes, so the public GET /api/plan stays cheap.
import { readFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { answerCells, planColumns, readPlanXlsx, PlanFormatError, type Availability, type Plan } from '../packages/plan/plan';
import { toIsoDate, toText } from '../packages/plan/cells';
import { serialQueue, writeAtomic } from './files';
import { SyncedFile, type CloudFile } from './cloud-file';
import { describeStoreError, StoreError } from './sermon-store';
import { Xlsx, XlsxError } from './xlsx';

export { PlanFormatError };

/** The plan comes from OpenCloud and cannot be imported here. */
export class PlanReadOnly extends Error {}
/** The date has no row in the plan. */
export class PlanDateMissing extends Error {}

/** How often OpenCloud is asked whether the plan changed. */
const CHECK_EVERY_MS = 2 * 60_000;

/**
 * Changes cells in the row for `date` (first sheet; header row with "Datum" and "Mischer" as in readPlanXlsx):
 * `edit` gets the columns and the current texts and returns column → new text. Only those cells change. Throws
 * PlanDateMissing, or PlanFormatError for a file without such a header or a cell with a formula.
 */
function editRow(data: Uint8Array, date: string,
  edit: (col: ReturnType<typeof planColumns>, text: (col: number) => string) => Map<number, string>): Uint8Array {
  let x: Xlsx, rows;
  try { x = new Xlsx(data); rows = x.rows(0); } catch (e) {
    throw e instanceof XlsxError ? new PlanFormatError(e.message) : e;
  }
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const header = numbers.slice(0, 20).find(r => [...rows.get(r)!.values()].some(v => norm(v) === 'datum') && [...rows.get(r)!.values()].some(v => norm(v) === 'mischer'));
  if (header === undefined) throw new PlanFormatError('no header with "Datum" and "Mischer"');
  const titles: string[] = [];
  for (const [c, v] of rows.get(header)!) titles[c] = norm(v);
  const col = planColumns(Array.from(titles, t => t ?? ''));
  const iso = (v: unknown) => (typeof v === 'number' ? x.serialToIso(v) : toIsoDate(v));
  const row = numbers.find(r => r > header && iso(rows.get(r)!.get(col.date)) === date);
  if (row === undefined) throw new PlanDateMissing(date);
  try {
    for (const [c, text] of edit(col, c => toText(rows.get(row)!.get(c)))) x.setText(0, row, c, text);
  } catch (e) {
    throw e instanceof XlsxError ? new PlanFormatError(e.message) : e;
  }
  return x.toBuffer();
}

/** Writes `mischer` into the Mischer cell of `date`. */
export const setMischer = (data: Uint8Array, date: string, mischer: string) =>
  editRow(data, date, col => new Map([[col.mischer, mischer]]));

/** Enters `sign`'s answer for `date` in "Mischer möglich" / "nicht möglich" (null: withdrawn); other entries stay. */
export const setAvailability = (data: Uint8Array, date: string, sign: string, answer: Availability | null) =>
  editRow(data, date, (col, text) => {
    if (col.possible < 0 || col.notPossible < 0) throw new PlanFormatError('no columns "Mischer möglich" and "nicht möglich"');
    const cells = answerCells(text(col.possible), text(col.notPossible), sign, answer);
    return new Map([[col.possible, cells.possible], [col.notPossible, cells.notPossible]]);
  });

export class PlanStore {
  private file: string;
  private cache: { key: string; plan: Plan } | null = null;
  private queue = serialQueue();
  /** why the last look into OpenCloud failed (the copy on the NAS is shown meanwhile) */
  private syncError: string | null = null;
  private cloud: SyncedFile | null;

  constructor(dir: string, cloud: CloudFile | null = null) {
    this.file = join(dir, 'einsatzplan.xlsx');
    this.cloud = cloud ? new SyncedFile(cloud, CHECK_EVERY_MS, v => this.keep(v.data, v.modified)) : null;
  }

  get source(): 'OpenCloud' | 'NAS' { return this.cloud ? 'OpenCloud' : 'NAS'; }

  /** A new version from OpenCloud: refused (old copy stays) if it cannot be read, otherwise kept as the copy. */
  private async keep(data: Uint8Array, modified: string) {
    await readPlanXlsx(new Blob([data as Uint8Array<ArrayBuffer>]));
    await writeAtomic(this.file, data);
    this.cache = null; // two versions may share size and (whole-second) time
    if (modified) await utimes(this.file, new Date(modified), new Date(modified)); // "Stand" = last change in OpenCloud
  }

  /** Brings the copy up to date with OpenCloud (at most every few minutes unless `force`). Never throws. */
  async sync(force = false) {
    if (!this.cloud) return;
    try {
      await this.cloud.get(force);
      this.syncError = null;
    } catch (e) {
      const message = e instanceof PlanFormatError ? `kann nicht gelesen werden (${e.message})` : describeStoreError(e);
      if (message !== this.syncError) console.error(`Einsatzplan aus OpenCloud: ${message}`);
      this.syncError = message;
    }
  }

  /** null if there is no plan yet. Throws PlanFormatError if the file on the NAS is broken. */
  async read(): Promise<{ plan: Plan; updated: string; syncError: string | null } | null> {
    await this.sync();
    let s;
    try { s = await stat(this.file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const key = `${s.mtimeMs}:${s.size}`;
    if (this.cache?.key !== key) {
      const { entries, names } = await readPlanXlsx(new Blob([new Uint8Array(await readFile(this.file))]));
      this.cache = { key, plan: { entries, names } };
    }
    return { plan: this.cache.plan, updated: s.mtime.toISOString(), syncError: this.syncError };
  }

  /** Checks the upload and replaces the plan. Throws PlanFormatError (the old plan stays) if it cannot be read. */
  async importXlsx(buf: Buffer): Promise<{ dates: number; hidden: number }> {
    if (this.cloud) throw new PlanReadOnly();
    const { entries, hidden } = await readPlanXlsx(new Blob([new Uint8Array(buf)]));
    await writeAtomic(this.file, buf);
    return { dates: entries.length, hidden };
  }

  /** Enters who mixes on `date` (empty: nobody). */
  assign(date: string, mischer: string): Promise<void> {
    return this.change(data => setMischer(data, date, mischer));
  }

  /** Enters whether `sign` can mix on `date` (null: answer withdrawn). */
  answer(date: string, sign: string, answer: Availability | null): Promise<void> {
    return this.change(data => setAvailability(data, date, sign, answer));
  }

  /**
   * Changes the plan with `edit` – in OpenCloud, unless someone changed the file meanwhile (then once more on the
   * new version), or in the local plan. One change at a time.
   */
  private change(edit: (data: Uint8Array) => Uint8Array): Promise<void> {
    return this.queue(async () => {
      if (!this.cloud) {
        let data: Uint8Array;
        try { data = await readFile(this.file); } catch { throw new PlanDateMissing('no plan'); }
        await writeAtomic(this.file, edit(data));
        this.cache = null;
        return;
      }
      for (let attempt = 0; ; attempt++) {
        const current = await this.cloud.file.get();
        try {
          await this.cloud.file.put(edit(current.data), current.etag);
          break;
        } catch (e) {
          if (!(e instanceof StoreError && e.message === 'changed') || attempt > 0) throw e;
        }
      }
      // shown at once; a failure to read it back is no failure of the assignment (it is reported like any other)
      await this.sync(true);
    });
  }
}
