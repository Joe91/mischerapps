import { describe, expect, it } from 'vitest';
import { createMp3Encoder } from 'wasm-media-encoders';
import { mergeSpeech, snapMarker, otsu, trimEdges, DEFAULT_PARAMS, type Segment } from '../packages/audio-core/analysis';
import { LoudnessMeter, TruePeakMeter } from '../packages/audio-core/loudness';
import { Limiter, dbToLin, fadeGain } from '../packages/audio-core/dsp';
import { Mp3Indexer } from '../packages/audio-core/mp3-index';
import { createDecoder, decodeRange, type ByteSource } from '../packages/audio-core/decode';
import { measure, sourceReader, ENCODER_COMPENSATION_DB } from '../packages/audio-core/pipeline';
import type { Features } from '../packages/audio-core/features';

const sine = (sr: number, sec: number, f: number, dbfs: number) => {
  const a = dbToLin(dbfs), x = new Float32Array(Math.round(sr * sec));
  for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / sr);
  return x;
};

describe('mergeSpeech', () => {
  it('joins speech separated by short gaps only', () => {
    const s = (start: number, end: number): Segment => ({ start, end, kind: 'speech' });
    expect(mergeSpeech([s(0, 100), s(105, 200), s(220, 300)], 8)).toEqual([s(0, 200), s(220, 300)]);
  });
});

describe('trimEdges', () => {
  const sp = (start: number, end: number): Segment => ({ start, end, kind: 'speech' });
  const sermon = [sp(730, 900), sp(901, 1500), sp(1502, 2110)];

  it('cuts off a reading before a long pause and an announcement after the Amen', () => {
    // as in a real recording: 10 s, 15 s pause, 100 s reading, 19 s pause, sermon, 6 s pause, 8 s announcement
    const b = [sp(584, 594), sp(609, 709), sp(711, 711.5), ...sermon, sp(2116, 2124)];
    expect(trimEdges(b, DEFAULT_PARAMS)).toEqual(sermon);
  });

  it('keeps long pauses inside the sermon and a short greeting at its start', () => {
    const b = [sp(700, 703), sp(709, 900), sp(915, 1500), sp(1530, 2110)];
    expect(trimEdges(b, DEFAULT_PARAMS)).toEqual(b);
  });
});

describe('otsu', () => {
  it('splits a bimodal distribution between the modes', () => {
    const v = [...Array(100).fill(-3), ...Array(100).fill(3)];
    const { thr, sep } = otsu(v, -8, 8);
    expect(thr).toBeGreaterThan(-3);
    expect(thr).toBeLessThan(3);
    expect(sep).toBeGreaterThan(0.9);
  });
});

describe('snapMarker', () => {
  // 40 frames/s: loud until 10 s, quiet 10–11 s, loud again from 11 s
  const hop = 0.025, n = 800;
  const rmsDb = new Float32Array(n).map((_, i) => (i * hop >= 10 && i * hop < 11 ? -70 : -20));
  const f: Features = { hopSec: hop, n, rmsDb, zcr: new Float32Array(n), flatness: new Float32Array(n), flux: new Float32Array(n) };
  it('puts the start just before the speech onset after the gap', () => {
    const t = snapMarker(f, 11.8, 'start', DEFAULT_PARAMS, 20);
    expect(t).toBeGreaterThan(10.5);
    expect(t).toBeLessThan(11);
  });
  it('puts the end shortly after the last word before the gap', () => {
    const t = snapMarker(f, 9.2, 'end', DEFAULT_PARAMS, 20);
    expect(t).toBeGreaterThan(10.5);
    expect(t).toBeLessThan(11.2);
  });
});

describe('LoudnessMeter', () => {
  it('reads a 997 Hz sine at -20 dBFS as about -23 LUFS (mono)', () => {
    const m = new LoudnessMeter(48000, 1);
    m.push([sine(48000, 10, 997, -20)]);
    expect(m.integrated()).toBeCloseTo(-23.01, 1);
  });
  it('adds +3 dB for the same signal on two channels', () => {
    const x = sine(44100, 10, 997, -20);
    const m = new LoudnessMeter(44100, 2);
    m.push([x, x.slice()]);
    expect(m.integrated()).toBeCloseTo(-20.0, 1);
  });
  it('gates silence', () => {
    const m = new LoudnessMeter(44100, 1);
    m.push([new Float32Array(44100 * 5)]);
    expect(m.integrated()).toBe(-Infinity);
  });
});

