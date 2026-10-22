// The Einsatzplan as uploaded by the admin, kept unchanged as dataDir/einsatzplan.xlsx (see packages/plan/plan.ts).
// It is parsed again only when the file changes, so the public GET /api/plan stays cheap. Replacing the file by
// hand on the NAS works too.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readPlanXlsx, PlanFormatError, type Plan } from '../packages/plan/plan';
import { writeAtomic } from './files';

export { PlanFormatError };

export class PlanStore {
  private file: string;
  private cache: { key: string; plan: Plan } | null = null;

  constructor(dir: string) { this.file = join(dir, 'einsatzplan.xlsx'); }

  /** null if no plan was imported yet. Throws PlanFormatError if the file on the NAS is broken. */
  async read(): Promise<{ plan: Plan; updated: string } | null> {
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
    return { plan: this.cache.plan, updated: s.mtime.toISOString() };
  }

  /** Checks the upload and replaces the plan. Throws PlanFormatError (the old plan stays) if it cannot be read. */
  async importXlsx(buf: Buffer): Promise<{ dates: number; hidden: number }> {
    const { entries, hidden } = await readPlanXlsx(new Blob([new Uint8Array(buf)]));
    await writeAtomic(this.file, buf);
    return { dates: entries.length, hidden };
  }
}
