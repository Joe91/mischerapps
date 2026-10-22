// Detection benchmark and calibration helper (planning doc §3.5 / §10).
//
//   npm run bench                         all entries of testdata/markers.json
//   npm run bench -- some.mp3 other.mp3   just show suggestions for these files
//   npm run bench -- --csv                additionally write <file>.windows.csv (features + truth label)
//   npm run bench -- --render             also normalise/encode the sermon and compare LUFS with ffmpeg
//   npm run bench -- --render --denoise   … with room reverb/noise reduction (DeepFilterNet; --denoise=18: strength in dB)
//
// markers.json: [{ "file": "x.mp3", "start": "22:14.3", "end": "41:57.8" }, …]  (seconds or m:ss / h:mm:ss)
import { open, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import type { ByteSource } from '../packages/audio-core/decode';
import { analyzeSource, denoiseRange, measure, sourceReader, render, type ProcessOptions } from '../packages/audio-core/pipeline';
import { DENOISE_ATTEN_DB, loadDenoiser } from '../packages/denoise/denoise';
import { integrateSubBlocks } from '../packages/audio-core/loudness';
import type { WindowFeatures } from '../packages/audio-core/analysis';

const DIR = resolve(import.meta.dirname, '../testdata');

async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}

const parseTime = (v: string | number) => typeof v === 'number' ? v
  : v.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
const fmt = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = (s % 60).toFixed(1).padStart(4, '0');
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + r;
};

interface Entry { file: string; start?: string | number; end?: string | number; }

