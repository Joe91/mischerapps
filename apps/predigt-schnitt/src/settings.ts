import { createStore } from '../../../packages/settings/store';
import type { EncodeOptions } from '../../../packages/audio-core/pipeline';
import { DENOISE_ATTEN_DB } from '../../../packages/denoise/denoise';
import DEFAULT_COVER from './cover/eag-cover.jpg';

export const LOUDNESS_PRESETS = {
  mono19: { label: 'Podcast Mono (Standard) – −19 LUFS, −1,5 dBTP', lufs: -19, tp: -1.5 },
  stereo16: { label: 'Podcast Stereo – −16 LUFS, −1,0 dBTP', lufs: -16, tp: -1.0 },
  archive23: { label: 'Leise/Archiv (EBU R128) – −23 LUFS, −1,0 dBTP', lufs: -23, tp: -1.0 },
} as const;
export type LoudnessPresetId = keyof typeof LOUDNESS_PRESETS;

export const EXPORT_PRESETS = {
  speech64: { label: 'Sprache Standard – Mono, 64 kbps (≈ 14 MB / 30 min)', channels: 1, kbps: 64 },
  speech96: { label: 'Sprache hoch – Mono, 96 kbps (≈ 21 MB / 30 min)', channels: 1, kbps: 96 },
  music128: { label: 'Mit Musik – Stereo, 128 kbps (≈ 29 MB / 30 min)', channels: 2, kbps: 128 },
} as const satisfies Record<string, { label: string; channels: 1 | 2; kbps: EncodeOptions['kbps'] }>;
export type ExportPresetId = keyof typeof EXPORT_PRESETS;

/** Sound options, labelled the same in the settings dialog and the advanced panel. */
export const SOUND_OPTIONS = {
  highpass: { label: 'Hochpass 80 Hz', hint: 'Entfernt Trittschall, Rumpeln und Brummen – empfohlen für Sprache' },
  compressor: { label: 'Sanfte Kompression 2:1', hint: 'Gleicht unterschiedliche Abstände zum Mikrofon aus' },
  denoise: { label: 'Hall & Rauschen reduzieren', hint: 'KI-Filter: weniger Nachhall des Raums und Hintergrundrauschen – dauert je nach Rechner etwa 1–3 Minuten' },
} as const;
export type SoundOption = keyof typeof SOUND_OPTIONS;

export interface Settings {
  loudnessPreset: LoudnessPresetId;
  exportPreset: ExportPresetId;
  highpass: boolean;
  compressor: boolean;
  denoise: boolean;
  /** how much room sound and noise the denoiser may remove at most (dB) */
  denoiseDb: number;
  fadeIn: number;
  fadeOut: number;
  maxGainDb: number;
  namePattern: string;
  congregation: string;
  preacher: string;
  titlePrefix: string;
  coverDataUrl: string;
  minSermonMin: number;
  mergeGapSec: number;
  /** SETTINGS_REV the values were saved with */
  rev: number;
}

/** The processing options the admin sets as defaults; a recording may override them in the advanced view. */
export const CHOICE_KEYS = ['loudnessPreset', 'exportPreset', 'highpass', 'compressor', 'denoise', 'fadeIn', 'fadeOut'] as const satisfies readonly (keyof Settings)[];
export type Choices = Pick<Settings, typeof CHOICE_KEYS[number]>;

export function defaultSettings(): Settings {
  return {
    loudnessPreset: 'mono19',
    exportPreset: 'speech96',
    highpass: true,
    compressor: true,
    denoise: true, // ≈ 1 min per 30 min on 6 cores, mostly done in the background during the cut step
    denoiseDb: DENOISE_ATTEN_DB,
    fadeIn: 0.5,
    fadeOut: 0.5, // sermons end with "Amen": just enough to avoid a click
    maxGainDb: 55, // desk recordings can be very quiet (−52 LUFS); the denoiser keeps the lifted noise down
    namePattern: 'predigt-eag-{jjmmdd}',
    congregation: '',
    preacher: '',
    titlePrefix: 'Predigt',
    coverDataUrl: '',
    minSermonMin: 8,
    mergeGapSec: 8,
    rev: SETTINGS_REV,
  };
}

/** Raised when changed defaults should replace what browsers and the server saved before. */
export const SETTINGS_REV = 5;

/**
 * Saved values (browser, server, imported file) from an older revision: drops those whose default has
 * changed since, so the new default applies.
 * Rev 2: "Sprache hoch" with compression, fade-out 0.5 s, names predigt-eag-JJMMDD.
 * Rev 3: denoising on, max. gain 30 dB (values still at the old defaults only).
 * Rev 4: max. gain 55 dB (desk recordings at −52 LUFS).
 * Rev 5: denoising strength 18 dB.
 */
export function upgradeStored(stored: unknown): unknown {
  if (!stored || typeof stored !== 'object') return stored;
  const values = { ...stored } as Record<string, unknown>;
  // upload targets (cloud share links with passwords) were kept per browser; the server publishes now
  delete values.profiles;
  delete values.activeProfileId;
  const rev = typeof values.rev === 'number' ? values.rev : 1;
  if (rev >= SETTINGS_REV) return values;
  if (rev < 2) {
    delete values.exportPreset;
    delete values.compressor;
    if (values.fadeOut === 1.5) delete values.fadeOut;
    if (values.namePattern === 'predigt_eag_{datum}') delete values.namePattern;
  }
  if (rev < 3) {
    if (values.denoise === false) delete values.denoise;
    if (values.maxGainDb === 20) delete values.maxGainDb;
  }
  if (rev < 4 && values.maxGainDb === 30) delete values.maxGainDb;
  if (rev < 5 && values.denoiseDb === 12) delete values.denoiseDb;
  return { ...values, rev: SETTINGS_REV };
}

/** The cover of the MP3s: the admin's own picture, otherwise the eAg logo (cover/, made by scripts/make-cover.sh). */
export const coverUrl = (s: Pick<Settings, 'coverDataUrl'>) => s.coverDataUrl || DEFAULT_COVER;

export const settingsStore = createStore<Settings>('audio-tools.predigt-schnitt.settings.v1', defaultSettings, upgradeStored);

/** Keys the admin sets for everybody; they live on the server. */
export const SHARED_KEYS = [
  'loudnessPreset', 'exportPreset', 'highpass', 'compressor', 'denoise', 'denoiseDb', 'fadeIn', 'fadeOut', 'maxGainDb', 'namePattern',
  'congregation', 'preacher', 'titlePrefix', 'coverDataUrl', 'minSermonMin', 'mergeGapSec', 'rev',
] as const satisfies readonly (keyof Settings)[];

export const sharedPart = (s: Settings) => Object.fromEntries(SHARED_KEYS.map(k => [k, s[k]]));

/** Stored or shared values that do not fit (old versions, hand-edited files) fall back to the defaults. */
export function normalizeSettings(s: Settings): Settings {
  const d = defaultSettings();
  if (!(s.loudnessPreset in LOUDNESS_PRESETS)) s.loudnessPreset = d.loudnessPreset;
  if (!(s.exportPreset in EXPORT_PRESETS)) s.exportPreset = d.exportPreset;
  for (const k of ['fadeIn', 'fadeOut', 'maxGainDb', 'denoiseDb', 'minSermonMin', 'mergeGapSec'] as const) {
    if (typeof s[k] !== 'number' || !isFinite(s[k]) || s[k] < 0) s[k] = d[k];
  }
  return s;
}
