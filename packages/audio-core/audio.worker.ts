// One worker for all heavy passes; it keeps the loaded file and its frame index between calls.
import { blobSource, type ByteSource } from './decode';
import type { Mp3Info } from './mp3-index';
import {
  analyzeSource, denoiseKey, denoiseRange, measure, mp3Reader, render,
  type EncodeOptions, type MeasureHints, type Measurement, type ProcessOptions, type RangeReader,
} from './pipeline';
import type { AnalysisParams } from './analysis';
import { threadCount, workerRunner } from './denoise-pool';
import { loadDenoiser } from '../denoise/denoise';

export type WorkerRequest =
  | { id: number; type: 'analyze'; file: File; params: Partial<AnalysisParams> }
  | { id: number; type: 'measure'; opts: ProcessOptions; encode: EncodeOptions }
  | { id: number; type: 'render'; opts: ProcessOptions; measurement: Measurement; encode: EncodeOptions }
  | { id: number; type: 'denoise'; opts: ProcessOptions }
  /** stops the request `target` at its next progress report; no response */
  | { id: number; type: 'cancel'; target: number };

export type WorkerResponse =
  | { id: number; type: 'progress'; p: number; stage?: string }
  | { id: number; type: 'result'; data: unknown }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let file: File | null = null;
let src: ByteSource | null = null;
let info: Mp3Info | null = null;
let hints: MeasureHints = {};
/** requests in progress; a cancelled one throws at its next progress report */
const running = new Set<number>();
const cancelled = new Set<number>();

/** the denoised cut range, reused by all passes until the range, channels or file change */
let denoised: { key: string; reader: RangeReader } | null = null;

function loaded() {
  if (!file || !src || !info) throw new Error('Keine Datei geladen.');
  return { file, src, info };
}

/** What measure and render read: the MP3 itself, or its denoised copy (made first if needed). */
async function input(o: ProcessOptions, onProgress: (p: number) => void): Promise<RangeReader> {
  const l = loaded();
  if (!o.denoise) return mp3Reader(l.src, l.info, o.start, o.end);
  const key = denoiseKey(o);
  if (denoised?.key === key) return denoised.reader;
  denoised = null; // free the old copy before making the new one
  // in parallel sub-workers; browsers without workers in workers run it here on one core
  const threads = typeof Worker === 'undefined' ? null
    : { workers: threadCount(), runner: workerRunner(l.file, l.info, o.channels, await loadDenoiser()) };
  const reader = await denoiseRange(l.src, l.info, o, onProgress, threads);
  if (src === l.src) denoised = { key, reader }; // unless another file was loaded meanwhile
  return reader;
}

ctx.onmessage = async (e) => {
  const req = e.data;
  if (req.type === 'cancel') {
    if (running.has(req.target)) cancelled.add(req.target);
    return;
  }
  const progress = (stage?: string) => (p: number) => {
    if (cancelled.has(req.id)) throw new Error('abgebrochen');
    ctx.postMessage({ id: req.id, type: 'progress', p, stage });
  };
  running.add(req.id);
  try {
    switch (req.type) {
      case 'analyze': {
        running.forEach(id => { if (id !== req.id) cancelled.add(id); }); // all of it was for the previous file
        file = req.file;
        src = blobSource(req.file);
        info = null;
        hints = {};
        denoised = null;
        const out = await analyzeSource(src, req.params, progress('analyze'));
        info = out.info;
        hints = { loudness: out.loudness };
        ctx.postMessage({ id: req.id, type: 'result', data: out }, [out.peaks.buffer]);
        break;
      }
      case 'measure': {
        const m = await measure(await input(req.opts, progress('denoise')), req.opts, req.encode, hints, progress('measure'));
        ctx.postMessage({ id: req.id, type: 'result', data: m });
        break;
      }
      case 'render': {
        const r = await render(await input(req.opts, progress('denoise')), req.opts, req.measurement, req.encode, progress('render'));
        ctx.postMessage({ id: req.id, type: 'result', data: r }, [r.mp3.buffer]);
        break;
      }
      case 'denoise': {
        await input(req.opts, progress('denoise'));
        ctx.postMessage({ id: req.id, type: 'result', data: null });
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'error', message: (err as Error).message || String(err) });
  } finally {
    running.delete(req.id);
    cancelled.delete(req.id);
  }
};
