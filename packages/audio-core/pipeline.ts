// Environment-independent processing passes, shared by the Web Worker and the Node scripts.
import { createMp3Encoder } from 'wasm-media-encoders';
import { Mp3Indexer, type Mp3Info } from './mp3-index';
import { createDecoder, decodeRange, downmix, CHUNK_BYTES, type ByteSource } from './decode';
import { FeatureExtractor, PeakBuilder, type Features } from './features';
import { analyze, type AnalysisParams, type AnalysisResult } from './analysis';
import { LoudnessMeter, TruePeakMeter, integrateSubBlocks } from './loudness';
import { Biquad, Compressor, Limiter, dbToLin, fadeGain, linToDb, rbj } from './dsp';

export const PEAKS_PER_SEC = 50;

/**
 * The LAME build in wasm-media-encoders attenuates its input by 0.45 dB (measured with a
 * sine, independent of bitrate/channels). Compensated right before encoding; pinned by a test.
 */
export const ENCODER_COMPENSATION_DB = 0.45;

/**
 * Limiter ceiling below the true-peak target: covers inter-sample peaks and the MP3 coding noise,
 * which on heavily limited speech pushed peaks up to 1.9 dB above the ceiling at 64 kbps
 * (8 sermons). The overshoot is random, so it cannot be predicted from excerpts.
 */
const tpMarginDb = (e: EncodeOptions) => (e.kbps <= 64 ? 2.0 : 1.5);

export interface AnalyzeOutput {
  info: Mp3Info;
  features: Features;
  peaks: Float32Array;
  /** K-weighted 100 ms sub-blocks of the mono downmix, for fast loudness estimates of any range */
  loudness: Float32Array;
  result: AnalysisResult;
}

