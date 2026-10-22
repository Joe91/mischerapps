// DeepFilterNet3 (df3.wasm, built from wasm/) as a streaming processor: reduces room reverb and
// background noise of speech. The model runs at 48 kHz, one instance per channel.

interface DfExports {
  memory: WebAssembly.Memory;
  df_new(attenLimDb: number): number;
  df_free(st: number): void;
  df_sample_rate(st: number): number;
  df_hop_size(st: number): number;
  df_delay(st: number): number;
  df_capacity(st: number): number;
  df_buffer(st: number): number;
  df_process(st: number, n: number): void;
}

/**
 * Attenuation limit: noise and reverb are lowered by at most this much, the rest stays.
 * 12 dB sounded natural on the sermon recordings; without a limit the pauses became unnaturally dead.
 */
export const DENOISE_ATTEN_DB = 12;
export const DENOISE_RATE = 48000;

let compiled: Promise<WebAssembly.Module> | null = null;

/**
 * Compiles the model once (about 20 MB, 11 MB gzipped; cached by the browser like the other assets).
 * Node scripts and tests pass the file contents, the browser fetches it.
 */
export function loadDenoiser(bytes?: BufferSource): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    try {
      if (bytes) return await WebAssembly.compile(bytes);
      const res = await fetch(new URL('./df3.wasm', import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await WebAssembly.compile(await res.arrayBuffer());
    } catch (e) {
      throw new Error(`Der Filter für Raumklang und Rauschen konnte nicht geladen werden (${(e as Error).message}). ` +
        'Bitte einen aktuellen Browser verwenden oder die Option ausschalten.');
    }
  })();
  compiled.catch(() => { compiled = null; }); // allow a retry
  return compiled;
}

/** One channel. Output has the same length and timing as the input (the model latency is removed). */
export class Denoiser {
  private x: DfExports;
  private st: number;
  private hop: number;
  private cap: number;
  private fill = 0;
  /** model latency still to be dropped from the output */
  private skip: number;
  private delay: number;
  private inCount = 0;
  private outCount = 0;

  private constructor(instance: WebAssembly.Instance, attenDb: number) {
    this.x = instance.exports as unknown as DfExports;
    this.st = this.x.df_new(attenDb);
    this.hop = this.x.df_hop_size(this.st);
    this.cap = this.x.df_capacity(this.st);
    this.skip = this.delay = this.x.df_delay(this.st);
  }

  static async create(module: WebAssembly.Module, attenDb = DENOISE_ATTEN_DB): Promise<Denoiser> {
    return new Denoiser(await WebAssembly.instantiate(module, {}), attenDb);
  }

  /** The model's input buffer; re-created after each call because the WASM memory may have grown. */
  private view() {
    return new Float32Array(this.x.memory.buffer, this.x.df_buffer(this.st), this.cap);
  }

  process(input: Float32Array): Float32Array {
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length;) {
      const k = Math.min(this.cap - this.fill, input.length - i);
      this.view().set(input.subarray(i, i + k), this.fill);
      this.fill += k; i += k;
      if (this.fill === this.cap) parts.push(this.run(this.cap));
    }
    this.inCount += input.length;
    return this.emit(parts);
  }

  /** Pushes silence through to release the delayed end of the signal. */
  flush(): Float32Array {
    const parts: Float32Array[] = [];
    // the pending samples plus the latency, padded with zeros to whole hops
    let need = this.fill + this.delay;
    while (need > 0) {
      const n = Math.min(this.cap, Math.ceil(need / this.hop) * this.hop);
      this.view().fill(0, this.fill, n);
      this.fill = n;
      parts.push(this.run(n));
      need -= n;
    }
    return this.emit(parts);
  }

  free() {
    this.x.df_free(this.st);
  }

  private run(n: number): Float32Array {
    this.x.df_process(this.st, n);
    const out = this.view().slice(0, n);
    this.fill = 0;
    const d = Math.min(this.skip, n);
    this.skip -= d;
    return out.subarray(d);
  }

  /** Joins the parts, never returning more samples than went in. */
  private emit(parts: Float32Array[]): Float32Array {
    const total = Math.min(parts.reduce((a, p) => a + p.length, 0), this.inCount - this.outCount);
    const out = new Float32Array(total);
    let o = 0;
    for (const p of parts) { const k = Math.min(p.length, total - o); out.set(p.subarray(0, k), o); o += k; }
    this.outCount += total;
    return out;
  }
}
