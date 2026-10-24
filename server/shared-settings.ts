// Settings the admin sets once for everybody (stored in dataDir/settings.json), per app.
// Only known keys of the right type are accepted.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serialQueue, writeAtomic } from './files';

type Kind = 'string' | 'number' | 'boolean';

export const SHARED_SETTINGS: Record<string, Record<string, Kind>> = {
  predigt: {
    loudnessPreset: 'string', exportPreset: 'string', highpass: 'boolean', compressor: 'boolean', denoise: 'boolean', denoiseDb: 'number', dereverbDb: 'number',
    fadeIn: 'number', fadeOut: 'number', maxGainDb: 'number', namePattern: 'string', congregation: 'string',
    preacher: 'string', titlePrefix: 'string', coverDataUrl: 'string', minSermonMin: 'number', mergeGapSec: 'number',
    rev: 'number',
  },
};

/** settings.json exists but cannot be parsed: it is neither used nor overwritten until someone repairs or deletes it. */
export class DamagedSettings extends Error {}

const knownApp = (app: string) => Object.hasOwn(SHARED_SETTINGS, app);

export class SharedSettings {
  private file: string;
  private serialize = serialQueue();
  constructor(dir: string) { this.file = join(dir, 'settings.json'); }

  private async readAll(): Promise<Record<string, Record<string, unknown>>> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    let all: unknown;
    try { all = JSON.parse(text); } catch { all = null; }
    // hand-edited and broken: overwriting it on the next save would lose everything in it
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new DamagedSettings(`${this.file} is damaged (no valid JSON object)`);
    return all as Record<string, Record<string, unknown>>;
  }

  /** null if the app is unknown */
  async get(app: string): Promise<Record<string, unknown> | null> {
    if (!knownApp(app)) return null;
    const all = await this.readAll();
    return Object.hasOwn(all, app) ? all[app] : {};
  }

  /** Keeps only valid keys; returns null if the app is unknown. */
  static sanitize(app: string, input: unknown): Record<string, unknown> | null {
    if (!knownApp(app)) return null;
    const spec = SHARED_SETTINGS[app];
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
    return this.serialize(async () => {
      const all = await this.readAll();
      all[app] = values;
      await writeAtomic(this.file, JSON.stringify(all, null, 2));
    });
  }
}
