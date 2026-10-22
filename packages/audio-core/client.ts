// Main-thread wrapper around audio.worker.ts with promise-based calls and progress callbacks.
import type { WorkerRequest, WorkerResponse } from './audio.worker';
import type { AnalyzeOutput, EncodeOptions, Measurement, ProcessOptions, RenderResult } from './pipeline';
import type { AnalysisParams } from './analysis';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: number) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class AudioWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./audio.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data, p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.onProgress?.(msg.p);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.data);
        else p.reject(new Error(msg.message));
      }
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Fehler im Verarbeitungs-Worker');
      this.pending.forEach(p => p.reject(err));
      this.pending.clear();
    };
  }

  private call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, onProgress?: (p: number) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id });
    });
  }

  analyze(file: File, params: Partial<AnalysisParams>, onProgress?: (p: number) => void) {
    return this.call<AnalyzeOutput>({ type: 'analyze', file, params }, onProgress);
  }
  measure(opts: ProcessOptions, encode: EncodeOptions, onProgress?: (p: number) => void) {
    return this.call<Measurement>({ type: 'measure', opts, encode }, onProgress);
  }
  /** Encodes without tags (see tags.ts), so the file can be prepared before the details are known. */
  render(opts: ProcessOptions, measurement: Measurement, encode: EncodeOptions, onProgress?: (p: number) => void) {
    return this.call<RenderResult>({ type: 'render', opts, measurement, encode }, onProgress);
  }

  /** Aborts all running work by restarting the worker. */
  restart(): AudioWorkerClient {
    this.worker.terminate();
    this.pending.forEach(p => p.reject(new Error('abgebrochen')));
    this.pending.clear();
    return new AudioWorkerClient();
  }
}