describe('TruePeakMeter', () => {
  it('finds inter-sample peaks of a quarter-rate sine', () => {
    // fs/4 sine sampled at 45° phase: samples at ±0.707, true peak 1.0
    const x = new Float32Array(4000).map((_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    const tp = new TruePeakMeter(1);
    tp.push([x]);
    expect(tp.peak).toBeGreaterThan(0.95);
  });
});

describe('Limiter', () => {
  it('never exceeds the ceiling and keeps length/latency consistent', () => {
    const sr = 44100, ceil = -2;
    const x = new Float32Array(sr).map((_, i) => Math.sin(i * 0.01) * (i >= 200 && i < 400 ? 3 : 0.3));
    const lim = new Limiter(ceil, sr, 1);
    const y = x.slice();
    lim.process([y]);
    const tail = lim.flush()[0];
    const out = new Float32Array(y.length + tail.length);
    out.set(y); out.set(tail, y.length);
    const max = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(max).toBeLessThanOrEqual(dbToLin(ceil) + 1e-6);
    // quiet parts pass unchanged (after the latency)
    expect(out[30000 + lim.latency]).toBeCloseTo(x[30000], 3); // exponential release: tiny residual reduction remains
  });
});

describe('fadeGain', () => {
  it('ramps from 0 to 1 and back', () => {
    expect(fadeGain(0, 10, 1, 1)).toBe(0);
    expect(fadeGain(0.5, 10, 1, 1)).toBeCloseTo(0.5);
    expect(fadeGain(5, 10, 1, 1)).toBe(1);
    expect(fadeGain(10, 10, 1, 1)).toBe(0);
  });
});

describe('MP3 index and seeking', async () => {
  const sr = 44100;
  // 20 s of a slowly modulated chirp-ish signal, encoded with LAME (writes a LAME/Info frame)
  const pcm = new Float32Array(sr * 20).map((_, i) => 0.3 * Math.sin(2 * Math.PI * (200 + (i % sr) / 100) * (i / sr)) * (0.6 + 0.4 * Math.sin(i / 3000)));
  const enc = await createMp3Encoder();
  enc.configure({ sampleRate: sr, channels: 1, bitrate: 128 });
  const parts = [enc.encode([pcm]).slice(), enc.finalize().slice()];
  const mp3 = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { mp3.set(p, o); o += p.length; }
  const src: ByteSource = { size: mp3.length, read: async (off, len) => mp3.subarray(off, off + len) };

  const idx = new Mp3Indexer();
  for (let i = 0; i < mp3.length; i += 7777) idx.push(mp3.subarray(i, i + 7777)); // odd chunking on purpose
  const info = idx.finish();

  it('parses frames and duration', () => {
    expect(info.sampleRate).toBe(sr);
    expect(info.spf).toBe(1152);
    expect(info.duration).toBeGreaterThan(19.9);
    expect(info.duration).toBeLessThan(20.1);
  });

  it('decodes a range sample-identical to the full decode', async () => {
    const dec = await createDecoder();
    const full = dec.decode(mp3).channelData[0].subarray(info.delay);
    dec.free();
    const t0 = 7.3, t1 = 9.1;
    const got: number[] = [];
    await decodeRange(src, info, t0, t1, chs => { got.push(...chs[0]); });
    const s0 = Math.round(t0 * sr);
    expect(got.length).toBe(Math.round(t1 * sr) - s0);
    let maxErr = 0;
    for (let i = 0; i < got.length; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - full[s0 + i]));
    expect(maxErr).toBeLessThan(1e-6);
  });

  it('measures and plans gain towards the target', async () => {
    const m = await measure(sourceReader(src, info, 2, 18), {
      start: 2, end: 18, channels: 1, targetLufs: -19, truePeakDb: -1.5, highpass: true,
      compressor: false, denoise: false, fadeIn: 0.5, fadeOut: 1.5, maxGainDb: 20,
    }, { kbps: 64 });
    expect(Math.abs(m.predictedLufs + 19)).toBeLessThan(0.3);
  });
});

describe('MP3 encoder level', () => {
  it('attenuates by ENCODER_COMPENSATION_DB (compensated in render)', async () => {
    const sr = 44100, x = sine(sr, 3, 1000, -6);
    const enc = await createMp3Encoder();
    enc.configure({ sampleRate: sr, channels: 1, bitrate: 128 });
    const parts = [enc.encode([x]).slice(), enc.finalize().slice()];
    const mp3 = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { mp3.set(p, o); o += p.length; }
    const dec = await createDecoder();
    const y = dec.decode(mp3).channelData[0];
    dec.free();
    let e = 0;
    for (let i = sr; i < 2 * sr; i++) e += y[i] * y[i];
    const outDb = 10 * Math.log10(e / sr), inDb = -6 - 3.0103;
    expect(inDb - outDb).toBeCloseTo(ENCODER_COMPENSATION_DB, 1);
  });
});