/** Pass 1: index frames, decode the whole file once, extract features and waveform peaks. */
export async function analyzeSource(src: ByteSource, params: Partial<AnalysisParams> = {},
  onProgress?: (p: number) => void): Promise<AnalyzeOutput> {
  const indexer = new Mp3Indexer();
  const dec = await createDecoder();
  let fx: FeatureExtractor | null = null, pk: PeakBuilder | null = null, lm: LoudnessMeter | null = null;
  let toSkip = -1;
  try {
    for (let off = 0; off < src.size; off += CHUNK_BYTES) {
      const bytes = await src.read(off, Math.min(CHUNK_BYTES, src.size - off));
      indexer.push(bytes);
      const out = dec.decode(bytes);
      if (out.samplesDecoded > 0) {
        if (!fx) {
          fx = new FeatureExtractor(out.sampleRate);
          pk = new PeakBuilder(out.sampleRate, PEAKS_PER_SEC);
          lm = new LoudnessMeter(out.sampleRate, 1);
        }
        if (toSkip < 0) toSkip = indexer.delay; // known once the info frame has been parsed
        let mono = downmix(out.channelData);
        if (toSkip > 0) { const k = Math.min(toSkip, mono.length); mono = mono.subarray(k); toSkip -= k; }
        if (mono.length) { pk!.push(mono); lm!.push([mono]); fx.push(mono); }
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
  return { info, features, peaks: pk.finish(), loudness: lm!.subBlocks(), result };
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
  /** loudness of the complete chain incl. limiter, interpolated from the candidate runs */
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
 * Gain-independent part of the export chain: high-pass → [pre-gain → compressor] → fades.
 * The remaining gain is applied by the limiter (Limiter.process(…, gain)), so the measurement
 * can run several gain candidates on one shared signal. Fades commute with that gain.
 * `onInput` sees the signal after the high-pass (input loudness).
 */
function makeShared(o: ProcessOptions, sr: number, preGainDb: number, onInput?: (chs: Float32Array[]) => void) {
  const nch = o.channels;
  const hp = o.highpass ? new Biquad(rbj('highpass', 80, Math.SQRT1_2, sr), nch) : null;
  const comp = o.compressor ? new Compressor(o.targetLufs + 3, 2, sr) : null;
  const pre = dbToLin(preGainDb);
  const length = o.end - o.start, fades = o.fadeIn > 0 || o.fadeOut > 0;
  let n = 0;
  return {
    push(raw: Float32Array[]): Float32Array[] {
      const chs = toChannels(raw, nch);
      if (hp) chs.forEach((c, i) => hp.process(c, i));
      onInput?.(chs);
      if (comp) { applyGain(chs, pre); comp.process(chs); }
      if (fades) {
        const len = chs[0].length;
        // only the first/last seconds need per-sample gains
        if ((n / sr) < o.fadeIn || ((n + len) / sr) > length - o.fadeOut) {
          for (let i = 0; i < len; i++) {
            const g = fadeGain((n + i) / sr, length, o.fadeIn, o.fadeOut);
            if (g !== 1) for (const c of chs) c[i] *= g;
          }
        }
      }
      n += chs[0].length;
      return chs;
    },
    get samples() { return n; },
  };
}

/** Drops the first `latency` samples of a limiter's output stream. */
function latencyTrim(latency: number) {
  let drop = latency;
  return (chs: Float32Array[]) => {
    if (drop > 0) { const k = Math.min(drop, chs[0].length); chs = chs.map(c => c.subarray(k)); drop -= k; }
    return chs;
  };
}

export interface MeasureHints {
  /** loudness sub-blocks from the analysis pass (AnalyzeOutput.loudness) */
  loudness?: Float32Array;
}

interface Candidate { gainDb: number; lim: Limiter; meter: LoudnessMeter; buf: Float32Array[]; }

/**
 * Pass 2: input loudness and the gain that hits the target after the limiter.
 *
 * Instead of measure → simulate → correct (one decode each), the input loudness is estimated
 * from the analysis pass, and a single decode pass runs the limiter at several candidate gains
 * around that estimate. The gain for the target is interpolated between candidates.
 * Before that, the loudest moments are encoded as short MP3 excerpts to see how far MP3 coding
 * pushes peaks above the limiter, and the ceiling is lowered accordingly.
 */
export async function measure(src: ByteSource, info: Mp3Info, o: ProcessOptions, e: EncodeOptions,
  hints: MeasureHints = {}, onProgress?: (p: number) => void): Promise<Measurement> {
  const sr = info.sampleRate;
  let est = hints.loudness
    ? integrateSubBlocks(hints.loudness, Math.max(0, Math.floor(o.start * 10)), Math.min(hints.loudness.length, Math.ceil(o.end * 10)))
    : NaN;
  if (isFinite(est) && o.channels === 2) est += 3.01; // estimate is mono; same signal on two channels adds 3 dB
  let exactInput = NaN;
  if (!isFinite(est)) {
    // no analysis data: measure the input first (one extra pass)
    const m = new LoudnessMeter(sr, o.channels);
    const shared = makeShared({ ...o, compressor: false, fadeIn: 0, fadeOut: 0 }, sr, 0, chs => m.push(chs));
    await decodeRange(src, info, o.start, o.end, raw => { shared.push(raw); }, p => onProgress?.(p * 0.3));
    exactInput = est = m.integrated();
  }
  if (!isFinite(est)) throw new Error('Der gewählte Bereich ist still – keine Lautheit messbar.');

  const preGainDb = o.compressor ? Math.min(o.targetLufs - est, o.maxGainDb) : 0;
  const capDb = o.maxGainDb - preGainDb; // limit for the limiter-stage gain
  const baseDb = o.compressor ? 0 : o.targetLufs - est;
  const ceilingDb = o.truePeakDb - tpMarginDb(e);

  const runCandidates = async (gains: number[], p0: number, p1: number) => {
    const inMeter = new LoudnessMeter(sr, o.channels);
    const shared = makeShared(o, sr, preGainDb, chs => inMeter.push(chs));
    const cands: Candidate[] = gains.map(gainDb => ({
      gainDb, lim: new Limiter(ceilingDb, sr, o.channels), meter: new LoudnessMeter(sr, o.channels), buf: [],
    }));
    await decodeRange(src, info, o.start, o.end, raw => {
      const chs = shared.push(raw);
      for (const c of cands) {
        if (!c.buf.length || c.buf[0].length < chs[0].length) c.buf = chs.map(x => new Float32Array(x.length));
        const out = c.buf.map(b => b.subarray(0, chs[0].length));
        c.lim.process(chs, dbToLin(c.gainDb), out);
        c.meter.push(out);
      }
    }, p => onProgress?.(p0 + p * (p1 - p0)));
    for (const c of cands) c.meter.push(c.lim.flush());
    return { input: inMeter.integrated(), points: cands.map(c => ({ g: c.gainDb, l: c.meter.integrated(), red: -linToDb(c.lim.minGain) })) };
  };

  // The limiter typically takes 0…2.5 LU (more with heavy peaks); the loudness curve is nearly
  // linear in that range, so three candidates spread over it are enough to interpolate.
  const spread = [-0.2, 1.4, 3.0];
  const round = (g: number) => Math.round(Math.min(g, capDb) * 1000) / 1000;
  let gains = [...new Set(spread.map(d => round(baseDb + d)))];
  let points: { g: number; l: number; red: number }[] = [];
  for (let pass = 0; ; pass++) {
    const p0 = pass ? 0.8 : isFinite(exactInput) ? 0.3 : 0.02;
    const r = await runCandidates(gains, p0, pass ? 0.95 : 0.8);
    if (!isFinite(exactInput)) exactInput = r.input;
    points = [...points, ...r.points].sort((x, y) => x.g - y.g);
    const sol = solveGain(points, o.targetLufs);
    const lo = points[0].g, hi = points[points.length - 1].g;
    if (pass >= 1 || (sol.g >= lo - 0.8 && sol.g <= hi + 0.8) || hi >= capDb - 1e-6) break;
    // the estimate was far off: one more pass around the extrapolated gain
    gains = [...new Set([sol.g - 2, sol.g - 0.5, sol.g + 1].map(round))].filter(g => !points.some(q => Math.abs(q.g - g) < 1e-3));
    if (!gains.length) break;
  }
  if (!isFinite(exactInput)) throw new Error('Der gewählte Bereich ist still – keine Lautheit messbar.');

  const g = Math.min(solveGain(points, o.targetLufs).g, capDb);
  const near = points.reduce((x, y) => (Math.abs(y.g - g) < Math.abs(x.g - g) ? y : x));
  onProgress?.(1);
  const makeupDb = o.compressor ? g : 0;
  const pre = o.compressor ? preGainDb : g;
  const gainDb = pre + makeupDb;
  return {
    inputLufs: exactInput, preGainDb: pre, makeupDb, gainDb, ceilingDb,
    predictedLufs: interpolate(points, g), limiterReductionDb: near.red,
    limited: gainDb >= o.maxGainDb - 1e-6,
  };
}

/** Loudness at gain g by piecewise-linear interpolation/extrapolation of measured points. */
function interpolate(pts: { g: number; l: number }[], g: number): number {
  if (pts.length === 1) return pts[0].l + (g - pts[0].g);
  let i = pts.findIndex(p => p.g >= g);
  if (i <= 0) i = i === 0 ? 1 : pts.length - 1;
  const a = pts[i - 1], b = pts[i];
  const slope = b.g > a.g ? Math.min(1.1, Math.max(0.5, (b.l - a.l) / (b.g - a.g))) : 1;
  return a.l + (g - a.g) * slope;
}

/** Gain where the (monotonic) loudness curve reaches the target. */
export function solveGain(pts: { g: number; l: number }[], target: number): { g: number; bracketed: boolean } {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.l <= target && target <= b.l && b.l > a.l) return { g: a.g + ((target - a.l) / (b.l - a.l)) * (b.g - a.g), bracketed: true };
  }
  const a = target < pts[0].l ? pts[0] : pts[pts.length - 1];
  const b = target < pts[0].l ? pts[Math.min(1, pts.length - 1)] : pts[Math.max(0, pts.length - 2)];
  const slope = b !== a && b.g !== a.g ? Math.min(1.1, Math.max(0.5, (b.l - a.l) / (b.g - a.g))) : 1;
  return { g: a.g + (target - a.l) / slope, bracketed: false };
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

/** Pass 3: the same stages as in measure(), encoded to MP3. */
export async function render(src: ByteSource, info: Mp3Info, o: ProcessOptions, m: Measurement, e: EncodeOptions,
  onProgress?: (p: number) => void): Promise<RenderResult> {
  const sr = info.sampleRate, nch = o.channels;
  const enc = await createMp3Encoder();
  enc.configure({ sampleRate: sr, channels: nch, bitrate: e.kbps, outputSampleRate: e.outputSampleRate ?? 44100 });
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const emit = (data: Uint8Array) => { if (data.length) { parts.push(data.slice()); bytes += data.length; } };
  const shared = makeShared(o, sr, m.preGainDb);
  const lim = new Limiter(m.ceilingDb, sr, nch);
  const trim = latencyTrim(lim.latency);
  // limiter-stage gain: everything after the compressor, or the whole gain without one
  const g = dbToLin(o.compressor ? m.makeupDb : m.gainDb);
  const comp = dbToLin(ENCODER_COMPENSATION_DB);
  const out = (chs: Float32Array[]) => {
    chs = trim(chs);
    if (!chs.length || !chs[0].length) return;
    applyGain(chs, comp);
    emit(enc.encode(chs));
  };
  await decodeRange(src, info, o.start, o.end, raw => {
    const chs = shared.push(raw);
    lim.process(chs, g);
    out(chs);
  }, onProgress);
  out(lim.flush());
  emit(enc.finalize());
  const mp3 = new Uint8Array(bytes);
  let p = 0;
  for (const part of parts) { mp3.set(part, p); p += part.length; }
  // Measure what actually ends up in the file.
  const decoded = await measureMp3(mp3, nch);
  return {
    mp3, duration: shared.samples / sr,
    outputLufs: decoded.lufs, truePeakDb: decoded.truePeakDb,
    limiterReductionDb: -linToDb(lim.minGain),
  };
}
