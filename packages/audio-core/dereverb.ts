// Late reverberation suppression (Lebart et al. 2001, Habets 2009), a stage after DeepFilterNet: the model clears the
// reverb in the pauses but leaves much of it under the voice. Here the late reverb in each band is predicted from the
// signal `delayMs` earlier, decayed as in a room with reverberation time `t60`, and that share is taken away – at most
// `maxDb`. Gains are smoothed over time against "musical noise". On the sermons it shortened the decay after syllables
// from about 105–140 ms to 80–120 ms at 10 dB, the default (DEREVERB_DB), which was preferred in a blind test.

import { FFT } from './fft';

const N = 1024, H = 256, K = N / 2 + 1;

/** One channel, streaming. Output has the same length and timing as the input (the STFT latency is removed). */
export class Dereverb {
  private fft = new FFT(N);
  /** sqrt-Hann for analysis and synthesis: with 75 % overlap their product sums to 2 */
  private win = new Float64Array(N).map((_, i) => Math.sin(Math.PI * (i + 0.5) / N));
  /** the last N input samples, and the overlap-add sum over the same span */
  private frame = new Float64Array(N);
  private ola = new Float64Array(N);
  private fill = N - H;
  private re = new Float64Array(N);
  private im = new Float64Array(N);
  /** smoothed power per band, for the last `nd + 1` frames (ring), and the smoothed gains */
  private power: Float64Array[];
  private at = 0;
  private gains = new Float64Array(K).fill(1);
  private nd: number;
  private decay: number;
  private gMin: number;
  /** samples of the start that the latency pushes out, still to drop */
  private skip = N - H;
  private inCount = 0;
  private outCount = 0;

  constructor(sampleRate: number, maxDb: number, { t60 = 1.0, delayMs = 50 } = {}) {
    this.nd = Math.max(1, Math.round((delayMs / 1000) * sampleRate / H));
    this.decay = Math.exp(-13.8155 * (this.nd * H / sampleRate) / t60); // energy after the delay: −60 dB per t60
    this.gMin = 10 ** (-maxDb / 10);
    this.power = Array.from({ length: this.nd + 1 }, () => new Float64Array(K));
  }

  process(input: Float32Array): Float32Array {
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length;) {
      const k = Math.min(N - this.fill, input.length - i);
      for (let j = 0; j < k; j++) this.frame[this.fill + j] = input[i + j];
      this.fill += k; i += k;
      if (this.fill === N) parts.push(this.run());
    }
    this.inCount += input.length;
    return this.emit(parts);
  }

  /** Pushes silence through to release the delayed end of the signal. */
  flush(): Float32Array {
    const parts: Float32Array[] = [];
    // each frame completes H more samples; the first N − H of them lie before the start
    while (this.at * H - (N - H) < this.inCount) {
      this.frame.fill(0, this.fill);
      this.fill = N;
      parts.push(this.run());
    }
    return this.emit(parts);
  }

  /** One STFT frame: gains for the predicted late reverb, overlap-add; returns the H samples now complete. */
  private run(): Float32Array {
    const { re, im, win, fft } = this;
    for (let i = 0; i < N; i++) { re[i] = this.frame[i] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    const now = this.power[this.at % this.power.length], before = this.at >= this.nd ? this.power[(this.at - this.nd) % this.power.length] : null;
    const prev = this.power[(this.at + this.power.length - 1) % this.power.length];
    for (let k = 0; k < K; k++) {
      now[k] = 0.5 * (this.at ? prev[k] : 0) + 0.5 * (re[k] * re[k] + im[k] * im[k]);
      const late = before ? this.decay * before[k] : 0;
      const g = Math.max(this.gMin, Math.min(1, 1 - late / (now[k] + 1e-20)));
      // fall gently, recover quickly
      this.gains[k] = g < this.gains[k] ? 0.5 * this.gains[k] + 0.5 * g : 0.3 * this.gains[k] + 0.7 * g;
      const a = Math.sqrt(this.gains[k]);
      re[k] *= a; im[k] *= a;
      if (k > 0 && k < N / 2) { re[N - k] *= a; im[N - k] *= a; }
    }
    this.at++;
    // inverse FFT by conjugation
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fft.transform(re, im);
    for (let i = 0; i < N; i++) this.ola[i] += (re[i] / N) * win[i] * (2 * H / N);
    const done = Float32Array.from(this.ola.subarray(0, H));
    this.ola.copyWithin(0, H);
    this.ola.fill(0, N - H);
    this.frame.copyWithin(0, H);
    this.fill = N - H;
    return done;
  }

  private emit(parts: Float32Array[]): Float32Array {
    let total = parts.reduce((a, p) => a + p.length, 0);
    const drop = Math.min(this.skip, total);
    this.skip -= drop;
    total = Math.min(total - drop, this.inCount - this.outCount);
    const out = new Float32Array(total);
    let o = 0, d = drop;
    for (const p of parts) {
      const from = Math.min(d, p.length);
      d -= from;
      const n = Math.min(p.length - from, total - o);
      out.set(p.subarray(from, from + n), o);
      o += n;
    }
    this.outCount += total;
    return out;
  }
}
