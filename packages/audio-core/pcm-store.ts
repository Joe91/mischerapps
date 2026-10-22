// In-memory copy of a processed signal that later passes replay instead of repeating the work.
import type { BlockFn } from './decode';

const BLOCK = 8192;

/** A finished store as plain data, to send it to another worker (the sample arrays can be transferred). */
export interface PcmDump { channels: number; sampleRate: number; length: number; blocks: { data: Int16Array[]; scale: Float32Array }[]; }

/**
 * 16-bit samples with one scale per block and channel: half the memory of Float32 (30 min mono at
 * 48 kHz: 170 MB), with the quantisation noise ~96 dB below each block's peak – far below what any
 * gain of the export chain could lift into audibility.
 */
export class PcmStore {
  private blocks: { data: Int16Array[]; scale: Float32Array }[] = [];
  private cur: Float32Array[];
  private fill = 0;
  length = 0;

  constructor(readonly channels: number, readonly sampleRate: number) {
    this.cur = Array.from({ length: channels }, () => new Float32Array(BLOCK));
  }

  push(chs: Float32Array[]) {
    const n = chs[0].length;
    for (let i = 0; i < n;) {
      const k = Math.min(BLOCK - this.fill, n - i);
      this.cur.forEach((c, ch) => c.set(chs[ch].subarray(i, i + k), this.fill));
      this.fill += k; i += k;
      if (this.fill === BLOCK) this.seal();
    }
    this.length += n;
  }

  static load(d: PcmDump): PcmStore {
    const s = new PcmStore(d.channels, d.sampleRate);
    s.blocks = d.blocks;
    s.length = d.length;
    return s;
  }

  dump(): PcmDump {
    return { channels: this.channels, sampleRate: this.sampleRate, length: this.length, blocks: this.blocks };
  }

  /** Stores the last partial block; call once after the last push(). */
  finish() {
    if (this.fill) this.seal();
  }

  private seal() {
    const n = this.fill, scale = new Float32Array(this.channels);
    const data = this.cur.map((c, ch) => {
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]));
      const s = peak > 0 ? peak / 32767 : 1, inv = 1 / s, q = new Int16Array(n);
      for (let i = 0; i < n; i++) q[i] = Math.round(c[i] * inv);
      scale[ch] = s;
      return q;
    });
    this.blocks.push({ data, scale });
    this.fill = 0;
  }

  /** Delivers the stored signal block by block, like decodeRange(). */
  async read(onBlock: BlockFn, onProgress?: (p: number) => void) {
    let done = 0;
    for (const [b, { data, scale }] of this.blocks.entries()) {
      await onBlock(data.map((q, ch) => {
        const s = scale[ch], x = new Float32Array(q.length);
        for (let i = 0; i < q.length; i++) x[i] = q[i] * s;
        return x;
      }), this.sampleRate);
      done += data[0].length;
      onProgress?.(done / this.length);
      // yield now and then, like the decoder does while reading the file
      if (b % 64 === 63) await new Promise(r => setTimeout(r, 0));
    }
  }
}

/**
 * Reads stores one after another as one signal; each store's first `fade` samples overlap the
 * previous store's last ones and are crossfaded linearly (the parts are nearly identical there).
 */
export async function readJoined(parts: PcmStore[], fade: number, onBlock: BlockFn, onProgress?: (p: number) => void) {
  const total = parts.reduce((a, p) => a + p.length, 0) - fade * (parts.length - 1);
  let held: Float32Array[] = [], done = 0;
  for (const [k, part] of parts.entries()) {
    const fadeEnd = k > 0 ? fade : 0;
    const holdFrom = k < parts.length - 1 ? part.length - fade : part.length;
    const next = k < parts.length - 1 ? Array.from({ length: part.channels }, () => new Float32Array(fade)) : [];
    let pos = 0;
    await part.read(async chs => {
      const a = pos, b = pos + chs[0].length;
      pos = b;
      // [a, b) split into: crossfade with the previous part | as is | held back for the next part
      const f1 = Math.min(b, fadeEnd), h0 = Math.max(a, holdFrom);
      for (const [ch, c] of chs.entries()) if (h0 < b) next[ch].set(c.subarray(h0 - a), h0 - holdFrom);
      const out: Float32Array[] = [];
      if (a < f1) {
        out.push(...chs.map((c, ch) => {
          const x = new Float32Array(f1 - a), prev = held[ch];
          for (let t = a; t < f1; t++) { const w = (t + 0.5) / fade; x[t - a] = prev[t] * (1 - w) + c[t - a] * w; }
          return x;
        }));
        await onBlock(out, part.sampleRate);
      }
      const d0 = Math.max(a, f1), d1 = Math.min(b, holdFrom);
      if (d0 < d1) await onBlock(chs.map(c => c.subarray(d0 - a, d1 - a)), part.sampleRate);
      done += Math.max(0, Math.min(b, holdFrom) - a);
      onProgress?.(Math.min(1, done / total));
    });
    held = next;
  }
}
