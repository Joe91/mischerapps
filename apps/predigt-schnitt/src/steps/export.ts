import { h, fmtTime, fmtNum, fmtBytes, progressBar, download } from '../../../../packages/ui-kit/dom';
import type { Tags } from '../../../../packages/audio-core/pipeline';
import { processOptions, encodeOptions, measurementKey, type Ctx, type Step } from '../context';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, type ExportPresetId } from '../settings';
import { buildFileName, sanitizeFileName } from '../naming';
import { ensureMeasurement } from './loudness';

async function coverFromDataUrl(dataUrl: string): Promise<Tags['cover']> {
  if (!dataUrl) return undefined;
  const res = await fetch(dataUrl);
  return { data: await res.arrayBuffer(), mime: res.headers.get('content-type') ?? 'image/jpeg' };
}

export function createExportStep(ctx: Ctx): Step {
  const s = ctx.settings, st = ctx.state;
  const status = h('div');
  const result = h('div');
  let running = false;

  const field = (label: string, key: keyof typeof st.meta, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { ...attrs, value: st.meta[key] });
    input.addEventListener('input', () => { st.meta[key] = input.value; updateName(); markStale(); });
    return { label: h('label', null, label, input), input };
  };
  const title = field('Titel', 'title', { placeholder: 'z. B. Predigt über Lukas 18' });
  const preacher = field('Prediger/in', 'preacher');
  const date = field('Datum', 'date', { type: 'date' });
  const scripture = field('Bibelstelle', 'scripture', { placeholder: 'z. B. Lk 18,1-8' });
  const album = field('Gemeinde (Album)', 'album');

  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  nameInput.addEventListener('input', () => { st.fileNameEdited = true; st.fileName = nameInput.value; });
  nameInput.addEventListener('change', () => { st.fileName = sanitizeFileName(nameInput.value); nameInput.value = st.fileName; });
  const resetName = h('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', title: 'Dateinamen aus Datum und Titel neu bilden',
    onclick: () => { st.fileNameEdited = false; updateName(); },
  }, '↺');

  const preset = h('select', null, ...(Object.keys(EXPORT_PRESETS) as ExportPresetId[]).map(k => h('option', { value: k }, EXPORT_PRESETS[k].label)));
  preset.addEventListener('change', () => { s.exportPreset = preset.value as ExportPresetId; ctx.saveSettings(); ctx.changed(); markStale(); });

  function updateName() {
    if (!st.fileNameEdited) st.fileName = buildFileName(s.namePattern, st.meta);
    if (document.activeElement !== nameInput) nameInput.value = st.fileName;
  }

  const tags = (): Tags => ({
    title: st.meta.title.trim() || undefined,
    artist: st.meta.preacher.trim() || undefined,
    album: st.meta.album.trim() || undefined,
    year: Number(st.meta.date.slice(0, 4)) || undefined,
    comment: [st.meta.scripture.trim(), st.meta.date].filter(Boolean).join(' · ') || undefined,
  });
  const renderKey = () => JSON.stringify({ o: processOptions(ctx), p: s.exportPreset, t: tags(), c: s.coverDataUrl.length });

  function markStale() {
    if (st.rendered && st.rendered.key !== renderKey()) {
      result.querySelector('.stale')?.classList.remove('hidden');
    }
  }

  async function run() {
    if (running) return;
    running = true;
    exportBtn.disabled = true;
    st.fileName = sanitizeFileName(nameInput.value || st.fileName);
    nameInput.value = st.fileName;
    const bar = progressBar('');
    status.replaceChildren(bar.el);
    try {
      const o = processOptions(ctx);
      const needMeasure = !(st.measurement && st.measurementKey === measurementKey(o, encodeOptions(ctx)));
      const split = needMeasure ? 0.4 : 0;
      const m = await ensureMeasurement(ctx, p => bar.set(p * split, 'Lautheit messen …'));
      const ep = EXPORT_PRESETS[s.exportPreset];
      const key = renderKey();
      const t = { ...tags(), cover: await coverFromDataUrl(s.coverDataUrl) };
      let r = await ctx.worker.render(o, m, { kbps: ep.kbps }, t, p => bar.set(split + p * (1 - split), 'Bearbeiten & kodieren …'));
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
        r = await ctx.worker.render(o, m2, { kbps: ep.kbps }, t, p => bar.set(p, 'Feinkorrektur …'));
      }
      bar.done();
      if (st.rendered) URL.revokeObjectURL(st.rendered.url);
      const blob = new Blob([r.mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' });
      const { mp3: _mp3, ...stats } = r;
      st.rendered = { blob, url: URL.createObjectURL(blob), stats, key };
      st.uploadedAs = null;
      showResult();
      ctx.updateNav();
    } catch (e) {
      bar.done();
      status.replaceChildren(h('div', { class: 'notice error' }, `Export fehlgeschlagen: ${(e as Error).message}`));
    } finally {
      running = false;
      exportBtn.disabled = false;
    }
  }

  function showResult() {
    const r = st.rendered;
    if (!r) { result.replaceChildren(); return; }
    const target = LOUDNESS_PRESETS[s.loudnessPreset];
    const tpOk = r.stats.truePeakDb <= target.tp + 0.05;
    result.replaceChildren(
      h('div', { class: 'notice warn stale hidden' }, 'Einstellungen oder Angaben wurden geändert – bitte erneut exportieren, damit die Datei aktuell ist.'),
      h('div', { class: 'result-box' },
        h('audio', { controls: true, src: r.url, preload: 'metadata' }),
        h('dl', { class: 'stats' },
          h('dt', null, 'Länge'), h('dd', null, fmtTime(r.stats.duration, false)),
          h('dt', null, 'Größe'), h('dd', null, fmtBytes(r.blob.size)),
          h('dt', null, 'Lautheit'), h('dd', null, `${fmtNum(r.stats.outputLufs)} LUFS (Ziel ${fmtNum(target.lufs)})`),
          h('dt', null, 'True Peak'), h('dd', { class: tpOk ? '' : 'warn-text' }, `${fmtNum(r.stats.truePeakDb)} dBTP (max. ${fmtNum(target.tp)})`),
        ),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => download(r.blob, st.fileName) }, '⬇ Herunterladen'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.goto(4) }, 'Weiter zum Upload →'),
      ),
    );
    markStale();
  }

  const exportBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'MP3 exportieren');

  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '4 · Export')),
    h('div', { class: 'grid' }, title.label, preacher.label, date.label, scripture.label, album.label),
    h('div', { class: 'grid', style: 'margin-top:.8rem' },
      h('label', null, 'Format', preset),
      h('label', null, 'Dateiname', h('div', { class: 'row nowrap' }, nameInput, resetName)),
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(2) }, '← Lautheit'),
      exportBtn),
    status,
    result,
  );

  return {
    el,
    enter() {
      title.input.value = st.meta.title; preacher.input.value = st.meta.preacher; date.input.value = st.meta.date;
      scripture.input.value = st.meta.scripture; album.input.value = st.meta.album;
      preset.value = s.exportPreset;
      updateName();
      if (!st.rendered) { result.replaceChildren(); status.replaceChildren(); }
      else showResult();
    },
  };
}
