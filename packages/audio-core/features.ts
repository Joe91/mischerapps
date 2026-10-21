// Pass 1 feature extraction: mono input at any sample rate is low-passed and
// resampled to 16 kHz, then cut into 50 ms frames with 25 ms hop.
import { Butterworth4 } from './dsp';
import { FFT } from './fft';

export const FEATURE_SR = 16000;
export const FRAME = 800; // 50 ms
export const HOP = 400; // 25 ms
export const HOP_SEC = HOP / FEATURE_SR;
const NFFT = 1024;
const BIN_LO = Math.round((60 * NFFT) / FEATURE_SR);
const BIN_HI = Math.round((7000 * NFFT) / FEATURE_SR);

export interface Features {
  hopSec: number;
  n: number;
  rmsDb: Float32Array;
  zcr: Float32Array;
  flatness: Float32Array;
  flux: Float32Array;
}

class Grow {
  a = new Float32Array(4096);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

/** Streaming linear-interpolation resampler (input must be band-limited beforehand). */
export class Resampler {
  private step: number;
  private pos = 0;
  private prev = 0;
  constructor(from: number, to: number) { this.step = from / to; }
  process(x: Float32Array): Float32Array {
    // p indexes x; p in [-1, 0) interpolates from the last sample of the previous block
    let p = this.pos, k = 0;
    const out = new Float32Array(Math.max(0, Math.floor((x.length - 1 - p) / this.step) + 2));
    while (p <= x.length - 1 && k < out.length) {
      const i = Math.floor(p), f = p - i;
      const a = i < 0 ? this.prev : x[i];
      const b = f > 0 ? x[i + 1] : a;
      out[k++] = a + (b - a) * f;
      p += this.step;
    }
    this.pos = p - x.length;
    if (x.length) this.prev = x[x.length - 1];
    return k === out.length ? out : out.subarray(0, k);
  }
}

export class FeatureExtractor {
  private lp: Butterworth4 | null;
  private rs: Resampler | null;
  private buf = new Float32Array(1 << 15);
  private bufLen = 0;
  private fft = new FFT(NFFT);
  private re = new Float64Array(NFFT);
  private im = new Float64Array(NFFT);
  private win = new Float64Array(FRAME);
  private prevMag = new Float64Array(BIN_HI);
  private prevValid = false;
  private rms = new Grow();
  private zcr = new Grow();
  private flat = new Grow();
  private flux = new Grow();

  constructor(sampleRate: number) {
    const need = sampleRate !== FEATURE_SR;
    this.lp = need ? new Butterworth4('lowpass', 7000, sampleRate) : null;
    this.rs = need ? new Resampler(sampleRate, FEATURE_SR) : null;
    for (let i = 0; i < FRAME; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  }

  push(mono: Float32Array): void {
    let x = mono;
    if (this.lp && this.rs) x = this.rs.process(this.lp.process(Float32Array.from(mono)));
    if (this.bufLen + x.length > this.buf.length) {
      const b = new Float32Array((this.bufLen + x.length) * 2);
      b.set(this.buf.subarray(0, this.bufLen));
      this.buf = b;
    }
    this.buf.set(x, this.bufLen);
    this.bufLen += x.length;
    let off = 0;
    while (off + FRAME <= this.bufLen) {
      this.frame(this.buf.subarray(off, off + FRAME));
      off += HOP;
    }
    this.buf.copyWithin(0, off, this.bufLen);
    this.bufLen -= off;
  }

  private frame(x: Float32Array) {
    let e = 0, zc = 0;
    for (let i = 0; i < FRAME; i++) {
      e += x[i] * x[i];
      if (i && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
    }
    const rmsDb = 10 * Math.log10(e / FRAME + 1e-12);
    this.rms.push(rmsDb);
    this.zcr.push(zc / FRAME);

    const { re, im } = this;
    for (let i = 0; i < NFFT; i++) { re[i] = i < FRAME ? x[i] * this.win[i] : 0; im[i] = 0; }
    this.fft.transform(re, im);
    let logSum = 0, sum = 0, dot = 0, n1 = 0, n2 = 0;
    for (let k = BIN_LO; k < BIN_HI; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-12;
      logSum += Math.log(p);
      sum += p;
      const m = Math.sqrt(p);
      dot += m * this.prevMag[k]; n1 += m * m; n2 += this.prevMag[k] * this.prevMag[k];
      this.prevMag[k] = m;
    }
    const nb = BIN_HI - BIN_LO;
    this.flat.push(Math.exp(logSum / nb) / (sum / nb));
    const valid = rmsDb > -75;
    this.flux.push(valid && this.prevValid ? 1 - dot / Math.sqrt(n1 * n2 + 1e-24) : 0);
    this.prevValid = valid;
  }

  finish(): Features {
    return { hopSec: HOP_SEC, n: this.rms.n, rmsDb: this.rms.done(), zcr: this.zcr.done(), flatness: this.flat.done(), flux: this.flux.done() };
  }
}

/** Max-abs peaks at a fixed rate for the waveform display. */
export class PeakBuilder {
  private per: number;
  private acc = 0;
  private cnt = 0;
  private out = new Grow();
  constructor(sampleRate: number, peaksPerSec = 50) { this.per = sampleRate / peaksPerSec; }
  push(mono: Float32Array) {
    for (let i = 0; i < mono.length; i++) {
      const a = Math.abs(mono[i]);
      if (a > this.acc) this.acc = a;
      if (++this.cnt >= this.per) { this.out.push(this.acc); this.acc = 0; this.cnt -= this.per; }
    }
  }
  finish(): Float32Array { if (this.cnt > 0) this.out.push(this.acc); return this.out.done(); }
}
