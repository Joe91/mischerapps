import { describe, expect, it } from 'vitest';
import { Dereverb } from '../packages/audio-core/dereverb';

const SR = 48000;

/** Feeds `x` in uneven chunks, then flushes; returns the joined output. */
function run(d: Dereverb, x: Float32Array) {
  const parts: Float32Array[] = [];
  for (let i = 0, k = 1; i < x.length; i += k, k = (k * 7 + 3) % 5000 + 1) parts.push(d.process(x.subarray(i, i + k)));
  parts.push(d.flush());
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

let seed = 1;
const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

/** Bursts of "speech" (noise) of 200 ms every 600 ms, in a room with a reverb tail of `t60` seconds. */
function reverberant(t60: number, sec = 6) {
  const dry = new Float32Array(SR * sec);
  for (let i = 0; i < dry.length; i++) if ((i / SR) % 0.6 < 0.2) dry[i] = 0.3 * noise();
  const ir = new Float32Array(Math.round(SR * t60)).map((_, i) => (i ? 0.08 * noise() : 1) * Math.exp(-6.9 * i / (SR * t60)));
  const wet = new Float32Array(dry.length);
  // sparse convolution: the direct sound and a few hundred reflections suffice
  const taps = [0, ...Array.from({ length: 400 }, (_, k) => Math.round((k + 1) * ir.length / 401))];
  for (const t of taps) { const g = ir[t]; for (let i = 0; i + t < wet.length; i++) wet[i + t] += g * dry[i]; }
  return { dry, wet };
}

const energy = (x: Float32Array, a: number, b: number) => { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return e; };

describe('Dereverb', () => {
  it('gives the input back unchanged when it may take nothing away, in any chunks', () => {
    const x = new Float32Array(SR * 2).map(noise);
    const y = run(new Dereverb(SR, 0), x);
    expect(y.length).toBe(x.length);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    expect(err).toBeLessThan(1e-6);
  });

  it('lowers the reverb after the bursts and keeps the bursts', () => {
    const { wet } = reverberant(1.0);
    const y = run(new Dereverb(SR, 10), wet);
    expect(y.length).toBe(wet.length);
    let tailBefore = 0, tailAfter = 0, burstBefore = 0, burstAfter = 0;
    // from the third burst on (the stage needs the past to predict the reverb)
    for (let s = 1.2; s + 0.6 <= 6; s += 0.6) {
      const b0 = Math.round(s * SR), b1 = Math.round((s + 0.2) * SR), t1 = Math.round((s + 0.55) * SR);
      burstBefore += energy(wet, b0, b1); burstAfter += energy(y, b0, b1);
      tailBefore += energy(wet, b1 + SR / 20, t1); tailAfter += energy(y, b1 + SR / 20, t1);
    }
    const db = (a: number, b: number) => 10 * Math.log10(a / b);
    // measured: tails −5.6 dB, bursts −1.5 dB (the loudness normalisation afterwards makes up for the level)
    expect(db(tailAfter, tailBefore)).toBeLessThan(-4.5);
    expect(db(burstAfter, burstBefore)).toBeGreaterThan(-2.5);
    expect(db(tailAfter, tailBefore) - db(burstAfter, burstBefore)).toBeLessThan(-3.5); // the reverb goes, much more than the "speech"
  });
});
