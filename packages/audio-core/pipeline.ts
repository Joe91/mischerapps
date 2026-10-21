// Environment-independent processing passes, shared by the Web Worker and the Node scripts.
import { createMp3Encoder } from 'wasm-media-encoders';
import { ID3Writer } from 'browser-id3-writer';
import { Mp3Indexer, type Mp3Info } from './mp3-index';
import { createDecoder, decodeRange, downmix, CHUNK_BYTES, type ByteSource } from './decode';
import { FeatureExtractor, PeakBuilder, type Features } from './features';
import { analyze, type AnalysisParams, type AnalysisResult } from './analysis';
import { LoudnessMeter, TruePeakMeter } from './loudness';
import { Biquad, Compressor, Limiter, dbToLin, fadeGain, linToDb, rbj } from './dsp';

export const PEAKS_PER_SEC = 50;

/**
 * The LAME build in wasm-media-encoders attenuates its input by 0.45 dB (measured with a
 * sine, independent of bitrate/channels). Compensated right before encoding; pinned by a test.
 */
export const ENCODER_COMPENSATION_DB = 0.45;

/** Limiter ceiling below the true-peak target: covers inter-sample peaks and MP3 coding overshoot. */
const TP_MARGIN_DB = 1.0;

export interface AnalyzeOutput {
  info: Mp3Info;
  features: Features;
  peaks: Float32Array;
  result: AnalysisResult;
}

