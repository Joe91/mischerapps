import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMp3Encoder } from 'wasm-media-encoders';
import { Resampler } from '../packages/audio-core/dsp';
import { PcmStore } from '../packages/audio-core/pcm-store';
import { Mp3Indexer } from '../packages/audio-core/mp3-index';
import { denoiseRange } from '../packages/audio-core/pipeline';
import { Denoiser, loadDenoiser } from '../packages/denoise/denoise';

const wasm = readFileSync(new URL('../packages/denoise/df3.wasm', import.meta.url));

/** Feeds `x` in uneven chunks, then flushes; returns the joined output. */
function stream(x: Float32Array, push: (c: Float32Array) => Float32Array, flush: () => Float32Array) {
  const parts: Float32Array[] = [];
  for (let i = 0, k = 1; i < x.length; i += k, k = (k * 7 + 3) % 5000 + 1) parts.push(push(x.subarray(i, i + k)));
  parts.push(flush());
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

/** Speech-like test signal: harmonics of a gliding pitch, switched on and off like syllables. */
function syllables(sr: number, sec: number) {
  const x = new Float32Array(sr * sec);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, f0 = 140 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
    ph += (2 * Math.PI * f0) / sr;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * ph) / h;
    x[i] = 0.15 * v * (Math.sin(2 * Math.PI * 3.3 * t) > -0.2 ? 1 : 0);
  }
  return x;
}

describe('Resampler', () => {
  const sr = 44100, x = new Float32Array(sr).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr));

  it('converts 44.1 → 48 kHz without delay and with the exact length', () => {
    const rs = new Resampler(sr, 48000, 1);
    const y = stream(x, c => rs.process([c])[0], () => rs.flush()[0]);
    expect(y.length).toBe(Math.ceil((x.length * 48000) / sr));
    let maxErr = 0;
    for (let k = 1000; k < y.length - 1000; k++) maxErr = Math.max(maxErr, Math.abs(y[k] - 0.5 * Math.sin((2 * Math.PI * 1000 * k) / 48000)));
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('gives the same result for any chunking', () => {
    const a = new Resampler(sr, 48000, 1), b = new Resampler(sr, 48000, 1);
    const whole = [...a.process([x])[0], ...a.flush()[0]];
    const chunked = stream(x, c => b.process([c])[0], () => b.flush()[0]);
    expect(chunked).toEqual(Float32Array.from(whole));
  });
});

describe('PcmStore', () => {
  it('replays what was stored, within 16-bit precision of each block', async () => {
    const x = new Float32Array(30000).map((_, i) => Math.sin(i * 0.01) * (i < 15000 ? 0.9 : 0.001));
    const store = new PcmStore(1, 48000);
    store.push([x.subarray(0, 10000)]); store.push([x.subarray(10000)]);
    store.finish();
    const got: number[] = [];
    await store.read(chs => { got.push(...chs[0]); });
    expect(got.length).toBe(x.length);
    // the quiet part keeps its own precision
    expect(Math.abs(got[20000] - x[20000])).toBeLessThan(1e-7);
    expect(Math.max(...got.map((v, i) => Math.abs(v - x[i])))).toBeLessThan(0.9 / 32767);
  });
});

describe('Denoiser', async () => {
  const module = await loadDenoiser(wasm);

  it('lowers steady noise by the attenuation limit, not more', async () => {
    let seed = 1;
    const noise = new Float32Array(48000 * 4).map(() => { seed = (seed * 16807) % 2147483647; return 0.1 * (seed / 2147483647 - 0.5); });
    const df = await Denoiser.create(module, 12);
    const y = stream(noise, c => df.process(c), () => df.flush());
    df.free();
    expect(y.length).toBe(noise.length);
    const db = 20 * Math.log10(rms(y.subarray(48000)) / rms(noise.subarray(48000)));
    expect(db).toBeGreaterThan(-12.5);
    expect(db).toBeLessThan(-9);
  });

  it('keeps speech-like sound in time with the input', async () => {
    const x = syllables(48000, 4);
    const df = await Denoiser.create(module, 12);
    const y = stream(x, c => df.process(c), () => df.flush());
    df.free();
    expect(y.length).toBe(x.length);
    const corr = (lag: number) => { let s = 0; for (let i = 5000; i < x.length - 5000; i++) s += x[i] * y[i + lag]; return s; };
    let best = 0;
    for (let lag = -2000; lag <= 2000; lag++) if (corr(lag) > corr(best)) best = lag;
    expect(Math.abs(best)).toBeLessThanOrEqual(1);
    // the voice itself stays
    expect(rms(y) / rms(x)).toBeGreaterThan(0.7);
  });
});

describe('denoiseRange', () => {
  it('delivers the cut range at 48 kHz with the matching length', async () => {
    await loadDenoiser(wasm);
    const sr = 44100, pcm = syllables(sr, 6);
    const enc = await createMp3Encoder();
    enc.configure({ sampleRate: sr, channels: 1, bitrate: 128 });
    const parts = [enc.encode([pcm]).slice(), enc.finalize().slice()];
    const mp3 = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { mp3.set(p, o); o += p.length; }
    const idx = new Mp3Indexer();
    idx.push(mp3);
    const info = idx.finish();
    const src = { size: mp3.length, read: async (off: number, len: number) => mp3.subarray(off, off + len) };

    const progress: number[] = [];
    const reader = await denoiseRange(src, info, { start: 1, end: 4.5, channels: 2 }, p => progress.push(p));
    expect(reader.sampleRate).toBe(48000);
    expect(progress.at(-1)).toBe(1);
    let n = 0, chans = 0;
    await reader.read(chs => { n += chs[0].length; chans = chs.length; });
    expect(chans).toBe(2);
    expect(n).toBe(Math.ceil(((Math.round(4.5 * sr) - Math.round(1 * sr)) * 48000) / sr));
  });
});
