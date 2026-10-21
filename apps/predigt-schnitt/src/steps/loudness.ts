import { h, fmtDb, fmtNum, progressBar } from '../../../../packages/ui-kit/dom';
import { processOptions, measurementKey, type Ctx, type Step } from '../context';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, type ExportPresetId, type LoudnessPresetId } from '../settings';

/** Runs (or reuses) the loudness measurement for the current options. */
export async function ensureMeasurement(ctx: Ctx, onProgress: (p: number) => void) {
  const o = processOptions(ctx);
  const key = measurementKey(o);
  if (ctx.state.measurement && ctx.state.measurementKey === key) return ctx.state.measurement;
  const m = await ctx.worker.measure(o, onProgress);
  ctx.state.measurement = m;
  ctx.state.measurementKey = key;
  return m;
}

export function createLoudnessStep(ctx: Ctx): Step {
  const s = ctx.settings;
  const result = h('div', { class: 'measure-result' });
  const status = h('div');
  let running = false;
  let queued = false;

  const select = <T extends string>(options: Record<T, { label: string }>, value: T, onchange: (v: T) => void) => {
    const el = h('select', null, ...(Object.keys(options) as T[]).map(k => h('option', { value: k }, options[k].label)));
    el.value = value;
    el.addEventListener('change', () => onchange(el.value as T));
    return el;
  };
  const num = (value: number, min: number, max: number, step: number, onchange: (v: number) => void) => {
    const el = h('input', { type: 'number', min, max, step, value: String(value) });
    el.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, Number(el.value)));
      if (!isNaN(v)) onchange(v);
      el.value = String(v);
    });
    return el;
  };
  const check = (value: boolean, onchange: (v: boolean) => void) => {
    const el = h('input', { type: 'checkbox', checked: value });
    el.addEventListener('change', () => onchange(el.checked));
    return el;
  };
  const apply = (fn: () => void) => { fn(); ctx.saveSettings(); ctx.changed(); run(); };

  const lp = select(LOUDNESS_PRESETS, s.loudnessPreset, v => apply(() => { s.loudnessPreset = v as LoudnessPresetId; }));
  const ep = select(EXPORT_PRESETS, s.exportPreset, v => apply(() => { s.exportPreset = v as ExportPresetId; }));
  const hp = check(s.highpass, v => apply(() => { s.highpass = v; }));
  const comp = check(s.compressor, v => apply(() => { s.compressor = v; }));
  const fi = num(s.fadeIn, 0, 10, 0.1, v => apply(() => { s.fadeIn = v; }));
  const fo = num(s.fadeOut, 0, 10, 0.1, v => apply(() => { s.fadeOut = v; }));

  async function run() {
    if (running) { queued = true; return; }
    running = true;
    const bar = progressBar('Messe Lautheit …');
    status.replaceChildren(bar.el);
    try {
      const m = await ensureMeasurement(ctx, p => bar.set(p, 'Messe Lautheit …'));
      const target = LOUDNESS_PRESETS[s.loudnessPreset].lufs;
      result.replaceChildren(
        h('div', { class: 'lufs-flow' },
          h('div', { class: 'lufs-box' }, h('span', { class: 'muted small' }, 'Gemessen'), h('strong', null, `${fmtNum(m.inputLufs)} LUFS`)),
          h('span', { class: 'arrow' }, '→'),
          h('div', { class: 'lufs-box' }, h('span', { class: 'muted small' }, 'Anhebung'), h('strong', null, `${fmtDb(m.gainDb)} dB`)),
          h('span', { class: 'arrow' }, '→'),
          h('div', { class: 'lufs-box accent' }, h('span', { class: 'muted small' }, 'Ergebnis'), h('strong', null, `${fmtNum(m.predictedLufs)} LUFS`)),
        ),
        h('p', { class: 'muted small' },
          `Ziel ${fmtNum(target)} LUFS. Der Limiter greift maximal mit ${fmtNum(m.limiterReductionDb)} dB ein` +
          (s.compressor ? `; Kompressor aktiv (Nachverstärkung ${fmtDb(m.makeupDb)} dB).` : '.')),
        m.limited ? h('div', { class: 'notice warn' },
          `Die Aufnahme ist sehr leise. Die Anhebung ist auf ${fmtDb(s.maxGainDb, 0)} dB begrenzt, damit das Rauschen nicht zu laut wird – das Ergebnis bleibt daher unter dem Ziel.`) : '',
        Math.abs(m.predictedLufs - target) > 1 && !m.limited ? h('div', { class: 'notice warn' },
          'Das Ziel wird wegen starker Pegelspitzen nicht ganz erreicht. Der Kompressor kann helfen.') : '',
      );
      bar.done();
    } catch (e) {
      bar.done();
      result.replaceChildren(h('div', { class: 'notice error' }, `Messung fehlgeschlagen: ${(e as Error).message}`));
    } finally {
      running = false;
      if (queued) { queued = false; run(); }
    }
  }

  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '3 · Lautheit')),
    h('div', { class: 'grid' },
      h('label', null, 'Zielwert', lp),
      h('label', null, 'Export-Format (bestimmt Mono/Stereo)', ep),
    ),
    h('div', { class: 'grid', style: 'margin-top:.8rem' },
      h('label', null, 'Einblenden (s)', fi),
      h('label', null, 'Ausblenden (s)', fo),
      h('label', { class: 'check', title: 'Entfernt Trittschall, Rumpeln und Brummen unter 80 Hz' }, hp, 'Hochpass 80 Hz (empfohlen für Sprache)'),
      h('label', { class: 'check', title: 'Sanfter Kompressor 2:1 – gleicht unterschiedliche Abstände zum Mikrofon aus' }, comp, 'Sanfte Kompression 2:1'),
    ),
    status,
    result,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(1) }, '← Schnitt'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.goto(3) }, 'Weiter zum Export →')),
  );

  return {
    el,
    enter() {
      lp.value = s.loudnessPreset; ep.value = s.exportPreset;
      hp.checked = s.highpass; comp.checked = s.compressor;
      fi.value = String(s.fadeIn); fo.value = String(s.fadeOut);
      run();
    },
  };
}
