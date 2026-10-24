import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMp3Encoder } from 'wasm-media-encoders';
import { Resampler } from '../packages/audio-core/dsp';
import { PcmStore, readJoined } from '../packages/audio-core/pcm-store';
import { Mp3Indexer } from '../packages/audio-core/mp3-index';
import { covers, denoisedPart, denoiseRange, inProcess, planDenoise, sourceReader, type RangeReader } from '../packages/audio-core/pipeline';
import { LoudnessMeter } from '../packages/audio-core/loudness';
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
  }, 30000);

  it('keeps speech-like sound in time with the input', async () => {
    const x = syllables(48000, 4);
    const df = await Denoiser.create(module, 12);
    const y = stream(x, c => df.process(c), () => df.flush());
    df.free();
    expect(y.length).toBe(x.length);
    // every 4th sample is plenty to find the offset of a speech-like signal (and keeps the test fast on slow CI machines)
    const corr = (lag: number) => { let s = 0; for (let i = 5000; i < x.length - 5000; i += 4) s += x[i] * y[i + lag]; return s; };
    let best = 0, bestCorr = -Infinity;
    for (let lag = -2000; lag <= 2000; lag++) { const c = corr(lag); if (c > bestCorr) { bestCorr = c; best = lag; } }
    expect(Math.abs(best)).toBeLessThanOrEqual(1);
    // the voice itself stays
    expect(rms(y) / rms(x)).toBeGreaterThan(0.7);
  }, 30000);
});

async function mp3Of(pcm: Float32Array, sr: number) {
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
  return { info, src };
}

async function readAll(r: RangeReader) {
  const parts: Float32Array[][] = [];
  await r.read(chs => { parts.push(chs.map(c => c.slice())); });
  return parts[0].map((_, ch) => Float32Array.from(parts.flatMap(p => [...p[ch]])));
}

describe('planDenoise', () => {
  const info = { sampleRate: 44100, samples: 100000 * 1152 - 576 };
  const total = (start: number, end: number) => Math.ceil(((Math.round(end * 44100) - Math.round(start * 44100)) * 160) / 147);

  it('splits a long range so that the kept parts add up to one pass over it', () => {
    const { segments, fade } = planDenoise(info, 12.3, 1812.3, 8);
    expect(segments.length).toBe(8);
    expect(segments.reduce((a, s) => a + s.keep, 0) - fade * (segments.length - 1)).toBe(total(12.3, 1812.3));
    const s0 = Math.round(12.3 * 44100);
    for (const s of segments) {
      expect((s.from - s0) % 147).toBe(0); // on the resampling grid
      expect(s.skip).toBeGreaterThanOrEqual(0);
      expect(s.keep).toBeGreaterThan(60 * 48000);
    }
    expect(segments[1].skip).toBe(10 * 48000); // warm-up
  });

  it('keeps one pass for one thread or a short range', () => {
    expect(planDenoise(info, 0, 1800, 1).segments).toEqual([{ from: 0, to: 1800 * 44100, skip: 0, keep: total(0, 1800) }]);
    expect(planDenoise(info, 0, 100, 8).segments.length).toBe(1);
    expect(planDenoise(info, 0, 3000, 4).segments.length).toBe(8); // two rounds when long
  });
});

describe('readJoined', () => {
  it('crossfades the overlap and keeps the length', async () => {
    const part = (v: number, n: number) => { const s = new PcmStore(1, 48000); s.push([new Float32Array(n).fill(v)]); s.finish(); return s; };
    const got: number[] = [];
    await readJoined([part(0.5, 20000), part(0.5, 30000), part(0.5, 10000)], 1000, chs => { got.push(...chs[0]); });
    expect(got.length).toBe(58000);
    expect(Math.max(...got.map(v => Math.abs(v - 0.5)))).toBeLessThan(1e-4);
  });
});

describe('denoiseRange', () => {
  it('delivers the cut range at 48 kHz with the matching length', async () => {
    await loadDenoiser(wasm);
    const sr = 44100, pcm = syllables(sr, 6);
    const { info, src } = await mp3Of(pcm, sr);

    const progress: number[] = [];
    const reader = await denoiseRange(src, info, { start: 1, end: 4.5, channels: 2, denoiseDb: 12, dereverbDb: 0 }, { onProgress: p => progress.push(p) });
    expect(reader.sampleRate).toBe(48000);
    expect(progress.at(-1)).toBe(1);
    let n = 0, chans = 0;
    await reader.read(chs => { n += chs[0].length; chans = chs.length; });
    expect(chans).toBe(2);
    expect(n).toBe(Math.ceil(((Math.round(4.5 * sr) - Math.round(1 * sr)) * 48000) / sr));
  }, 30000);
});

