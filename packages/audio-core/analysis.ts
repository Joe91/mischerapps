// Speech/music/silence segmentation and sermon suggestion (planning doc §3.3).
import type { Features } from './features';

export type Kind = 'speech' | 'music' | 'silence';
export interface Segment { start: number; end: number; kind: Kind; }
export interface Candidate {
  start: number;
  end: number;
  /** raw speech block before snapping */
  rawStart: number;
  rawEnd: number;
  score: number;
  musicBefore: boolean;
  musicAfter: boolean;
}

export interface AnalysisParams {
  winSec: number;
  stepSec: number;
  medianSec: number;
  hiThr: number;
  loThr: number;
  mergeGap: number;
  /** quiet (non-music) gaps up to this length never split a speech block … */
  quietGap: number;
  /** … except at its edges: a part shorter than edgePart before/after a pause of at least edgeGap
   * is something else (reading, prayer before the sermon) */
  edgeGap: number;
  edgePart: number;
  /** and a part shorter than tailPart after a pause of at least tailGap at the end (announcement after the "Amen") */
  tailGap: number;
  tailPart: number;
  /** windows this far below the typical speech level count as silence (dB) */
  quietDb: number;
  minSermon: number;
  snapRange: number;
  /** a closing word (the "Amen") up to this long, after a pause up to amenGap, still belongs to the end */
  amenLen: number;
  amenGap: number;
  preRoll: number;
  postRoll: number;
}

export const DEFAULT_PARAMS: AnalysisParams = {
  winSec: 3, stepSec: 0.5, medianSec: 5, hiThr: 0.6, loThr: 0.4,
  mergeGap: 8, quietGap: 20, edgeGap: 10, edgePart: 180, tailGap: 5, tailPart: 15, quietDb: 15, minSermon: 480, snapRange: 3, amenLen: 1.5, amenGap: 2.5, preRoll: 0.3, postRoll: 0.8,
};

/** Per-window features; exported for calibration (scripts/bench.ts --csv). */
export interface WindowFeatures {
  t: Float32Array; // window centre
  meanDb: Float32Array;
  silentRatio: Float32Array;
  dipRatio: Float32Array;
  rmsStd: Float32Array;
  mod: Float32Array;
  flux: Float32Array;
  flat: Float32Array;
  zcrStd: Float32Array;
  raw: Float32Array;
}

