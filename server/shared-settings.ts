// Settings the admin sets once for everybody (stored in dataDir/settings.json), per app.
// Only known keys of the right type are accepted.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Kind = 'string' | 'number' | 'boolean';

export const SHARED_SETTINGS: Record<string, Record<string, Kind>> = {
  predigt: {
    loudnessPreset: 'string', exportPreset: 'string', highpass: 'boolean', compressor: 'boolean',
    fadeIn: 'number', fadeOut: 'number', maxGainDb: 'number', namePattern: 'string', congregation: 'string',
    preacher: 'string', titlePrefix: 'string', coverDataUrl: 'string', minSermonMin: 'number', mergeGapSec: 'number',
    rev: 'number',
  },
};

export class SharedSettings {
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private dir: string) { this.file = join(dir, 'settings.json'); }

  private async readAll(): Promise<Record<string, Record<string, unknown>>> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    try { return JSON.parse(text); } catch { return {}; } // hand-edited and broken: start over with the defaults
  }

  async get(app: string): Promise<Record<string, unknown>> {
    return (await this.readAll())[app] ?? {};
  }

  /** Keeps only valid keys; returns null if the app is unknown. */
  static sanitize(app: string, input: unknown): Record<string, unknown> | null {
    const spec = SHARED_SETTINGS[app];
    if (!spec) return null;
    const out: Record<string, unknown> = {};
    if (input && typeof input === 'object') {
      for (const [k, kind] of Object.entries(spec)) {
        const v = (input as Record<string, unknown>)[k];
        if (typeof v === kind && (kind !== 'number' || Number.isFinite(v))) out[k] = v;
      }
    }
    return out;
  }

  set(app: string, values: Record<string, unknown>): Promise<void> {
    const job = async () => {
      const all = await this.readAll();
      all[app] = values;
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(all, null, 2));
      await rename(`${this.file}.tmp`, this.file);
    };
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
