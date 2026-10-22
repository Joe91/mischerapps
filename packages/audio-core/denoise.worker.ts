// Sub-worker of audio.worker.ts: denoises one segment of the cut range per job (see planDenoise).
import { blobSource, type AudioInfo } from './decode';
import { denoiseSegment, type DenoiseSegment } from './pipeline';
import type { PcmDump } from './pcm-store';

export interface DenoiseJob { file: File; info: AudioInfo; seg: DenoiseSegment; channels: 1 | 2; module: WebAssembly.Module; }

export type DenoiseReply =
  | { type: 'progress'; done: number }
  | { type: 'result'; dump: PcmDump }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: DenoiseReply, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<DenoiseJob>) => void) | null;
};

ctx.onmessage = async (e) => {
  const { file, info, seg, channels, module } = e.data;
  try {
    const store = await denoiseSegment(blobSource(file), info, seg, channels, module, done => ctx.postMessage({ type: 'progress', done }));
    const dump = store.dump();
    ctx.postMessage({ type: 'result', dump }, dump.blocks.flatMap(b => [...b.data.map(d => d.buffer), b.scale.buffer]));
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message || String(err) });
  }
};
