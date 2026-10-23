import type { AudioWorkerClient } from '../../../packages/audio-core/client';
import type { AnalyzeOutput, DenoiseRange, EncodeOptions, Measurement, ProcessOptions, RenderResult } from '../../../packages/audio-core/pipeline';
import { CHOICE_KEYS, EXPORT_PRESETS, LOUDNESS_PRESETS, type Choices, type Settings } from './settings';
import type { Meta } from './naming';

export interface Rendered {
  blob: Blob;
  url: string;
  stats: Omit<RenderResult, 'mp3'>;
  /** options the file was rendered with, to detect stale exports */
  key: string;
}

/** The MP3 encoded in advance for the current options, still without tags (added on export). */
export interface Prepared {
  key: string;
  mp3: Uint8Array;
  stats: Omit<RenderResult, 'mp3'>;
}

export interface AppState {
  file: File | null;
  audioUrl: string | null;
  analysis: AnalyzeOutput | null;
  start: number;
  end: number;
  meta: Meta;
  fileName: string;
  fileNameEdited: boolean;
  /** details typed in by hand: the eAg-Übersicht does not overwrite them */
  metaEdited: Set<string>;
  /** advanced view open: the processing options below may differ from the admin's defaults */
  advanced: boolean;
  /** options changed in the advanced view for this recording; everything else follows the defaults */
  overrides: Partial<Choices>;
  measurement: Measurement | null;
  measurementKey: string;
  /** the window the worker holds denoised; serves every cut range inside it */
  denoised: DenoiseRange | null;
  prepared: Prepared | null;
  rendered: Rendered | null;
  uploadedAs: string | null;
}

/** Wizard steps in navigation order (the cut is followed directly by the export: loudness is applied automatically). */
export const STEP = { load: 0, cut: 1, export: 2, upload: 3 } as const;

export interface Step {
  el: HTMLElement;
  enter?(): void;
  leave?(): void;
}

export interface Ctx {
  worker: AudioWorkerClient;
  settings: Settings;
  saveSettings(): void;
  state: AppState;
  goto(step: number): void;
  /** call after markers or processing options changed */
  changed(): void;
  updateNav(): void;
  resetForNewFile(): void;
}

/** The admin's defaults with this recording's overrides on top. */
export function choices(ctx: Ctx): Choices {
  const c = { ...ctx.state.overrides } as Record<string, unknown>;
  for (const k of CHOICE_KEYS) c[k] ??= ctx.settings[k];
  return c as Choices;
}

export function processOptions(ctx: Ctx): ProcessOptions {
  const c = choices(ctx), lp = LOUDNESS_PRESETS[c.loudnessPreset], ep = EXPORT_PRESETS[c.exportPreset];
  return {
    start: ctx.state.start, end: ctx.state.end, channels: ep.channels,
    targetLufs: lp.lufs, truePeakDb: lp.tp, highpass: c.highpass, compressor: c.compressor, denoise: c.denoise, denoiseDb: ctx.settings.denoiseDb,
    fadeIn: c.fadeIn, fadeOut: c.fadeOut, maxGainDb: ctx.settings.maxGainDb,
  };
}

export function encodeOptions(ctx: Ctx): EncodeOptions {
  return { kbps: EXPORT_PRESETS[choices(ctx).exportPreset].kbps };
}

/** Key over everything that influences measurement and encoding (the bitrate affects the peak ceiling). */
export const measurementKey = (o: ProcessOptions, e: EncodeOptions) => JSON.stringify([o, e]);