async function main() {
  const args = process.argv.slice(2);
  const csv = args.includes('--csv'), doRender = args.includes('--render');
  const dnArg = args.find(a => a.startsWith('--denoise'));
  const denoise = dnArg ? Number(dnArg.split('=')[1] ?? DENOISE_ATTEN_DB) : 0;
  if (denoise) await loadDenoiser(await readFile(resolve(import.meta.dirname, '../packages/denoise/df3.wasm')));
  const files = args.filter(a => !a.startsWith('--'));
  let entries: Entry[];
  if (files.length) entries = files.map(f => ({ file: resolve(f) }));
  else {
    const mp = resolve(DIR, 'markers.json');
    if (!existsSync(mp)) { console.error(`Keine ${mp}. Siehe testdata/README.md`); process.exit(1); }
    entries = JSON.parse(await readFile(mp, 'utf8'));
  }
  const rows: string[][] = [];
  const devs: number[] = [];
  for (const e of entries) {
    const path = resolve(DIR, e.file);
    const src = await fileSource(path);
    const t0 = performance.now();
    const a = await analyzeSource(src);
    const ms = performance.now() - t0;
    const c = a.result.candidates[0];
    const truth = e.start !== undefined && e.end !== undefined ? [parseTime(e.start), parseTime(e.end)] : null;
    const dS = truth && c ? c.start - truth[0] : NaN, dE = truth && c ? c.end - truth[1] : NaN;
    if (truth && c) devs.push(Math.abs(dS), Math.abs(dE));
    rows.push([
      basename(path).slice(0, 34), fmt(a.info.duration),
      c ? `${fmt(c.start)}–${fmt(c.end)}` : '–',
      truth ? `${fmt(truth[0])}–${fmt(truth[1])}` : '',
      truth ? `${dS >= 0 ? '+' : ''}${dS.toFixed(1)}` : '', truth ? `${dE >= 0 ? '+' : ''}${dE.toFixed(1)}` : '',
      a.result.confidence.toFixed(2), a.result.candidates.slice(1).map(x => `${fmt(x.start)}–${fmt(x.end)}`).join(' '),
      `${(ms / 1000).toFixed(1)}s`,
    ]);
    if (csv) await writeCsv(path + '.windows.csv', a.result.windows, a.result.score, truth);
    if (process.env.DEBUG) {
      console.log(basename(path), 'noise', a.result.noiseFloor.toFixed(1), 'silThr', a.result.silenceThr.toFixed(1), 'thr', a.result.threshold.toFixed(2));
      for (const s of a.result.segments) if (s.end - s.start > 4) console.log(`  ${s.kind.padEnd(7)} ${fmt(s.start)}–${fmt(s.end)}`);
    }
    if (doRender && c) await renderCheck(src, a, c.start, c.end, path, denoise);
    await src.close();
  }
  const head = ['Datei', 'Länge', 'Vorschlag', 'Soll', 'ΔStart', 'ΔEnde', 'Konf.', 'Alternativen', 'Zeit'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (r: string[]) => r.map((v, i) => v.padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map(w => '─'.repeat(w)).join('  '));
  rows.forEach(r => console.log(line(r)));
  if (devs.length) {
    const s = [...devs].sort((x, y) => x - y);
    console.log(`\nAbweichung |Δ| über ${devs.length} Marker: Median ${s[s.length >> 1].toFixed(1)} s, Max ${s[s.length - 1].toFixed(1)} s` +
      `  (Ziel: Median < 5 s, nie > 30 s)`);
  }
}

async function writeCsv(path: string, w: WindowFeatures, score: Float32Array, truth: number[] | null) {
  const keys = Object.keys(w) as (keyof WindowFeatures)[];
  const lines = [[...keys, 'score', 'truth'].join(',')];
  for (let k = 0; k < w.t.length; k++) {
    const t = w.t[k];
    const label = truth ? (t >= truth[0] && t <= truth[1] ? 'sermon' : 'other') : '';
    lines.push([...keys.map(key => w[key][k].toFixed(4)), score[k].toFixed(3), label].join(','));
  }
  await writeFile(path, lines.join('\n'));
  console.log('CSV:', path);
}

/** Exports like the app with its default settings; `denoise` is the strength in dB (0 = off). */
async function renderCheck(src: ByteSource, a: Awaited<ReturnType<typeof analyzeSource>>, start: number, end: number, path: string,
  denoiseDb: number) {
  const info = a.info, denoise = denoiseDb > 0;
  const o: ProcessOptions = {
    start, end, channels: 1, targetLufs: -19, truePeakDb: -1.5, highpass: true, compressor: true, denoise, denoiseDb,
    fadeIn: 0.5, fadeOut: 0.5, maxGainDb: 55,
  };
  const t0 = performance.now();
  const input = denoise ? await denoiseRange(src, info, o, { levelLufs: integrateSubBlocks(a.loudness, Math.floor(start * 10), Math.ceil(end * 10)) }) : sourceReader(src, info, start, end);
  if (denoise) console.log(`  Hall/Rauschen reduziert: ${((performance.now() - t0) / 1000).toFixed(1)} s für ${fmt(end - start)}`);
  const t1 = performance.now();
  const m = await measure(input, o, { kbps: 96 }, { loudness: a.loudness });
  const tMeasure = (performance.now() - t1) / 1000;
  const r = await render(input, o, m, { kbps: 96 });
  const out = path + (denoise ? `.predigt-dn${denoiseDb}.mp3` : '.predigt.mp3');
  await writeFile(out, r.mp3);
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr ?? '';
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(ff.slice(ff.lastIndexOf('Summary')))?.[1];
  const TP = /Peak:\s+(-?[\d.]+) dBFS/.exec(ff.slice(ff.lastIndexOf('Summary')))?.[1];
  console.log(`  Render ${basename(out)}: gemessen ${m.inputLufs.toFixed(1)} LUFS, Gain ${m.gainDb.toFixed(1)} dB → ` +
    `${r.outputLufs.toFixed(2)} LUFS (Prognose ${m.predictedLufs.toFixed(2)}, Limiter −${r.limiterReductionDb.toFixed(1)} dB), TP ${r.truePeakDb.toFixed(2)} dBTP, ${(r.mp3.length / 1e6).toFixed(1)} MB, ` +
    `Messung ${tMeasure.toFixed(1)} s + Export ${((performance.now() - t0) / 1000 - tMeasure).toFixed(1)} s | ffmpeg (decodiertes MP3): ${I ?? '?'} LUFS, TP ${TP ?? '?'} dBTP`);
}

main()
  .then(() => console.log(`Speicher (Spitze): ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`))
  .catch(e => { console.error(e); process.exit(1); });