export interface AnalysisResult {
  duration: number;
  noiseFloor: number;
  silenceThr: number;
  threshold: number;
  windows: WindowFeatures;
  score: Float32Array; // smoothed 0..1 speech score per window
  segments: Segment[];
  candidates: Candidate[];
  confidence: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function percentile(a: ArrayLike<number>, p: number): number {
  const s = Float32Array.from(a).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

/**
 * Weighted evidence for speech, each term ~[-3, 3]. Midpoints and scales are
 * initial hand-picked values (speech vs. organ/singing); calibrate with bench.ts.
 */
const TERMS: { key: keyof WindowFeatures; mid: number; scale: number; w: number; log?: boolean }[] = [
  { key: 'dipRatio', mid: 0.12, scale: 0.06, w: 1.2 },
  { key: 'rmsStd', mid: 5, scale: 1.8, w: 1.0 },
  { key: 'flux', mid: 0.16, scale: 0.06, w: 1.0 },
  { key: 'mod', mid: 0.35, scale: 0.1, w: 0.6 },
  { key: 'zcrStd', mid: 0.035, scale: 0.02, w: 0.4 },
  { key: 'flat', mid: -1.6, scale: 0.4, w: 0.3, log: true },
];

export function windowFeatures(f: Features, silenceThr: number, p: AnalysisParams): WindowFeatures {
  const fpw = Math.round(p.winSec / f.hopSec);
  const fps = Math.round(p.stepSec / f.hopSec);
  const nw = Math.max(0, Math.floor((f.n - fpw) / fps) + 1);
  const mk = () => new Float32Array(nw);
  const w: WindowFeatures = {
    t: mk(), meanDb: mk(), silentRatio: mk(), dipRatio: mk(), rmsStd: mk(),
    mod: mk(), flux: mk(), flat: mk(), zcrStd: mk(), raw: mk(),
  };
  const env = new Float64Array(fpw);
  for (let k = 0; k < nw; k++) {
    const a = k * fps, b = a + fpw;
    w.t[k] = ((a + b) / 2) * f.hopSec;
    let e = 0, sil = 0, flux = 0, fluxN = 0, lflat = 0, z = 0, z2 = 0, active = 0;
    for (let i = a; i < b; i++) {
      const db = f.rmsDb[i];
      const lin = Math.pow(10, db / 10);
      e += lin;
      env[i - a] = Math.sqrt(lin);
      if (db < silenceThr) sil++;
      else {
        active++;
        flux += f.flux[i]; fluxN++;
        lflat += Math.log10(f.flatness[i] + 1e-9);
        z += f.zcr[i]; z2 += f.zcr[i] * f.zcr[i];
      }
    }
    const meanDb = 10 * Math.log10(e / fpw + 1e-12);
    w.meanDb[k] = meanDb;
    w.silentRatio[k] = sil / fpw;
    let dips = 0;
    for (let i = a; i < b; i++) if (f.rmsDb[i] < meanDb - 12) dips++;
    w.dipRatio[k] = dips / fpw;
    // dB spread of all frames, floored at the silence threshold so noise in pauses does not dominate
    let m = 0, m2 = 0;
    for (let i = a; i < b; i++) { const d = Math.max(f.rmsDb[i], silenceThr); m += d; m2 += d * d; }
    m /= fpw;
    w.rmsStd[k] = Math.sqrt(Math.max(0, m2 / fpw - m * m));
    w.mod[k] = modulationRatio(env, 1 / f.hopSec);
    w.flux[k] = fluxN ? flux / fluxN : 0;
    w.flat[k] = active ? lflat / active : -3;
    w.zcrStd[k] = active ? Math.sqrt(Math.max(0, z2 / active - (z / active) ** 2)) : 0;
    let raw = 0;
    for (const t of TERMS) raw += t.w * clamp((w[t.key][k] - t.mid) / t.scale, -3, 3);
    w.raw[k] = raw;
  }
  return w;
}

const trig = new Map<number, { cos: Float64Array; sin: Float64Array }>();

/** Share of envelope modulation energy at 2–8 Hz (syllable rate) within 0.5–20 Hz. */
function modulationRatio(env: Float64Array, rate: number): number {
  const n = env.length;
  let tb = trig.get(n);
  if (!tb) {
    tb = { cos: new Float64Array(n), sin: new Float64Array(n) };
    for (let i = 0; i < n; i++) { tb.cos[i] = Math.cos((2 * Math.PI * i) / n); tb.sin[i] = Math.sin((2 * Math.PI * i) / n); }
    trig.set(n, tb);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let band = 0, total = 0;
  const kLo = Math.max(1, Math.ceil((0.5 * n) / rate)), kHi = Math.min(n >> 1, Math.floor((20 * n) / rate));
  for (let k = kLo; k <= kHi; k++) {
    let re = 0, im = 0;
    for (let i = 0, ph = 0; i < n; i++, ph = (ph + k) % n) {
      const v = env[i] - mean;
      re += v * tb.cos[ph]; im -= v * tb.sin[ph];
    }
    const p = re * re + im * im, f = (k * rate) / n;
    total += p;
    if (f >= 2 && f <= 8) band += p;
  }
  return total > 0 ? band / total : 0;
}

/** Otsu threshold on a 1-D distribution; also returns the separability (0..1). */
export function otsu(values: ArrayLike<number>, lo: number, hi: number, bins = 64): { thr: number; sep: number } {
  const hist = new Float64Array(bins);
  let n = 0, mean = 0, varT = 0;
  for (let i = 0; i < values.length; i++) {
    const v = clamp(values[i], lo, hi);
    hist[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins))]++;
    n++; mean += v;
  }
  if (!n) return { thr: 0, sep: 0 };
  mean /= n;
  for (let i = 0; i < values.length; i++) varT += (clamp(values[i], lo, hi) - mean) ** 2;
  varT /= n;
  let best = 0, thr = 0, w0 = 0, s0 = 0;
  for (let b = 0; b < bins - 1; b++) {
    const c = lo + ((b + 0.5) * (hi - lo)) / bins;
    w0 += hist[b]; s0 += hist[b] * c;
    const w1 = n - w0;
    if (!w0 || !w1) continue;
    const m0 = s0 / w0, m1 = (mean * n - s0) / w1;
    const between = (w0 / n) * (w1 / n) * (m0 - m1) ** 2;
    if (between > best) { best = between; thr = lo + ((b + 1) * (hi - lo)) / bins; }
  }
  return { thr, sep: varT > 0 ? best / varT : 0 };
}

export function medianFilter(x: Float32Array, len: number): Float32Array {
  const h = Math.floor(len / 2), out = new Float32Array(x.length), buf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(x.length - 1, i + h); j++) buf.push(x[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

export function mergeSpeech(list: Segment[], gap: number): Segment[] {
  const out: Segment[] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < gap) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Cuts off what a long pause separates from the edges of a speech block (pieces in time order):
 * at the start a reading or prayer before the sermon, at the end a short announcement after it.
 * Long pauses in the middle stay – a sermon may have a silent moment.
 */
export function trimEdges(pieces: Segment[], p: AnalysisParams): Segment[] {
  let b = pieces;
  for (let changed = true; changed && b.length > 1;) {
    changed = false;
    for (let i = 0; i < b.length - 1; i++) {
      const part = b[i].end - b[0].start, gap = b[i + 1].start - b[i].end;
      if (part >= p.edgePart) break;
      if (gap >= p.edgeGap) { b = b.slice(i + 1); changed = true; break; }
    }
    for (let i = b.length - 1; i > 0; i--) {
      const part = b[b.length - 1].end - b[i].start, gap = b[i].start - b[i - 1].end;
      if (part >= p.edgePart) break;
      if (gap >= p.edgeGap || (gap >= p.tailGap && part < p.tailPart)) { b = b.slice(0, i); changed = true; break; }
    }
  }
  return b;
}

/** Seconds of music within `range` seconds before (dir -1) or after (dir +1) a time. */
function musicNear(segs: Segment[], t: number, dir: -1 | 1, range = 30): number {
  const a = dir < 0 ? t - range : t, b = dir < 0 ? t : t + range;
  let sum = 0;
  for (const s of segs) if (s.kind === 'music') sum += Math.max(0, Math.min(b, s.end) - Math.max(a, s.start));
  return sum;
}

/**
 * Moves a cut to the edge of the quiet gap next to speech: for a start marker the end of the
 * quietest stretch before the speech onset, for an end marker the beginning of the quiet
 * stretch after the last word – and after a short closing word that follows a pause (the "Amen"),
 * when `voiceDb` tells voice from room noise. Then adds pre-/post-roll.
 */
export function snapMarker(f: Features, t: number, which: 'start' | 'end', p: AnalysisParams, duration: number,
  voiceDb = Infinity): number {
  const hop = f.hopSec, n = f.n;
  const i0 = clamp(Math.floor((t - p.snapRange) / hop), 0, n - 1);
  const i1 = clamp(Math.ceil((t + p.snapRange) / hop), 0, n - 1);
  if (i1 <= i0) return clamp(t, 0, duration);
  // 200 ms moving average in dB
  const sm = (i: number) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) { s += f.rmsDb[j]; c++; }
    return s / c;
  };
  let minI = i0, minV = Infinity;
  for (let i = i0; i <= i1; i++) { const v = sm(i); if (v < minV) { minV = v; minI = i; } }
  const quiet = minV + 6;
  let edge = minI;
  if (which === 'start') { while (edge < i1 && sm(edge + 1) < quiet) edge++; }
  else {
    while (edge > i0 && sm(edge - 1) < quiet) edge--;
    edge = closingWord(edge, sm, n, voiceDb, p, hop);
  }
  const te = edge * hop + hop;
  return clamp(which === 'start' ? te - p.preRoll : te + p.postRoll, 0, duration);
}

/**
 * From the quiet frame after the last word, the last frame of short words that follow within
 * amenGap, each at most amenLen long and followed by ½ s of quiet – at most 4 s further. Longer
 * sound (music, more talk) or none: the frame before `from`, i.e. where the end already was.
 */
function closingWord(from: number, sm: (i: number) => number, n: number, voiceDb: number, p: AnalysisParams, hop: number): number {
  const gap = Math.round(p.amenGap / hop), maxLen = Math.round(p.amenLen / hop), after = Math.round(0.5 / hop);
  const limit = from + Math.round(4 / hop);
  let end = from;
  for (;;) {
    let a = end + 1;
    while (a < n && a - end <= gap && sm(a) <= voiceDb) a++;
    if (a >= n || a - end > gap || a > limit) break;
    let b = a;
    while (b + 1 < n && sm(b + 1) > voiceDb) b++;
    let q = b + 1;
    while (q < n && q - b <= after && sm(q) <= voiceDb) q++;
    if (b - a > maxLen || (q < n && q - b <= after)) break;
    end = b;
  }
  return end;
}

export function analyze(f: Features, duration: number, params: Partial<AnalysisParams> = {}): AnalysisResult {
  const p = { ...DEFAULT_PARAMS, ...params };
  const audible = Array.from(f.rmsDb).filter(v => v > -100);
  const noiseFloor = Math.max(percentile(audible.length ? audible : [-100], 0.1), -80);
  const silenceThr = Math.min(noiseFloor + 6, percentile(audible.length ? audible : [-100], 0.5) - 15);
  const w = windowFeatures(f, silenceThr, p);
  const nw = w.t.length;

  // Adaptive decision threshold: Otsu split of the raw score among non-silent windows,
  // kept near the absolute zero point when the distribution is not clearly bimodal.
  const active = Array.from(w.raw).filter((_, k) => w.silentRatio[k] < 0.8);
  const { thr: oThr, sep } = otsu(active, -8, 8);
  const threshold = sep > 0.5 ? clamp(oThr, -2, 2) : 0;
  const prob = new Float32Array(nw);
  for (let k = 0; k < nw; k++) prob[k] = sigmoid((w.raw[k] - threshold) / 1.2);
  const medLen = Math.max(1, Math.round(p.medianSec / p.stepSec)) | 1;
  const score = medianFilter(prob, medLen);

  // Typical speech level, to recognise quiet pauses (room noise, rustling) as silence, not music.
  const speechDb = percentile(Array.from(w.meanDb).filter((_, k) => score[k] > p.hiThr && w.silentRatio[k] < 0.8), 0.5);
  const quiet = (k: number) => w.silentRatio[k] >= 0.8 || w.meanDb[k] < speechDb - p.quietDb;

  // Labels with hysteresis; mostly-silent or very quiet windows are silence.
  const labels: Kind[] = new Array(nw);
  let inSpeech = false;
  for (let k = 0; k < nw; k++) {
    if (quiet(k)) { labels[k] = 'silence'; continue; }
    if (inSpeech ? score[k] < p.loThr : score[k] > p.hiThr) inSpeech = !inSpeech;
    labels[k] = inSpeech ? 'speech' : 'music';
  }
  const segments: Segment[] = [];
  const edge = (k: number) => (k <= 0 ? 0 : k >= nw ? duration : clamp(w.t[k] - p.stepSec / 2, 0, duration));
  for (let k = 0; k < nw; k++) {
    const last = segments[segments.length - 1];
    if (last && last.kind === labels[k]) continue;
    if (last) last.end = edge(k);
    segments.push({ start: edge(k), end: duration, kind: labels[k] });
  }

  // Merge speech across short gaps, and across longer ones that contain no music.
  const levelOf = (s: Segment) => {
    let e = 0, n = 0;
    for (let k = 0; k < nw; k++) if (w.t[k] >= s.start && w.t[k] < s.end) { e += Math.pow(10, w.meanDb[k] / 10); n++; }
    return n ? 10 * Math.log10(e / n) : -Infinity;
  };
  // Only real music breaks a quiet gap – not a few seconds of rustling or coughing.
  const hasMusic = (a: number, b: number) => segments.some(s => s.kind === 'music' && s.end > a && s.start < b
    && s.end - s.start >= 4 && levelOf(s) >= speechDb - 8);
  const blocks: Segment[][] = [];
  for (const s of segments.filter(x => x.kind === 'speech')) {
    const block = blocks[blocks.length - 1], last = block?.[block.length - 1];
    const gap = last ? s.start - last.end : Infinity;
    if (last && (gap < p.mergeGap || (gap <= p.quietGap && !hasMusic(last.end, s.start)))) block.push(s);
    else blocks.push([s]);
  }
  // music is looked for next to the whole block: a reading between the music and the sermon is common
  const speech = blocks.map(b => {
    const t = trimEdges(b, p);
    return { start: t[0].start, end: t[t.length - 1].end, blockStart: b[0].start, blockEnd: b[b.length - 1].end };
  });
  const ranked = speech
    .map(s => {
      const musicBefore = musicNear(segments, s.blockStart, -1) >= 8;
      const musicAfter = musicNear(segments, s.blockEnd, 1) >= 8;
      const dur = s.end - s.start;
      return { ...s, dur, musicBefore, musicAfter, score: dur + (musicBefore ? 60 : 0) + (musicAfter ? 60 : 0) };
    })
    .sort((a, b) => (b.dur >= p.minSermon ? 1 : 0) - (a.dur >= p.minSermon ? 1 : 0) || b.score - a.score)
    .slice(0, 3);
  const candidates: Candidate[] = ranked.map(s => ({
    rawStart: s.start, rawEnd: s.end, score: s.score, musicBefore: s.musicBefore, musicAfter: s.musicAfter,
    start: snapMarker(f, s.start, 'start', p, duration),
    // voice: well above the room noise (the "Amen" is quieter than the sermon, rustling quieter still)
    end: snapMarker(f, s.end, 'end', p, duration, silenceThr + 9),
  }));

  let confidence = 0;
  if (ranked.length) {
    const top = ranked[0];
    const second = speech.map(s => s.end - s.start).sort((a, b) => b - a)[1] ?? 0;
    const dScore = clamp(top.dur / p.minSermon, 0, 1.5) / 1.5;
    const sepScore = clamp((top.dur - second) / top.dur, 0, 1);
    const nb = (top.musicBefore ? 0.5 : 0) + (top.musicAfter ? 0.5 : 0);
    confidence = 0.4 * dScore + 0.3 * sepScore + 0.3 * nb;
    if (top.dur < p.minSermon) confidence *= 0.5;
  }
  return { duration, noiseFloor, silenceThr, threshold, windows: w, score, segments, candidates, confidence };
}
