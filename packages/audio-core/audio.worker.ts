// One worker for all heavy passes; it keeps the loaded file and its frame index between calls.
import { blobSource, type ByteSource } from './decode';
import type { Mp3Info } from './mp3-index';
import { analyzeSource, measure, render, tagMp3, type EncodeOptions, type Measurement, type ProcessOptions, type Tags } from './pipeline';
import type { AnalysisParams } from './analysis';

export type WorkerRequest =
  | { id: number; type: 'analyze'; file: File; params: Partial<AnalysisParams> }
  | { id: number; type: 'measure'; opts: ProcessOptions }
  | { id: number; type: 'render'; opts: ProcessOptions; measurement: Measurement; encode: EncodeOptions; tags: Tags };

export type WorkerResponse =
  | { id: number; type: 'progress'; p: number; stage?: string }
  | { id: number; type: 'result'; data: unknown }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let src: ByteSource | null = null;
let info: Mp3Info | null = null;

function loaded() {
  if (!src || !info) throw new Error('Keine Datei geladen.');
  return { src, info };
}

ctx.onmessage = async (e) => {
  const req = e.data;
  const progress = (stage?: string) => (p: number) => ctx.postMessage({ id: req.id, type: 'progress', p, stage });
  try {
    switch (req.type) {
      case 'analyze': {
        src = blobSource(req.file);
        info = null;
        const out = await analyzeSource(src, req.params, progress('analyze'));
        info = out.info;
        ctx.postMessage({ id: req.id, type: 'result', data: out }, [out.peaks.buffer]);
        break;
      }
      case 'measure': {
        const l = loaded();
        const m = await measure(l.src, l.info, req.opts, progress('measure'));
        ctx.postMessage({ id: req.id, type: 'result', data: m });
        break;
      }
      case 'render': {
        const l = loaded();
        const r = await render(l.src, l.info, req.opts, req.measurement, req.encode, progress('render'));
        const mp3 = tagMp3(r.mp3, req.tags);
        const data = { ...r, mp3 };
        ctx.postMessage({ id: req.id, type: 'result', data }, [mp3.buffer]);
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'error', message: (err as Error).message || String(err) });
  }
};
