// In-memory copy of a processed signal that later passes replay instead of repeating the work.
import type { BlockFn } from './decode';

const BLOCK = 8192;

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
