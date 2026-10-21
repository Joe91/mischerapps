// Integrated loudness after ITU-R BS.1770-4 / EBU R128 and true-peak estimation.
import { Biquad, type BiquadCoeffs } from './dsp';

/** K-weighting filter coefficients for any sample rate (derivation as in libebur128). */
export function kWeighting(sr: number): [BiquadCoeffs, BiquadCoeffs] {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: BiquadCoeffs = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp: BiquadCoeffs = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

export class LoudnessMeter {
  private shelf: Biquad;
  private hp: Biquad;
  private sub: number; // samples per 100 ms sub-block
  private acc = 0;
  private accN = 0;
  private subBlocks: number[] = [];
  private tmp = new Float32Array(0);
  samplePeak = 0;

  constructor(sr: number, private channels: number) {
    const [s, h] = kWeighting(sr);
    this.shelf = new Biquad(s, channels);
    this.hp = new Biquad(h, channels);
    this.sub = Math.round(sr / 10);
  }

  push(chs: Float32Array[]): void {
    const n = chs[0].length;
    if (this.tmp.length < n * this.channels) this.tmp = new Float32Array(n * this.channels);
    const filtered: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) {
      const x = chs[c];
      for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > this.samplePeak) this.samplePeak = a; }
      const out = this.tmp.subarray(c * n, (c + 1) * n);
      this.shelf.process(x, c, out);
      this.hp.process(out, c);
      filtered.push(out);
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < this.channels; c++) s += filtered[c][i] * filtered[c][i];
      this.acc += s;
      if (++this.accN === this.sub) { this.subBlocks.push(this.acc / this.sub); this.acc = 0; this.accN = 0; }
    }
  }

  /** Gated integrated loudness in LUFS (-Infinity for silence). */
  integrated(): number {
    const sb = this.subBlocks, blocks: number[] = [];
    for (let i = 0; i + 4 <= sb.length; i++) blocks.push((sb[i] + sb[i + 1] + sb[i + 2] + sb[i + 3]) / 4);
    const lk = (z: number) => -0.691 + 10 * Math.log10(z);
    const abs = blocks.filter(z => lk(z) > -70);
    if (!abs.length) return -Infinity;
    const relThr = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const rel = abs.filter(z => lk(z) > relThr);
    return lk(rel.reduce((a, b) => a + b, 0) / rel.length);
  }
}

/**
 * True-peak meter: 4x oversampling with a windowed-sinc polyphase interpolator.
 * Only evaluates the interpolation where neighbouring samples come within 4 dB of the
 * current maximum, since inter-sample overs beyond that do not occur in practice.
 */
export class TruePeakMeter {
  private static readonly P = 4;
  private static readonly T = 12; // taps per phase
  private static readonly coeffs: Float64Array[] = (() => {
    const { P, T } = TruePeakMeter, N = P * T, out: Float64Array[] = [];
    for (let p = 1; p < P; p++) { // phase 0 reproduces the original samples
      const h = new Float64Array(T);
      for (let t = 0; t < T; t++) {
        const j = t * P + p, x = (j - N / 2) / P;
        h[t] = (Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * j) / N));
      }
      out.push(h);
    }
    return out;
  })();
  private hist: Float64Array[];
  private pos = 0;
  peak = 0;

  constructor(channels: number) {
    this.hist = Array.from({ length: channels }, () => new Float64Array(2 * TruePeakMeter.T));
  }

  push(chs: Float32Array[]): void {
    const { T, coeffs } = TruePeakMeter, mid = T / 2;
    for (let i = 0; i < chs[0].length; i++) {
      for (let c = 0; c < chs.length; c++) {
        const h = this.hist[c], v = chs[c][i];
        h[this.pos] = h[this.pos + T] = v;
        const av = Math.abs(v);
        if (av > this.peak) this.peak = av;
        // newest sample at pos+T; interpolation happens around pos+T-mid
        const base = this.pos + T;
        const near = Math.max(Math.abs(h[base - mid]), Math.abs(h[base - mid + 1]));
        if (near * 1.585 < this.peak) continue;
        for (const co of coeffs) {
          let s = 0;
          for (let t = 0; t < T; t++) s += co[t] * h[base - t];
          const a = Math.abs(s);
          if (a > this.peak) this.peak = a;
        }
      }
      this.pos = (this.pos + 1) % T;
    }
  }
}
