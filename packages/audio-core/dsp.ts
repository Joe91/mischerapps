// Block-wise DSP building blocks. All processors keep their state between calls,
// so a long signal can be streamed through them in arbitrary chunk sizes.

export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

export interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number; }

/** Transposed direct form II biquad, one state per channel. */
export class Biquad {
  private z1: Float64Array;
  private z2: Float64Array;
  constructor(public c: BiquadCoeffs, channels = 1) {
    this.z1 = new Float64Array(channels);
    this.z2 = new Float64Array(channels);
  }
  process(x: Float32Array, ch = 0, out: Float32Array = x): Float32Array {
    const { b0, b1, b2, a1, a2 } = this.c;
    let z1 = this.z1[ch], z2 = this.z2[ch];
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      out[i] = y;
    }
    this.z1[ch] = z1; this.z2[ch] = z2;
    return out;
  }
}

/** RBJ cookbook low/high pass. */
export function rbj(type: 'lowpass' | 'highpass', f0: number, q: number, sr: number): BiquadCoeffs {
  const w = (2 * Math.PI * f0) / sr, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = type === 'lowpass' ? 1 - cw : -(1 + cw);
  const b0 = type === 'lowpass' ? b1 / 2 : -b1 / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

/** 4th-order Butterworth as two cascaded biquads. */
export class Butterworth4 {
  private s1: Biquad;
  private s2: Biquad;
  constructor(type: 'lowpass' | 'highpass', f0: number, sr: number, channels = 1) {
    this.s1 = new Biquad(rbj(type, f0, 0.5412, sr), channels);
    this.s2 = new Biquad(rbj(type, f0, 1.3066, sr), channels);
  }
  process(x: Float32Array, ch = 0): Float32Array {
    return this.s2.process(this.s1.process(x, ch), ch);
  }
}

/**
 * Gentle feed-forward compressor (stereo linked) with soft knee.
 * Used after the pre-gain, so the threshold can be given relative to the loudness target.
 */
export class Compressor {
  private env = 0;
  private atk: number;
  private rel: number;
  constructor(private thresholdDb: number, private ratio: number, sr: number,
    attackMs = 20, releaseMs = 250, private kneeDb = 6) {
    this.atk = Math.exp(-1 / ((attackMs / 1000) * sr));
    this.rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
  }
  process(chs: Float32Array[]): void {
    const n = chs[0].length, T = this.thresholdDb, R = this.ratio, K = this.kneeDb;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (const c of chs) p = Math.max(p, c[i] * c[i]);
      env = p > env ? this.atk * env + (1 - this.atk) * p : this.rel * env + (1 - this.rel) * p;
      const lvl = 10 * Math.log10(env + 1e-20);
      const over = lvl - T;
      let red = 0;
      if (over > K / 2) red = over * (1 - 1 / R);
      else if (over > -K / 2) red = ((1 - 1 / R) * (over + K / 2) ** 2) / (2 * K);
      if (red > 0) {
        const g = Math.pow(10, -red / 20);
        for (const c of chs) c[i] *= g;
      }
    }
    this.env = env;
  }
}

/**
 * Look-ahead peak limiter (stereo linked). The gain is a sliding minimum over the
 * look-ahead window, released exponentially and then box-smoothed over the same
 * window, which guarantees no sample exceeds the ceiling without hard gain steps.
 * Output is delayed by `latency` samples; call flush() at the end.
 */
export class Limiter {
  readonly latency: number;
  private L: number;
  private ceil: number;
  private rel: number;
  private delay: Float32Array[];
  private dPos = 0;
  // monotonic deque for the sliding minimum of required gain
  private qVal: Float64Array;
  private qIdx: Float64Array;
  private qHead = 0;
  private qTail = 0;
  private n = 0;
  private held = 1;
  private box: Float64Array;
  private boxSum: number;
  private boxPos = 0;
  minGain = 1;

  constructor(ceilingDb: number, sr: number, channels: number, lookaheadMs = 5, releaseMs = 100) {
    this.L = Math.max(1, Math.round((lookaheadMs / 1000) * sr));
    this.latency = this.L - 1;
    this.ceil = dbToLin(ceilingDb);
    this.rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.L));
    this.qVal = new Float64Array(this.L + 2);
    this.qIdx = new Float64Array(this.L + 2);
    this.box = new Float64Array(this.L).fill(1);
    this.boxSum = this.L;
  }

  /** Processes in place; the returned arrays are the delayed output (same length as input). */
  process(chs: Float32Array[]): void {
    const L = this.L, cap = L + 2, len = chs[0].length;
    for (let i = 0; i < len; i++) {
      let peak = 0;
      for (const c of chs) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
      const req = peak > this.ceil ? this.ceil / peak : 1;
      // push into min-deque
      while (this.qTail !== this.qHead && this.qVal[(this.qTail - 1 + cap) % cap] >= req) this.qTail = (this.qTail - 1 + cap) % cap;
      this.qVal[this.qTail] = req; this.qIdx[this.qTail] = this.n; this.qTail = (this.qTail + 1) % cap;
      while (this.qIdx[this.qHead] <= this.n - L) this.qHead = (this.qHead + 1) % cap;
      const winMin = this.qVal[this.qHead];
      // release, never above the window minimum
      this.held = Math.min(winMin, 1 - (1 - this.held) * this.rel);
      // box smoothing
      this.boxSum += this.held - this.box[this.boxPos];
      this.box[this.boxPos] = this.held;
      this.boxPos = (this.boxPos + 1) % L;
      const g = this.boxSum / L;
      if (g < this.minGain) this.minGain = g;
      // delay line: output sample from L-1 samples ago
      const rd = (this.dPos + 1) % L;
      for (let c = 0; c < chs.length; c++) {
        const d = this.delay[c];
        d[this.dPos] = chs[c][i];
        chs[c][i] = d[L === 1 ? this.dPos : rd] * g;
      }
      this.dPos = (this.dPos + 1) % L;
      this.n++;
    }
  }

  /** Pushes zeros through to release the delayed tail; returns the tail samples. */
  flush(): Float32Array[] {
    const tail = this.delay.map(() => new Float32Array(this.latency));
    if (this.latency > 0) this.process(tail);
    return tail;
  }
}

/** Raised-cosine fade gain for sample time t (s) inside a clip of the given length. */
export function fadeGain(t: number, length: number, fadeIn: number, fadeOut: number): number {
  let g = 1;
  if (fadeIn > 0 && t < fadeIn) g *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, t)) / fadeIn);
  const tr = length - t;
  if (fadeOut > 0 && tr < fadeOut) g *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, tr)) / fadeOut);
  return g;
}
