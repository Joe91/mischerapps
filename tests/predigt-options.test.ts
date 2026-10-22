import { describe, expect, it } from 'vitest';
import { choices, encodeOptions, processOptions, type Ctx } from '../apps/predigt-schnitt/src/context';
import { defaultSettings, settingsStore, sharedPart, upgradeStored } from '../apps/predigt-schnitt/src/settings';

const ctxWith = (overrides: Record<string, unknown> = {}, settings = defaultSettings()) =>
  ({ settings, state: { start: 10, end: 1800, overrides } }) as unknown as Ctx;

describe('processing defaults', () => {
  it('start with Sprache hoch, high-pass, compression and denoising', () => {
    const s = defaultSettings();
    expect(s.exportPreset).toBe('speech96');
    expect(s.highpass).toBe(true);
    expect(s.compressor).toBe(true);
    expect(s.denoise).toBe(true);
    expect(s.maxGainDb).toBe(30);
    const o = processOptions(ctxWith());
    expect(o).toMatchObject({ channels: 1, targetLufs: -19, highpass: true, compressor: true, denoise: true, maxGainDb: 30, start: 10, end: 1800 });
    expect(encodeOptions(ctxWith())).toEqual({ kbps: 96 });
  });

  it('applies the overrides of one recording on top of the admin defaults', () => {
    const ctx = ctxWith({ exportPreset: 'music128', compressor: false });
    expect(choices(ctx)).toMatchObject({ exportPreset: 'music128', compressor: false, highpass: true, loudnessPreset: 'mono19' });
    expect(processOptions(ctx)).toMatchObject({ channels: 2, compressor: false, highpass: true });
    expect(encodeOptions(ctx)).toEqual({ kbps: 128 });
  });

  it('follows the admin when the defaults change and nothing is overridden', () => {
    const settings = defaultSettings();
    const ctx = ctxWith({}, settings);
    settings.compressor = false;
    expect(choices(ctx).compressor).toBe(false);
  });
});

describe('stored settings', () => {
  // what browsers and the server saved before the defaults changed
  const before = { exportPreset: 'speech64', compressor: false, highpass: true, fadeOut: 1.5, namePattern: 'predigt_eag_{datum}', preacher: 'Pfr. X' };

  it('let the new defaults replace values saved with the old ones', () => {
    expect(upgradeStored(before)).toEqual({ highpass: true, preacher: 'Pfr. X', rev: 3 });
    expect(upgradeStored({ ...before, namePattern: '{datum}_{titel}', fadeOut: 2 })).toMatchObject({ namePattern: '{datum}_{titel}', fadeOut: 2 });
    const s = settingsStore.importJson(JSON.stringify({ settings: before }));
    expect(s).toMatchObject({ exportPreset: 'speech96', compressor: true, fadeOut: 0.5, namePattern: 'predigt-eag-{jjmmdd}', preacher: 'Pfr. X' });
  });

  it('keep what the admin chose after the update', () => {
    const shared = sharedPart({ ...defaultSettings(), exportPreset: 'speech64', compressor: false });
    expect(shared.rev).toBe(3);
    expect(upgradeStored(shared)).toMatchObject({ exportPreset: 'speech64', compressor: false });
  });

  it('switch denoising on and raise the max. gain, unless the admin chose otherwise (rev 2 → 3)', () => {
    expect(upgradeStored({ rev: 2, denoise: false, maxGainDb: 20, compressor: false, exportPreset: 'speech64' }))
      .toEqual({ rev: 3, compressor: false, exportPreset: 'speech64' });
    expect(upgradeStored({ rev: 2, maxGainDb: 25 })).toEqual({ rev: 3, maxGainDb: 25 });
    expect(settingsStore.importJson(JSON.stringify({ settings: { rev: 2, denoise: false, maxGainDb: 20 } })))
      .toMatchObject({ denoise: true, maxGainDb: 30 });
  });

  it('leave an empty server copy empty apart from the revision', () => {
    expect(upgradeStored({})).toEqual({ rev: 3 });
  });
});
