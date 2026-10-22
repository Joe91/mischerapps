import type { AudioWorkerClient } from '../../../packages/audio-core/client';
import type { AnalyzeOutput, EncodeOptions, Measurement, ProcessOptions, RenderResult } from '../../../packages/audio-core/pipeline';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, type Settings } from './settings';
import type { Meta } from './naming';

export interface Rendered {
  blob: Blob;
  url: string;
  stats: Omit<RenderResult, 'mp3'>;
  /** options the file was rendered with, to detect stale exports */
  key: string;
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
  measurement: Measurement | null;
  measurementKey: string;
  rendered: Rendered | null;
  uploadedAs: string | null;
}

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

export function processOptions(ctx: Ctx): ProcessOptions {
  const s = ctx.settings, lp = LOUDNESS_PRESETS[s.loudnessPreset], ep = EXPORT_PRESETS[s.exportPreset];
  return {
    start: ctx.state.start, end: ctx.state.end, channels: ep.channels,
    targetLufs: lp.lufs, truePeakDb: lp.tp, highpass: s.highpass, compressor: s.compressor,
    fadeIn: s.fadeIn, fadeOut: s.fadeOut, maxGainDb: s.maxGainDb,
  };
}

export function encodeOptions(ctx: Ctx): EncodeOptions {
  return { kbps: EXPORT_PRESETS[ctx.settings.exportPreset].kbps };
}

/** Key over everything that influences the measurement (the bitrate affects the peak ceiling). */
export const measurementKey = (o: ProcessOptions, e: EncodeOptions) => JSON.stringify([o, e]);
