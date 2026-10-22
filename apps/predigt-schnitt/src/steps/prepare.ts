import { h, fmtDb, fmtNum, progressBar } from '../../../../packages/ui-kit/dom';
import { covers, type DenoiseRange, type Measurement, type ProcessOptions } from '../../../../packages/audio-core/pipeline';
import { choices, processOptions, encodeOptions, measurementKey, type Ctx, type Prepared } from '../context';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, type Choices, type ExportPresetId, type LoudnessPresetId } from '../settings';

type Progress = (p: number, label: string) => void;

const currentKey = (ctx: Ctx) => measurementKey(processOptions(ctx), encodeOptions(ctx));

const outdated = () => new Error('Die Einstellungen wurden inzwischen geändert – bitte erneut exportieren.');

/** Stops waiting for `p` when `signal` aborts (the work behind `p` goes on). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    p.then(resolve, reject);
  });
}

/**
 * Runs jobs one after another. A caller asking for the key that is already running joins it (and its
 * progress). A new key aborts the running job, so its successor does not wait for outdated work; a
 * queued job whose options are outdated by the time it would start is dropped.
 */
function serialRunner<T>() {
  let job: { key: string; analysis: unknown; promise: Promise<T>; listeners: Set<Progress>; abort: AbortController } | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return (ctx: Ctx, key: string, onProgress: Progress, start: (progress: Progress, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const analysis = ctx.state.analysis;
    if (job && job.key === key && job.analysis === analysis) { job.listeners.add(onProgress); return job.promise; }
    job?.abort.abort(outdated());
    const listeners = new Set([onProgress]), abort = new AbortController();
    const promise: Promise<T> = tail.then(() => {
      if (ctx.state.analysis !== analysis || currentKey(ctx) !== key) throw outdated();
      return start((p, label) => listeners.forEach(f => f(p, label)), abort.signal);
    }).finally(() => { if (job?.promise === promise) job = null; });
    job = { key, analysis, promise, listeners, abort };
    tail = promise.catch(() => undefined);
    return promise;
  };
}

const measureRunner = serialRunner<Measurement>();
const prepareRunner = serialRunner<Prepared>();

/**
 * Denoising in the worker: the longest step (≈ 35× real time on 6 cores, 7× on one), measuring and
 * encoding run at 100× and more. It is a job of its own, so an option change that keeps the channels
 * (compression, loudness, …) carries on with it instead of starting over. It covers a window a bit
 * larger than the cut, starts already in the cut step (prefetchDenoising), and the markers can move
 * within the window without denoising again.
 */
let denoiseJob: { window: DenoiseRange; analysis: unknown; promise: Promise<void>; listeners: Set<(p: number) => void>; abort: AbortController } | null = null;

/** Seconds denoised beyond each marker, so that small corrections need no new pass (costs ~2 s each way). */
const DENOISE_MARGIN = 30;
const windowFor = (o: DenoiseRange): DenoiseRange =>
  ({ start: Math.max(0, o.start - DENOISE_MARGIN), end: o.end + DENOISE_MARGIN, channels: o.channels, denoiseDb: o.denoiseDb });

const DENOISE_LABEL = 'Hall und Rauschen werden reduziert …';

const denoisePending = (ctx: Ctx, o: ProcessOptions) => o.denoise && !(ctx.state.denoised && covers(ctx.state.denoised, o));

function ensureDenoised(ctx: Ctx, o: DenoiseRange, onProgress: (p: number) => void): Promise<void> {
  const analysis = ctx.state.analysis;
  if (ctx.state.denoised && covers(ctx.state.denoised, o)) return Promise.resolve();
  if (denoiseJob && denoiseJob.analysis === analysis && covers(denoiseJob.window, o)) {
    denoiseJob.listeners.add(onProgress);
    return denoiseJob.promise;
  }
  denoiseJob?.abort.abort(outdated());
  ctx.state.denoised = null; // the worker drops its copy when it starts the new one
  const window = windowFor(o), listeners = new Set([onProgress]), abort = new AbortController();
  const promise = ctx.worker.denoise(window, p => listeners.forEach(f => f(p)), abort.signal).then(() => {
    if (ctx.state.analysis === analysis) ctx.state.denoised = window;
  }).finally(() => { if (denoiseJob?.promise === promise) denoiseJob = null; });
  denoiseJob = { window, analysis, promise, listeners, abort };
  return promise;
}

/** Stops denoising the current options do not need (switched off, cut outside the window), so the worker is free. */
function dropUnneededDenoising(ctx: Ctx, o: ProcessOptions) {
  if (denoiseJob && (!o.denoise || !covers(denoiseJob.window, o) || denoiseJob.analysis !== ctx.state.analysis)) {
    denoiseJob.abort.abort(outdated());
    denoiseJob = null;
  }
}

/**
 * Starts denoising the current cut in the background while it is still being set, so that the
 * export is (nearly) ready when the details are filled in. Does nothing when the option is off or
 * the cut lies inside the window already denoised (or being denoised).
 */
export function prefetchDenoising(ctx: Ctx) {
  const o = processOptions(ctx);
  if (o.denoise && ctx.state.analysis && o.end > o.start) ensureDenoised(ctx, o, () => undefined).catch(() => undefined);
}

/** Gain, compression and limiter settings for the current options (cached per recording and options). */
export function ensureMeasurement(ctx: Ctx, onProgress: Progress = () => undefined): Promise<Measurement> {
  const o = processOptions(ctx), e = encodeOptions(ctx), key = measurementKey(o, e);
  if (ctx.state.measurement && ctx.state.measurementKey === key) return Promise.resolve(ctx.state.measurement);
  dropUnneededDenoising(ctx, o);
  return measureRunner(ctx, key, onProgress, async (progress, signal) => {
    const analysis = ctx.state.analysis;
    const share = denoisePending(ctx, o) ? 0.85 : 0;
    if (o.denoise) await abortable(ensureDenoised(ctx, o, p => progress(p * share, DENOISE_LABEL)), signal);
    const m = await ctx.worker.measure(o, e, p => progress(share + p * (1 - share), 'Lautheit wird gemessen …'), signal);
    // a recording loaded in the meantime must not inherit this result
    if (ctx.state.analysis === analysis) { ctx.state.measurement = m; ctx.state.measurementKey = key; }
    return m;
  });
}

/**
 * Measures and encodes the MP3 for the current options, without tags. Started as soon as the export
 * step opens, so that the export itself only has to add the tags.
 */
export function ensurePrepared(ctx: Ctx, onProgress: Progress): Promise<Prepared> {
  const o = processOptions(ctx), e = encodeOptions(ctx), key = measurementKey(o, e);
  if (ctx.state.prepared?.key === key) return Promise.resolve(ctx.state.prepared);
  dropUnneededDenoising(ctx, o);
  return prepareRunner(ctx, key, onProgress, async (progress, signal) => {
    const analysis = ctx.state.analysis;
    // denoising takes most of the time (21 min sermon, 6 cores: 37 s of 57 s); measuring about 30 % of the rest (30 min sermon: 8 s measuring,
    // 18 s encoding + checking)
    const measured = !!ctx.state.measurement && ctx.state.measurementKey === key;
    const dn = denoisePending(ctx, o) ? 0.65 : 0, split = dn + (measured ? 0 : 0.3 * (1 - dn));
    if (o.denoise) await abortable(ensureDenoised(ctx, o, p => progress(p * dn, DENOISE_LABEL)), signal);
    const m = await abortable(ensureMeasurement(ctx, (p, label) => progress(dn + p * (split - dn), label)), signal);
    const encode = (label: string) => (p: number) => progress(split + p * (1 - split), label);
    let r = await ctx.worker.render(o, m, e, encode('MP3 wird erstellt …'), signal);
    // MP3 coding can push peaks over the limit, or miss the loudness slightly: correct once.
    const delta = o.targetLufs - r.outputLufs;
    const overshoot = r.truePeakDb - o.truePeakDb;
    const headroom = o.maxGainDb - m.gainDb;
    if ((Math.abs(delta) > 0.3 && headroom > 0.1) || overshoot > 0.05) {
      const d = Math.min(delta, headroom);
      const m2 = {
        ...m, gainDb: m.gainDb + d,
        ...(o.compressor ? { makeupDb: m.makeupDb + d } : { preGainDb: m.preGainDb + d }),
        ceilingDb: m.ceilingDb - Math.max(0, overshoot + 0.2),
      };
      r = await ctx.worker.render(o, m2, e, encode('Feinkorrektur …'), signal);
    }
    const { mp3, ...stats } = r;
    const prepared = { key, mp3, stats };
    if (ctx.state.analysis === analysis) ctx.state.prepared = prepared;
    return prepared;
  });
}

/**
 * Progress and outcome of the preparation. Problems are always shown; the measured level, gain and
 * expected result go into `details`, which sits in the advanced panel.
 */
export function createPrepareView(ctx: Ctx) {
  const status = h('div');
  const notices = h('div');
  const details = h('div', { class: 'measure-details' });

  function showMeasurement(m: Measurement) {
    const c = choices(ctx), target = LOUDNESS_PRESETS[c.loudnessPreset].lufs;
    details.replaceChildren(
      h('div', { class: 'lufs-flow' },
        h('div', { class: 'lufs-box' }, h('span', { class: 'muted small' }, 'Gemessen'), h('strong', null, `${fmtNum(m.inputLufs)} LUFS`)),
        h('span', { class: 'arrow' }, '→'),
        h('div', { class: 'lufs-box' }, h('span', { class: 'muted small' }, 'Anhebung'), h('strong', null, `${fmtDb(m.gainDb)} dB`)),
        h('span', { class: 'arrow' }, '→'),
        h('div', { class: 'lufs-box accent' }, h('span', { class: 'muted small' }, 'Ergebnis'), h('strong', null, `${fmtNum(m.predictedLufs)} LUFS`)),
      ),
      h('p', { class: 'muted small' },
        `Ziel ${fmtNum(target)} LUFS. Der Limiter greift maximal mit ${fmtNum(m.limiterReductionDb)} dB ein` +
        (c.compressor ? `; Kompressor aktiv (Nachverstärkung ${fmtDb(m.makeupDb)} dB).` : '.')),
    );
    notices.replaceChildren(
      m.limited ? h('div', { class: 'notice warn' },
        `Die Aufnahme ist sehr leise. Die Anhebung ist auf ${fmtDb(ctx.settings.maxGainDb, 0)} dB begrenzt, damit das Rauschen nicht zu laut wird – das Ergebnis bleibt daher unter dem Ziel.`) : '',
      Math.abs(m.predictedLufs - target) > 1 && !m.limited ? h('div', { class: 'notice warn' },
        'Das Ziel wird wegen starker Pegelspitzen nicht ganz erreicht.' + (c.compressor ? '' : ' Die Kompression kann helfen.')) : '',
    );
  }

  /** Prepares the MP3 for the current options; shows progress until then. Only the latest call updates the view. */
  async function run(): Promise<Prepared> {
    const bar = progressBar('Wird vorbereitet …');
    status.replaceChildren(bar.el);
    const latest = () => status.contains(bar.el);
    details.replaceChildren();
    notices.replaceChildren();
    ensureMeasurement(ctx).then(m => { if (latest()) showMeasurement(m); }, () => undefined);
    try {
      const p = await ensurePrepared(ctx, (x, label) => bar.set(x, label));
      if (latest()) status.replaceChildren(h('p', { class: 'muted small ready' }, '✓ Lautheit angepasst, MP3 vorbereitet.'));
      return p;
    } catch (e) {
      if (latest()) {
        status.replaceChildren();
        notices.replaceChildren(h('div', { class: 'notice error' }, `Vorbereitung fehlgeschlagen: ${(e as Error).message}`));
      }
      throw e;
    }
  }

  /** For calls nobody waits for: the view shows the outcome. */
  const start = () => { run().catch(() => undefined); };

  return { el: h('div', null, status, notices), details, run, start };
}

/**
 * The options the admin sets as defaults, editable for this one recording. Changes are not saved:
 * they live in ctx.state.overrides and are gone with the next recording (or when the view is closed).
 */
export function createAdvancedPanel(ctx: Ctx, details: HTMLElement, onChange: () => void) {
  const set = <K extends keyof Choices>(key: K, value: Choices[K]) => {
    if (value === ctx.settings[key]) delete ctx.state.overrides[key];
    else ctx.state.overrides[key] = value;
    onChange();
  };
  const select = <T extends string>(options: Record<T, { label: string }>, key: 'loudnessPreset' | 'exportPreset') => {
    const el = h('select', null, ...(Object.keys(options) as T[]).map(k => h('option', { value: k }, options[k].label)));
    el.addEventListener('change', () => set(key, el.value as never));
    return el;
  };
  const seconds = (label: string, key: 'fadeIn' | 'fadeOut') => {
    const input = h('input', { type: 'number', min: 0, max: 10, step: 0.1, inputmode: 'decimal' });
    input.addEventListener('change', () => {
      const v = Math.min(10, Math.max(0, Number(input.value)));
      if (!isNaN(v)) set(key, v);
      input.value = String(choices(ctx)[key]);
    });
    return { input, el: h('label', { class: 'inline' }, h('span', null, label), h('span', { class: 'unit' }, input, 's')) };
  };
  const check = (label: string, hint: string, key: 'highpass' | 'compressor' | 'denoise') => {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => set(key, input.checked));
    return { input, el: h('label', { class: 'check-hint' }, input, h('span', null, label), h('small', null, hint)) };
  };
  const group = (title: string, ...children: Node[]) => h('div', { class: 'adv-group' }, h('h4', null, title), ...children);

  const lp = select<LoudnessPresetId>(LOUDNESS_PRESETS, 'loudnessPreset');
  const ep = select<ExportPresetId>(EXPORT_PRESETS, 'exportPreset');
  const fi = seconds('Einblenden', 'fadeIn'), fo = seconds('Ausblenden', 'fadeOut');
  const hp = check('Hochpass 80 Hz', 'Entfernt Trittschall, Rumpeln und Brummen – empfohlen für Sprache', 'highpass');
  const comp = check('Sanfte Kompression 2:1', 'Gleicht unterschiedliche Abstände zum Mikrofon aus', 'compressor');
  const dn = check('Hall & Rauschen reduzieren', 'KI-Filter: weniger Nachhall des Raums und Hintergrundrauschen – dauert je nach Rechner etwa 1–3 Minuten', 'denoise');

  const el = h('div', { class: 'advanced' },
    h('div', { class: 'advanced-head' },
      h('h3', null, 'Erweiterte Einstellungen'),
      h('span', { class: 'muted small' }, 'Gilt nur für diese Aufnahme – die Standardwerte legt der Admin fest.'),
    ),
    h('div', { class: 'adv-groups' },
      group('Lautheit & Format', h('label', null, 'Zielwert', lp), h('label', null, 'Format (bestimmt Mono/Stereo)', ep)),
      group('Übergänge', fi.el, fo.el),
      group('Klang', hp.el, comp.el, dn.el),
    ),
    details,
  );

  return {
    el,
    sync() {
      const c = choices(ctx);
      lp.value = c.loudnessPreset; ep.value = c.exportPreset;
      fi.input.value = String(c.fadeIn); fo.input.value = String(c.fadeOut);
      hp.input.checked = c.highpass; comp.input.checked = c.compressor; dn.input.checked = c.denoise;
    },
  };
}
