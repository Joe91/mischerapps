import { h, fmtDb, fmtNum, progressBar } from '../../../../packages/ui-kit/dom';
import type { Measurement } from '../../../../packages/audio-core/pipeline';
import { choices, processOptions, encodeOptions, measurementKey, type Ctx } from '../context';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, type Choices, type ExportPresetId, type LoudnessPresetId } from '../settings';

interface Job { key: string; analysis: unknown; promise: Promise<Measurement>; listeners: Set<(p: number) => void>; }
let running: Job | null = null;

/** Runs (or reuses) the loudness measurement for the current options; concurrent callers share one run. */
export function ensureMeasurement(ctx: Ctx, onProgress: (p: number) => void): Promise<Measurement> {
  const o = processOptions(ctx), e = encodeOptions(ctx);
  const key = measurementKey(o, e), analysis = ctx.state.analysis;
  if (ctx.state.measurement && ctx.state.measurementKey === key) return Promise.resolve(ctx.state.measurement);
  if (running && running.key === key && running.analysis === analysis) {
    running.listeners.add(onProgress);
    return running.promise;
  }
  const listeners = new Set([onProgress]);
  const promise: Promise<Measurement> = ctx.worker.measure(o, e, p => listeners.forEach(f => f(p)))
    .then(m => {
      // a recording loaded in the meantime must not inherit this result
      if (ctx.state.analysis === analysis) { ctx.state.measurement = m; ctx.state.measurementKey = key; }
      return m;
    })
    .finally(() => { if (running?.promise === promise) running = null; });
  running = { key, analysis, promise, listeners };
  return promise;
}

/**
 * Progress and outcome of the automatic loudness measurement. Normally only problems are shown;
 * in the advanced view also the measured level, the gain and the expected result.
 */
export function createMeasureView(ctx: Ctx) {
  const status = h('div');
  const result = h('div', { class: 'measure-result' });
  let busy = false;
  let queued = false;

  async function run() {
    if (busy) { queued = true; return; }
    busy = true;
    const bar = progressBar('Lautheit wird angepasst …');
    status.replaceChildren(bar.el);
    try {
      const m = await ensureMeasurement(ctx, p => bar.set(p, 'Lautheit wird angepasst …'));
      const c = choices(ctx), target = LOUDNESS_PRESETS[c.loudnessPreset].lufs;
      result.replaceChildren(
        ctx.state.advanced ? h('div', null,
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
        ) : '',
        m.limited ? h('div', { class: 'notice warn' },
          `Die Aufnahme ist sehr leise. Die Anhebung ist auf ${fmtDb(ctx.settings.maxGainDb, 0)} dB begrenzt, damit das Rauschen nicht zu laut wird – das Ergebnis bleibt daher unter dem Ziel.`) : '',
        Math.abs(m.predictedLufs - target) > 1 && !m.limited ? h('div', { class: 'notice warn' },
          'Das Ziel wird wegen starker Pegelspitzen nicht ganz erreicht.' + (c.compressor ? '' : ' Der Kompressor kann helfen.')) : '',
      );
      bar.done();
    } catch (e) {
      bar.done();
      result.replaceChildren(h('div', { class: 'notice error' }, `Messung fehlgeschlagen: ${(e as Error).message}`));
    } finally {
      busy = false;
      if (queued) { queued = false; run(); }
    }
  }

  return { el: h('div', null, status, result), run };
}

/**
 * The options the admin sets as defaults, editable for this one recording. Changes are not saved:
 * they live in ctx.state.overrides and are gone with the next recording (or when the view is closed).
 */
export function createAdvancedPanel(ctx: Ctx, onChange: () => void) {
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
  const num = (key: 'fadeIn' | 'fadeOut') => {
    const el = h('input', { type: 'number', min: 0, max: 10, step: 0.1 });
    el.addEventListener('change', () => {
      const v = Math.min(10, Math.max(0, Number(el.value)));
      if (!isNaN(v)) set(key, v);
      el.value = String(choices(ctx)[key]);
    });
    return el;
  };
  const check = (key: 'highpass' | 'compressor') => {
    const el = h('input', { type: 'checkbox' });
    el.addEventListener('change', () => set(key, el.checked));
    return el;
  };

  const lp = select<LoudnessPresetId>(LOUDNESS_PRESETS, 'loudnessPreset');
  const ep = select<ExportPresetId>(EXPORT_PRESETS, 'exportPreset');
  const fi = num('fadeIn'), fo = num('fadeOut');
  const hp = check('highpass'), comp = check('compressor');

  const el = h('div', { class: 'advanced' },
    h('p', { class: 'muted small' }, 'Gilt nur für diese Aufnahme. Die Standardwerte legt der Admin in den Einstellungen fest.'),
    h('div', { class: 'grid' },
      h('label', null, 'Zielwert', lp),
      h('label', null, 'Format (bestimmt Mono/Stereo)', ep),
      h('label', null, 'Einblenden (s)', fi),
      h('label', null, 'Ausblenden (s)', fo),
      h('label', { class: 'check', title: 'Entfernt Trittschall, Rumpeln und Brummen unter 80 Hz' }, hp, 'Hochpass 80 Hz (empfohlen für Sprache)'),
      h('label', { class: 'check', title: 'Sanfter Kompressor 2:1 – gleicht unterschiedliche Abstände zum Mikrofon aus' }, comp, 'Sanfte Kompression 2:1'),
    ),
  );

  return {
    el,
    sync() {
      const c = choices(ctx);
      lp.value = c.loudnessPreset; ep.value = c.exportPreset;
      fi.value = String(c.fadeIn); fo.value = String(c.fadeOut);
      hp.checked = c.highpass; comp.checked = c.compressor;
    },
  };
}
