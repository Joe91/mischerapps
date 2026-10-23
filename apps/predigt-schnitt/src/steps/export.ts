import { h, fmtTime, fmtNum, fmtBytes, download } from '../../../../packages/ui-kit/dom';
import { tagMp3, type Tags } from '../../../../packages/audio-core/tags';
import { choices, processOptions, STEP, type Ctx, type Step } from '../context';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, coverUrl } from '../settings';
import { buildFileName, sanitizeFileName } from '../naming';
import { fetchOverview } from '../overview';
import { autoTags, commentFor } from '../tagging';
import { createAdvancedPanel, createPrepareView } from './prepare';

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

  type TextKey = 'title' | 'preacher' | 'date' | 'scripture' | 'album';
  const field = (label: string, key: TextKey, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { ...attrs, value: st.meta[key] });
    input.addEventListener('input', () => {
      st.meta[key] = input.value;
      if (key === 'date') void fromOverview(); else st.metaEdited.add(key);
      updateName(); markStale();
    });
    return { label: h('label', null, label, input), input };
  };
  const title = field('Titel', 'title', { placeholder: 'z. B. Predigt über Lukas 18' });
  const preacher = field('Prediger/in', 'preacher');
  const date = field('Datum', 'date', { type: 'date' });
  const scripture = field('Bibelstelle', 'scripture', { placeholder: 'z. B. Lk 18,1-8' });
  const album = field('Album (Predigtreihe)', 'album');
  const overviewHint = h('p', { class: 'muted small overview-hint' });

  /**
   * Title, album, preacher and number for the date, from the eAg-Übersicht (rules in tagging.ts): "Zeit - 04",
   * without series "Predigt vom 18.10.2026". Fields typed in by hand stay as they are.
   */
  let lookups = 0;
  async function fromOverview() {
    const n = ++lookups, day = st.meta.date;
    const o = await fetchOverview(day);
    if (n !== lookups || day !== st.meta.date) return;
    const auto = autoTags(s, day, o === 'unavailable' ? null : o);
    const set = (key: Exclude<TextKey, 'date'>, value: string) => { if (!st.metaEdited.has(key)) st.meta[key] = value; };
    st.meta.series = auto.series;
    st.meta.track = auto.track;
    set('title', auto.title);
    set('album', auto.album);
    set('preacher', auto.artist);
    overviewHint.textContent = o === 'unavailable' ? ''
      : !o ? 'Für dieses Datum steht nichts in der eAg-Übersicht.'
      : 'Aus der eAg-Übersicht: ' + [o.series ? `Reihe „${o.series}“, ${o.index}. Predigt` : 'keine Predigtreihe', o.preacher && `Prediger/in ${o.preacher}`].filter(Boolean).join(' · ');
    title.input.value = st.meta.title; album.input.value = st.meta.album; preacher.input.value = st.meta.preacher;
    updateName();
    markStale();
  }

  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  nameInput.addEventListener('input', () => { st.fileNameEdited = true; st.fileName = nameInput.value; });
  nameInput.addEventListener('change', () => { st.fileName = sanitizeFileName(nameInput.value); nameInput.value = st.fileName; });
  const resetName = h('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', title: 'Dateinamen aus Datum und Titel neu bilden',
    onclick: () => { st.fileNameEdited = false; updateName(); },
  }, '↺');

  // Loudness, compression and format come from the admin's defaults and are applied automatically;
  // the advanced view overrides them for this recording only. The MP3 is prepared in the background
  // while the details are filled in; exporting then only adds the tags.
  const prepare = createPrepareView(ctx);
  const advanced = createAdvancedPanel(ctx, prepare.details, optionsChanged);
  const summary = h('span', { class: 'muted small' });
  const advancedBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => setAdvanced(!st.advanced) }, '⚙ Erweitert');

  function setAdvanced(on: boolean) {
    st.advanced = on;
    if (!on) st.overrides = {}; // closing the view returns to the defaults
    showAdvanced();
    optionsChanged();
  }

  function showAdvanced() {
    advancedBtn.setAttribute('aria-expanded', String(st.advanced));
    advancedBtn.classList.toggle('active', st.advanced);
    advanced.el.classList.toggle('hidden', !st.advanced);
    if (st.advanced) advanced.sync();
    showSummary();
  }

  function showSummary() {
    const c = choices(ctx), lp = LOUDNESS_PRESETS[c.loudnessPreset], ep = EXPORT_PRESETS[c.exportPreset];
    summary.textContent = 'Wird automatisch angepasst: ' + [
      `Lautheit ${fmtNum(lp.lufs, 0)} LUFS`, c.highpass && 'Hochpass', c.compressor && 'Kompression', c.denoise && 'Raumklang reduziert',
      `MP3 ${ep.channels === 1 ? 'Mono' : 'Stereo'}, ${ep.kbps} kbps`,
    ].filter(Boolean).join(' · ');
  }

  function optionsChanged() {
    showSummary();
    ctx.changed();
    markStale();
    prepare.start();
  }

  function updateName() {
    if (!st.fileNameEdited) st.fileName = buildFileName(s.namePattern, st.meta);
    if (document.activeElement !== nameInput) nameInput.value = st.fileName;
  }

  const tags = (): Tags => ({
    title: st.meta.title.trim() || undefined,
    artist: st.meta.preacher.trim() || undefined,
    album: st.meta.album.trim() || undefined,
    albumArtist: s.albumArtist.trim() || undefined,
    genre: s.genre.trim() || undefined,
    date: st.meta.date || undefined,
    year: Number(st.meta.date.slice(0, 4)) || undefined,
    comment: commentFor(st.meta.scripture, st.meta.date) || undefined,
    track: st.meta.track || undefined,
  });
  const renderKey = () => JSON.stringify({ o: processOptions(ctx), p: choices(ctx).exportPreset, t: tags(), c: coverUrl(s).length });

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
    status.replaceChildren();
    try {
      const key = renderKey(), t = tags();
      const p = await prepare.run();
      const mp3 = tagMp3(p.mp3, { ...t, cover: await coverFromDataUrl(coverUrl(s)) });
      if (st.rendered) URL.revokeObjectURL(st.rendered.url);
      const blob = new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' });
      st.rendered = { blob, url: URL.createObjectURL(blob), stats: p.stats, key };
      st.uploadedAs = null;
      showResult();
      ctx.updateNav();
    } catch (e) {
      status.replaceChildren(h('div', { class: 'notice error' }, `Export fehlgeschlagen: ${(e as Error).message}`));
    } finally {
      running = false;
      exportBtn.disabled = false;
    }
  }

  function showResult() {
    const r = st.rendered;
    if (!r) { result.replaceChildren(); return; }
    const target = LOUDNESS_PRESETS[choices(ctx).loudnessPreset];
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
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.goto(STEP.upload) }, 'Weiter zum Upload →'),
      ),
    );
    markStale();
  }

  const exportBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'MP3 exportieren');

  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '3 · Export')),
    h('div', { class: 'grid' }, title.label, preacher.label, date.label, scripture.label, album.label),
    overviewHint,
    h('label', { class: 'file-name' }, 'Dateiname', h('div', { class: 'row nowrap' }, nameInput, resetName)),
    h('div', { class: 'row options' }, summary, h('span', { class: 'spacer' }), advancedBtn),
    advanced.el,
    prepare.el,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(STEP.cut) }, '← Schnitt'),
      exportBtn),
    status,
    result,
  );

  return {
    el,
    enter() {
      title.input.value = st.meta.title; preacher.input.value = st.meta.preacher; date.input.value = st.meta.date;
      scripture.input.value = st.meta.scripture; album.input.value = st.meta.album;
      updateName();
      showAdvanced();
      void fromOverview();
      prepare.start(); // loudness and MP3 are worked out while the details are filled in
      if (!st.rendered) { result.replaceChildren(); status.replaceChildren(); }
      else showResult();
    },
  };
}