describe('denoiseRange in segments', () => {
  it('gives the same signal as one pass, without audible joins', async () => {
    await loadDenoiser(wasm);
    const sr = 44100, x = syllables(sr, 22);
    let seed = 7;
    for (let i = 0; i < x.length; i++) { seed = (seed * 16807) % 2147483647; x[i] += 0.02 * (seed / 2147483647 - 0.5); }
    const { info, src } = await mp3Of(x, sr);
    const o = { start: 0.5, end: 21.5, channels: 1 as const, denoiseDb: 12, dereverbDb: 0 };
    const whole = (await readAll(await denoiseRange(src, info, o)))[0];
    const params = { minSec: 5, warmupSec: 3, fadeSec: 0.5 };
    expect(planDenoise(info, o.start, o.end, 3, params).segments.length).toBe(3);
    const split = (await readAll(await denoiseRange(src, info, o, { threads: { workers: 3, runner: inProcess(src, info) }, params })))[0];
    expect(split.length).toBe(whole.length);
    const level = rms(whole), diff = whole.map((v, i) => v - split[i]);
    expect(20 * Math.log10(rms(diff) / level)).toBeLessThan(-30);
    // no clicks: around each join (crossfade and the 50 ms after it) both versions agree
    // (a fresh model may still treat a later onset a little differently; with 3 s warm-up instead of 10 s here)
    const { segments, fade } = planDenoise(info, o.start, o.end, 3, params);
    const peak = (v: Float32Array) => v.reduce((m, y) => Math.max(m, Math.abs(y)), 0);
    let join = 0;
    for (const seg of segments.slice(0, -1)) {
      join += seg.keep - (join ? fade : 0);
      expect(peak(diff.subarray(join - fade, join + 2400))).toBeLessThan(0.02 * peak(whole));
    }
  }, 30000);
});

describe('the late-reverb stage in the pass', () => {
  it('changes the signal, keeps its length, and gives the same in segments as in one pass', async () => {
    await loadDenoiser(wasm);
    const sr = 44100, { info, src } = await mp3Of(syllables(sr, 22), sr);
    const plain = { start: 0.5, end: 21.5, channels: 1 as const, denoiseDb: 12, dereverbDb: 0 }, o = { ...plain, dereverbDb: 10 };
    const without = (await readAll(await denoiseRange(src, info, plain)))[0];
    const whole = (await readAll(await denoiseRange(src, info, o)))[0];
    expect(whole.length).toBe(without.length);
    expect(20 * Math.log10(rms(whole.map((v, i) => v - without[i])) / rms(without))).toBeGreaterThan(-30); // it does something
    const params = { minSec: 5, warmupSec: 3, fadeSec: 0.5 };
    const split = (await readAll(await denoiseRange(src, info, o, { threads: { workers: 3, runner: inProcess(src, info) }, params })))[0];
    expect(split.length).toBe(whole.length);
    expect(20 * Math.log10(rms(whole.map((v, i) => v - split[i])) / rms(whole))).toBeLessThan(-30);
  }, 60000);
});

describe('denoisedPart', () => {
  it('serves a cut inside a denoised window like a pass over the cut itself', async () => {
    await loadDenoiser(wasm);
    const sr = 44100, { info, src } = await mp3Of(syllables(sr, 16), sr);
    const window = { start: 0.3, end: 15.7, channels: 1 as const, denoiseDb: 12, dereverbDb: 0 }, cut = { start: 4.37, end: 12.81, channels: 1 as const, denoiseDb: 12, dereverbDb: 0 };
    expect(covers(window, cut)).toBe(true);
    expect(covers(window, { ...cut, end: 15.8 })).toBe(false);
    expect(covers(window, { ...cut, channels: 2 })).toBe(false);
    expect(covers(window, { ...cut, denoiseDb: 18 })).toBe(false);
    expect(covers(window, { ...cut, dereverbDb: 10 })).toBe(false);
    const part = (await readAll(denoisedPart(await denoiseRange(src, info, window), info, window, cut)))[0];
    const direct = (await readAll(await denoiseRange(src, info, cut)))[0];
    expect(part.length).toBe(direct.length);
    expect(part.length).toBe(Math.ceil(((Math.round(12.81 * sr) - Math.round(4.37 * sr)) * 160) / 147));
    // same timing; once the direct pass has warmed up, the same signal
    const tail = (x: Float32Array) => x.subarray(3 * 48000);
    const diff = tail(part).map((v, i) => v - tail(direct)[i]);
    expect(20 * Math.log10(rms(diff) / rms(tail(direct)))).toBeLessThan(-30);
  }, 30000);
});

describe('denoiseRange on quiet recordings', () => {
  it('treats a recording made at −50 LUFS like one at a normal level', async () => {
    await loadDenoiser(wasm);
    const sr = 48000, x = syllables(sr, 12);
    let seed = 3;
    for (let i = 0; i < x.length; i++) { seed = (seed * 16807) % 2147483647; x[i] = 0.04 * x[i] + 0.002 * (seed / 2147483647 - 0.5); }
    const o = { start: 0.5, end: 11.5, channels: 1 as const, denoiseDb: 12, dereverbDb: 0 };
    const lufs = async (r: RangeReader) => { const m = new LoudnessMeter(r.sampleRate, 1); await r.read(chs => { m.push(chs); }); return m.integrated(); };
    /** loudness change by the filter (dB) */
    const change = async (pcm: Float32Array, levelLufs?: number) => {
      const { info, src } = await mp3Of(pcm, sr);
      const before = await lufs(sourceReader(src, info, o.start, o.end));
      return { before, change: await lufs(await denoiseRange(src, info, o, { levelLufs })) - before };
    };
    const normal = await change(x.map(v => v * 20));
    const quiet = await change(x);
    const unlifted = await change(x, 0); // without lifting it first
    expect(quiet.before).toBeLessThan(-45);
    expect(normal.before).toBeGreaterThan(-25);
    expect(Math.abs(quiet.change - normal.change)).toBeLessThan(1);
    expect(unlifted.change).toBeLessThan(normal.change - 3);
  }, 30000);
});
