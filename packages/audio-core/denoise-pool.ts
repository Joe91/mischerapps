// Runs the denoising segments in parallel Web Workers, one model per thread (browser only).
import { PcmStore } from './pcm-store';
import type { AudioInfo } from './decode';
import type { SegmentRunner } from './pipeline';
import type { DenoiseJob, DenoiseReply } from './denoise.worker';

/**
 * Threads for denoising. It scales with the physical cores (6-core Ryzen: 6.5× real time on one,
 * 36× on six); hyper-threads add nothing but do not hurt either, and the browser only reports
 * logical cores. One stays free for the page.
 */
export function threadCount(): number {
  return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 1) - 1));
}

/** Each worker takes the next segment when it is done with one; aborting via `onProgress` throwing stops all. */
export function workerRunner(file: File, info: AudioInfo, module: WebAssembly.Module): SegmentRunner {
  return (segments, cfg, onProgress) => new Promise<PcmStore[]>((resolve, reject) => {
    const stores: PcmStore[] = new Array(segments.length);
    const done = segments.map(() => 0);
    const workers: Worker[] = [];
    let next = 0, finished = 0, over = false;
    const stop = () => { over = true; workers.forEach(w => w.terminate()); };
    const fail = (err: Error) => { if (!over) { stop(); reject(err); } };

    const startNext = (w: Worker) => {
      if (next >= segments.length) { w.terminate(); return; }
      const i = next++;
      w.onmessage = (e: MessageEvent<DenoiseReply>) => {
        if (over) return;
        const m = e.data;
        try {
          if (m.type === 'progress') {
            done[i] = m.done;
            onProgress(done.reduce((a, d) => a + d, 0));
          } else if (m.type === 'result') {
            stores[i] = PcmStore.load(m.dump);
            done[i] = segments[i].to - segments[i].from;
            if (++finished === segments.length) { stop(); resolve(stores); } else startNext(w);
          } else fail(new Error(m.message));
        } catch (err) {
          fail(err as Error); // cancelled
        }
      };
      w.postMessage({ file, info, seg: segments[i], cfg, module } satisfies DenoiseJob);
    };

    for (let k = 0; k < Math.min(threadCount(), segments.length); k++) {
      const w = new Worker(new URL('./denoise.worker.ts', import.meta.url), { type: 'module' });
      w.onerror = e => fail(new Error(e.message || 'Fehler im Filter-Worker'));
      workers.push(w);
      startNext(w);
    }
  });
}
