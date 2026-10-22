// Integrated loudness after ITU-R BS.1770-4 / EBU R128 and true-peak estimation.
import type { BiquadCoeffs } from './dsp';

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

/** Gated integrated loudness (LUFS) from 100 ms mean-square sub-blocks (BS.1770: 400 ms blocks, 75 % overlap). */
export function integrateSubBlocks(sb: ArrayLike<number>, from = 0, to = sb.length): number {
  const lk = (z: number) => -0.691 + 10 * Math.log10(z);
  let sumAbs = 0, nAbs = 0;
  const blocks: number[] = [];
  for (let i = from; i + 4 <= to; i++) {
    const z = (sb[i] + sb[i + 1] + sb[i + 2] + sb[i + 3]) / 4;
    if (lk(z) > -70) { blocks.push(z); sumAbs += z; nAbs++; }
  }
  if (!nAbs) return -Infinity;
  const relThr = lk(sumAbs / nAbs) - 10;
  let sum = 0, n = 0;
  for (const z of blocks) if (lk(z) > relThr) { sum += z; n++; }
  return lk(sum / n);
}

export class LoudnessMeter {
  private c: Float64Array; // shelf b0 b1 b2 a1 a2, high-pass b0 b1 b2 a1 a2
  private z: Float64Array; // 4 states per channel
  private sub: number; // samples per 100 ms sub-block
  private acc = 0;
  private accN = 0;
  private blocks = new Float32Array(1024);
  private nBlocks = 0;
  samplePeak = 0;

  constructor(sr: number, private channels: number) {
    const [s, h] = kWeighting(sr);
    this.c = Float64Array.of(s.b0, s.b1, s.b2, s.a1, s.a2, h.b0, h.b1, h.b2, h.a1, h.a2);
    this.z = new Float64Array(4 * channels);
    this.sub = Math.round(sr / 10);
  }

  push(chs: Float32Array[]): void {
    const [sb0, sb1, sb2, sa1, sa2, hb0, hb1, hb2, ha1, ha2] = this.c;
    const z = this.z, nch = Math.min(this.channels, chs.length), n = chs[0].length, sub = this.sub;
    const x0 = chs[0], x1 = nch > 1 ? chs[1] : null;
    let a0 = z[0], a1 = z[1], a2 = z[2], a3 = z[3];
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
    if (x1) { b0 = z[4]; b1 = z[5]; b2 = z[6]; b3 = z[7]; }
    let acc = this.acc, accN = this.accN, peak = this.samplePeak;
    for (let i = 0; i < n; i++) {
      // channel 0: shelf then high-pass (transposed direct form II)
      let v = x0[i];
      let av = v < 0 ? -v : v;
      if (av > peak) peak = av;
      let y = sb0 * v + a0; a0 = sb1 * v - sa1 * y + a1; a1 = sb2 * v - sa2 * y;
      let w = hb0 * y + a2; a2 = hb1 * y - ha1 * w + a3; a3 = hb2 * y - ha2 * w;
      let e = w * w;
      if (x1) {
        v = x1[i];
        av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        y = sb0 * v + b0; b0 = sb1 * v - sa1 * y + b1; b1 = sb2 * v - sa2 * y;
        w = hb0 * y + b2; b2 = hb1 * y - ha1 * w + b3; b3 = hb2 * y - ha2 * w;
        e += w * w;
      }
      acc += e;
      if (++accN === sub) {
        if (this.nBlocks === this.blocks.length) { const nb = new Float32Array(this.blocks.length * 2); nb.set(this.blocks); this.blocks = nb; }
        this.blocks[this.nBlocks++] = acc / sub;
        acc = 0; accN = 0;
      }
    }
    z[0] = a0; z[1] = a1; z[2] = a2; z[3] = a3;
    if (x1) { z[4] = b0; z[5] = b1; z[6] = b2; z[7] = b3; }
    this.acc = acc; this.accN = accN; this.samplePeak = peak;
  }

  /** 100 ms mean-square sub-blocks (K-weighted, summed over channels). */
  subBlocks(): Float32Array { return this.blocks.slice(0, this.nBlocks); }

  /** Gated integrated loudness in LUFS (-Infinity for silence). */
  integrated(): number { return integrateSubBlocks(this.blocks, 0, this.nBlocks); }
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