/** Pass 1: index frames, decode the whole file once, extract features and waveform peaks. */
export async function analyzeSource(src: ByteSource, params: Partial<AnalysisParams> = {},
  onProgress?: (p: number) => void): Promise<AnalyzeOutput> {
  const indexer = new Mp3Indexer();
  const dec = await createDecoder();
  let fx: FeatureExtractor | null = null, pk: PeakBuilder | null = null;
  let toSkip = -1;
  try {
    for (let off = 0; off < src.size; off += CHUNK_BYTES) {
      const bytes = await src.read(off, Math.min(CHUNK_BYTES, src.size - off));
      indexer.push(bytes);
      const out = dec.decode(bytes);
      if (out.samplesDecoded > 0) {
        if (!fx) { fx = new FeatureExtractor(out.sampleRate); pk = new PeakBuilder(out.sampleRate, PEAKS_PER_SEC); }
        if (toSkip < 0) toSkip = indexer.delay; // known once the info frame has been parsed
        let mono = downmix(out.channelData);
        if (toSkip > 0) { const k = Math.min(toSkip, mono.length); mono = mono.subarray(k); toSkip -= k; }
        if (mono.length) { pk!.push(mono); fx.push(mono); }
      }
      onProgress?.(Math.min(1, (off + CHUNK_BYTES) / src.size));
      // yield so progress messages and cancellation can get through
      if ((off / CHUNK_BYTES) % 8 === 7) await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    dec.free();
  }
  const info = indexer.finish();
  if (!fx || !pk) throw new Error('Die Datei enthält keine dekodierbaren Audiodaten.');
  const features = fx.finish();
  const result = analyze(features, info.duration, params);
  return { info, features, peaks: pk.finish(), result };
}

export interface ProcessOptions {
  start: number;
  end: number;
  channels: 1 | 2;
  targetLufs: number;
  truePeakDb: number;
  highpass: boolean;
  compressor: boolean;
  fadeIn: number;
  fadeOut: number;
  maxGainDb: number;
}

export interface Measurement {
  inputLufs: number;
  /** gain before the (optional) compressor */
  preGainDb: number;
  /** make-up gain after the compressor (0 without compressor) */
  makeupDb: number;
  /** total gain applied */
  gainDb: number;
  /** limiter ceiling (dBFS, sample peak) */
  ceilingDb: number;
  /** loudness of the complete chain incl. limiter, as predicted by the simulation pass */
  predictedLufs: number;
  limiterReductionDb: number;
  /** gain hit the maxGainDb cap */
  limited: boolean;
}

function toChannels(chs: Float32Array[], n: 1 | 2): Float32Array[] {
  if (n === 1) return [chs.length === 1 ? chs[0] : downmix(chs)];
  return chs.length === 2 ? chs : [chs[0], chs[0].slice()];
}

function applyGain(chs: Float32Array[], g: number) {
  if (g === 1) return;
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
}

/**
 * The processing chain of the export: high-pass → pre-gain → compressor → make-up → fades → limiter.
 * `push` processes a block in place and returns the (latency-compensated) output blocks.
 */
function makeChain(o: ProcessOptions, sr: number, gains: { preGainDb: number; makeupDb: number } | null, ceilingDb: number | null) {
  const nch = o.channels;
  const hp = o.highpass ? new Biquad(rbj('highpass', 80, Math.SQRT1_2, sr), nch) : null;
  const comp = gains && o.compressor ? new Compressor(o.targetLufs + 3, 2, sr) : null;
  const pre = gains ? dbToLin(gains.preGainDb) : 1, post = gains ? dbToLin(gains.makeupDb) : 1;
  const lim = ceilingDb !== null ? new Limiter(ceilingDb, sr, nch) : null;
  const length = o.end - o.start;
  let n = 0, drop = lim ? lim.latency : 0;
  const trim = (chs: Float32Array[]) => {
    if (drop > 0) { const k = Math.min(drop, chs[0].length); chs = chs.map(c => c.subarray(k)); drop -= k; }
    return chs;
  };
  return {
    lim,
    push(raw: Float32Array[]): Float32Array[] {
      const chs = toChannels(raw, nch);
      if (hp) chs.forEach((c, i) => hp.process(c, i));
      if (!gains) return chs;
      applyGain(chs, pre);
      if (comp) { comp.process(chs); applyGain(chs, post); }
      if (o.fadeIn > 0 || o.fadeOut > 0) {
        for (let i = 0; i < chs[0].length; i++) {
          const g = fadeGain((n + i) / sr, length, o.fadeIn, o.fadeOut);
          if (g !== 1) for (const c of chs) c[i] *= g;
        }
      }
      n += chs[0].length;
      if (lim) lim.process(chs);
      return trim(chs);
    },
    flush(): Float32Array[] { return lim ? trim(lim.flush()) : []; },
    get samples() { return n; },
  };
}

/**
 * Pass 2: loudness of the selected range (after high-pass), compressor make-up if enabled,
 * then a simulation of the full chain to compensate the loudness the limiter takes away.
 */
export async function measure(src: ByteSource, info: Mp3Info, o: ProcessOptions,
  onProgress?: (p: number) => void): Promise<Measurement> {
  const sr = info.sampleRate;
  const maxPasses = (o.compressor ? 2 : 1) + 3;
  let pass = 0;
  const ceilingDb = o.truePeakDb - TP_MARGIN_DB;
  const run = async (gains: { preGainDb: number; makeupDb: number } | null, limit: boolean) => {
    const meter = new LoudnessMeter(sr, o.channels);
    const chain = makeChain(o, sr, gains, limit ? ceilingDb : null);
    const base = pass++;
    await decodeRange(src, info, o.start, o.end, raw => { const out = chain.push(raw); if (out[0].length) meter.push(out); },
      p => onProgress?.(Math.min(1, (base + p) / maxPasses)));
    const tail = chain.flush();
    if (tail.length && tail[0].length) meter.push(tail);
    return { lufs: meter.integrated(), reduction: chain.lim ? -linToDb(chain.lim.minGain) : 0 };
  };

  const inputLufs = (await run(null, false)).lufs;
  if (!isFinite(inputLufs)) throw new Error('Der gewählte Bereich ist still – keine Lautheit messbar.');
  const g = { preGainDb: Math.min(o.targetLufs - inputLufs, o.maxGainDb), makeupDb: 0 };
  if (o.compressor) {
    const c = await run(g, false);
    g.makeupDb = Math.min(o.targetLufs - c.lufs, o.maxGainDb - g.preGainDb);
  }
  let sim = await run(g, true);
  for (let i = 0; i < 2; i++) {
    // the limiter took loudness away: raise the gain (bounded) and re-check
    const delta = o.targetLufs - sim.lufs;
    const headroom = o.maxGainDb - g.preGainDb - g.makeupDb;
    if (delta < 0.1 || headroom < 0.05) break;
    const add = Math.min(delta * 1.1, headroom);
    if (o.compressor) g.makeupDb += add; else g.preGainDb += add;
    sim = await run(g, true);
  }
  onProgress?.(1);
  const gainDb = g.preGainDb + g.makeupDb;
  return {
    inputLufs, ...g, gainDb, ceilingDb, predictedLufs: sim.lufs, limiterReductionDb: sim.reduction,
    limited: gainDb >= o.maxGainDb - 1e-6,
  };
}

export interface EncodeOptions {
  kbps: 64 | 96 | 128;
  outputSampleRate?: 44100 | 48000;
}

export interface RenderResult {
  mp3: Uint8Array;
  duration: number;
  /** measured on the decoded MP3 */
  outputLufs: number;
  truePeakDb: number;
  preEncodeLufs: number;
  preEncodeTruePeakDb: number;
  limiterReductionDb: number;
}

/** Loudness and true peak of an encoded MP3 (mpg123 always returns two channels for mono files). */
export async function measureMp3(mp3: Uint8Array, channels: 1 | 2): Promise<{ lufs: number; truePeakDb: number }> {
  const dec = await createDecoder();
  try {
    let meter: LoudnessMeter | null = null;
    const tp = new TruePeakMeter(channels);
    for (let off = 0; off < mp3.length; off += CHUNK_BYTES) {
      const out = dec.decode(mp3.subarray(off, off + CHUNK_BYTES));
      if (!out.samplesDecoded) continue;
      meter ??= new LoudnessMeter(out.sampleRate, channels);
      const chs = out.channelData.slice(0, channels);
      meter.push(chs); tp.push(chs);
    }
    return { lufs: meter ? meter.integrated() : -Infinity, truePeakDb: linToDb(tp.peak) };
  } finally {
    dec.free();
  }
}

/** Pass 3: the chain from makeChain(), metered and encoded to MP3. */
export async function render(src: ByteSource, info: Mp3Info, o: ProcessOptions, m: Measurement, e: EncodeOptions,
  onProgress?: (p: number) => void): Promise<RenderResult> {
  const sr = info.sampleRate, nch = o.channels;
  const enc = await createMp3Encoder();
  enc.configure({ sampleRate: sr, channels: nch, bitrate: e.kbps, outputSampleRate: e.outputSampleRate ?? 44100 });
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const emit = (data: Uint8Array) => { if (data.length) { parts.push(data.slice()); bytes += data.length; } };
  const chain = makeChain(o, sr, m, m.ceilingDb);
  const outMeter = new LoudnessMeter(sr, nch);
  const tp = new TruePeakMeter(nch);
  const comp = dbToLin(ENCODER_COMPENSATION_DB);
  const out = (chs: Float32Array[]) => {
    if (!chs.length || !chs[0].length) return;
    outMeter.push(chs); tp.push(chs);
    applyGain(chs, comp);
    emit(enc.encode(chs));
  };
  await decodeRange(src, info, o.start, o.end, raw => out(chain.push(raw)), onProgress);
  out(chain.flush());
  emit(enc.finalize());
  const mp3 = new Uint8Array(bytes);
  let p = 0;
  for (const part of parts) { mp3.set(part, p); p += part.length; }
  // Measure what actually ends up in the file: the encoder's low-pass changes loudness slightly.
  const decoded = await measureMp3(mp3, nch);
  return {
    mp3, duration: chain.samples / sr,
    outputLufs: decoded.lufs, truePeakDb: decoded.truePeakDb,
    preEncodeLufs: outMeter.integrated(), preEncodeTruePeakDb: linToDb(tp.peak),
    limiterReductionDb: chain.lim ? -linToDb(chain.lim.minGain) : 0,
  };
}

export interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  comment?: string;
  cover?: { data: ArrayBuffer; mime: string };
}

export function tagMp3(mp3: Uint8Array, t: Tags): Uint8Array {
  const w = new ID3Writer(mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength));
  if (t.title) w.setFrame('TIT2', t.title);
  if (t.artist) w.setFrame('TPE1', [t.artist]);
  if (t.album) w.setFrame('TALB', t.album);
  if (t.year) w.setFrame('TYER', t.year);
  if (t.comment) w.setFrame('COMM', { description: '', text: t.comment, language: 'deu' });
  if (t.cover) w.setFrame('APIC', { type: 3, data: t.cover.data, description: 'Cover' });
  return new Uint8Array(w.addTag());
}
