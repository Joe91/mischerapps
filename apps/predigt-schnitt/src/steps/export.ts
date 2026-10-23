import { h, fmtTime, fmtNum, fmtBytes, download, progressBar, toast } from '../../../../packages/ui-kit/dom';
import { tagMp3, type Tags } from '../../../../packages/audio-core/tags';
import { isAdmin, publishTarget } from '../../../../packages/auth/auth';
import { isPublished, replaceUpload, uploadFile } from '../../../../packages/upload/http-upload';
import { choices, processOptions, STEP, type Ctx, type Rendered, type Step } from '../context';
import { EXPORT_PRESETS, LOUDNESS_PRESETS, coverUrl } from '../settings';
import { buildFileName, isValidFileName, sanitizeFileName } from '../naming';
import { fetchOverview } from '../overview';
import { autoTags, commentFor } from '../tagging';
import { createAdvancedPanel, createPrepareView } from './prepare';

async function coverFromDataUrl(dataUrl: string): Promise<Tags['cover']> {
  if (!dataUrl) return undefined;
  const res = await fetch(dataUrl);
  return { data: await res.arrayBuffer(), mime: res.headers.get('content-type') ?? 'image/jpeg' };
}

/**
 * The last step: details (filled in from the eAg-Übersicht), then "Veröffentlichen" creates the MP3 and uploads it
 * in one go – to the shared folder in OpenCloud (see server/sermon-store.ts). The MP3 is prepared in the background
 * while the details are filled in, so publishing mostly waits for the upload.
 */
export function createExportStep(ctx: Ctx): Step {
  const s = ctx.settings, st = ctx.state;
  const status = h('div');
  const result = h('div');
  let busy = false;
  let abort: (() => void) | null = null;

  type TextKey = 'title' | 'preacher' | 'date' | 'scripture' | 'album';
  const field = (label: string, key: TextKey, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { ...attrs, value: st.meta[key] });
    input.addEventListener('input', () => {
      st.meta[key] = input.value;
      if (key === 'date') void fromOverview(); else st.metaEdited.add(key);
      updateName(); markStale(); showMissing();
    });
    return { label: h('label', null, label, input), input };
  };
  const title = field('Titel', 'title', { placeholder: 'z. B. Predigt über Lukas 18' });
  const preacher = field('Prediger/in', 'preacher', { placeholder: 'Name' });
  const date = field('Datum', 'date', { type: 'date' });
  const scripture = field('Bibelstelle', 'scripture', { placeholder: 'z. B. Lk 18,1-8' });
  const album = field('Album (Predigtreihe)', 'album');
  const overviewHint = h('p', { class: 'muted small overview-hint' });
  const missingHint = h('p', { class: 'field-warn' });

  /** An empty preacher is easy to overlook: the field and a line below say so. */
  function showMissing() {
    const missing = !st.meta.preacher.trim();
    preacher.label.classList.toggle('missing', missing);
    missingHint.textContent = missing ? 'Prediger/in fehlt – bitte eintragen.' : '';
  }

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
    showMissing();
  }

  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  nameInput.addEventListener('input', () => { st.fileNameEdited = true; st.fileName = nameInput.value; checkName(); });
  nameInput.addEventListener('change', () => { st.fileName = sanitizeFileName(nameInput.value); nameInput.value = st.fileName; checkName(); });
  const resetName = h('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', title: 'Dateinamen aus Datum und Titel neu bilden',
    onclick: () => { st.fileNameEdited = false; updateName(); },
  }, '↺');
  const nameNote = h('div');

  /** Whether the name is taken – found out while the details are filled in, not after all the work. */
  let taken: { name: string; exists: boolean | null } = { name: '', exists: null };
  let nameTimer = 0;
  function checkName() {
    clearTimeout(nameTimer);
    nameTimer = window.setTimeout(async () => {
      const name = sanitizeFileName(st.fileName);
      if (!isValidFileName(name)) return;
      const exists = await isPublished(name);
      if (name !== sanitizeFileName(st.fileName)) return;
      taken = { name, exists };
      showButtons();
    }, 300);
  }
  const nameTaken = () => !st.uploadedAs && taken.exists === true && taken.name === sanitizeFileName(st.fileName);

  // Loudness, compression and format come from the admin's defaults and are applied automatically;
  // the advanced view overrides them for this recording only.
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
    checkName();
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

  /** Details or options changed after the MP3 was made: it is made again (published already: not that file any more). */
  function markStale() {
    if (st.rendered && st.rendered.key !== renderKey()) result.querySelector('.stale')?.classList.remove('hidden');
  }

  /** The tagged MP3 for the current details and options (made again only if they changed). */
  async function create(): Promise<Rendered> {
    const key = renderKey();
    if (st.rendered?.key === key) return st.rendered;
    const t = tags();
    const p = await prepare.run();
    const mp3 = tagMp3(p.mp3, { ...t, cover: await coverFromDataUrl(coverUrl(s)) });
    if (st.rendered) URL.revokeObjectURL(st.rendered.url);
    const blob = new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' });
    st.rendered = { blob, url: URL.createObjectURL(blob), stats: p.stats, key };
    return st.rendered;
  }

  function takeName(): string | null {
    st.fileName = sanitizeFileName(nameInput.value || st.fileName);
    nameInput.value = st.fileName;
    if (!isValidFileName(st.fileName)) { toast('Ungültiger Dateiname.', 'error'); return null; }
    return st.fileName;
  }

  async function publish() {
    const name = takeName();
    if (busy || !name) return;
    const replace = nameTaken() && isAdmin();
    if (replace && !confirm(`${name} ist schon veröffentlicht. Ersetzen?\n\nDie bisherige Fassung bleibt auf dem NAS (data/original/) erhalten.`)) return;
    busy = true;
    showButtons();
    status.replaceChildren();
    try {
      const r = await create();
      showResult();
      const bar = progressBar('Lade hoch …');
      const cancel = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => abort?.() }, 'Abbrechen');
      status.replaceChildren(h('div', { class: 'row' }, bar.el, cancel));
      const progress = (p: number, stored?: boolean) => {
        bar.set(p, stored ? `Wird in ${publishTarget()} gespeichert …` : 'Lade hoch …');
        if (stored) cancel.remove(); // the server finishes it now
      };
      const up = replace ? replaceUpload(name, r.blob, progress) : uploadFile(r.blob, name, progress);
      abort = up.abort;
      await up.promise;
      st.uploadedAs = name;
      taken = { name, exists: true };
      status.replaceChildren(h('div', { class: 'notice ok' },
        `${replace ? 'Ersetzt' : 'Veröffentlicht'}: ${name} → ${publishTarget()}`));
    } catch (e) {
      status.replaceChildren(h('div', { class: 'notice error' }, (e as Error).message));
    } finally {
      busy = false;
      abort = null;
      showButtons();
      showResult();
    }
  }

  async function downloadOnly() {
    const name = takeName();
    if (busy || !name) return;
    busy = true;
    showButtons();
    try {
      download((await create()).blob, name);
      showResult();
    } catch (e) {
      status.replaceChildren(h('div', { class: 'notice error' }, `Erstellen fehlgeschlagen: ${(e as Error).message}`));
    } finally {
      busy = false;
      showButtons();
    }
  }

  function showResult() {
    const r = st.rendered;
    if (!r) { result.replaceChildren(); return; }
    const target = LOUDNESS_PRESETS[choices(ctx).loudnessPreset];
    const tpOk = r.stats.truePeakDb <= target.tp + 0.05;
    result.replaceChildren(
      h('div', { class: 'notice warn stale hidden' }, st.uploadedAs
        ? 'Geändert, nachdem die Predigt veröffentlicht wurde – das ändert die veröffentlichte Datei nicht mehr. Der Admin kann sie in „Predigt nachbearbeiten“ ersetzen.'
        : 'Einstellungen oder Angaben wurden geändert – die MP3 wird beim Veröffentlichen neu erstellt.'),
      h('div', { class: 'result-box' },
        h('audio', { controls: true, src: r.url, preload: 'metadata' }),
        h('dl', { class: 'stats' },
          h('dt', null, 'Länge'), h('dd', null, fmtTime(r.stats.duration, false)),
          h('dt', null, 'Größe'), h('dd', null, fmtBytes(r.blob.size)),
          h('dt', null, 'Lautheit'), h('dd', null, `${fmtNum(r.stats.outputLufs)} LUFS (Ziel ${fmtNum(target.lufs)})`),
          h('dt', null, 'True Peak'), h('dd', { class: tpOk ? '' : 'warn-text' }, `${fmtNum(r.stats.truePeakDb)} dBTP (max. ${fmtNum(target.tp)})`),
        ),
      ),
    );
    markStale();
  }

  const publishBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: publish });
  const downloadBtn = h('button', { class: 'btn', type: 'button', onclick: downloadOnly }, '⬇ Nur herunterladen');
  const nextBtn = h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(STEP.load) }, 'Nächste Aufnahme');

  /** Publish button and the note on a taken name; after publishing, the next recording is the obvious next step. */
  function showButtons() {
    const done = !!st.uploadedAs, clash = nameTaken();
    publishBtn.textContent = done ? '✓ Veröffentlicht' : clash && isAdmin() ? '⬆ Ersetzen' : '⬆ Veröffentlichen';
    publishBtn.disabled = busy || done || (clash && !isAdmin());
    downloadBtn.disabled = busy;
    nextBtn.className = done ? 'btn btn-primary' : 'btn btn-ghost';
    nameNote.replaceChildren(clash ? h('div', { class: 'notice warn' }, isAdmin()
      ? `${taken.name} ist schon veröffentlicht. „Ersetzen“ überschreibt die Datei (die bisherige Fassung bleibt auf dem NAS).`
      : `Für diesen Namen ist schon eine Predigt veröffentlicht (${taken.name}). Ist es dieselbe, ist nichts mehr zu tun. ` +
        'Sonst bitte dem Admin Bescheid geben – er kann sie in „Predigt nachbearbeiten“ ersetzen.') : '');
  }

  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '3 · Veröffentlichen')),
    h('div', { class: 'grid' }, title.label, preacher.label, date.label, scripture.label, album.label),
    missingHint,
    overviewHint,
    h('label', { class: 'file-name' }, 'Dateiname', h('div', { class: 'row nowrap' }, nameInput, resetName)),
    nameNote,
    h('div', { class: 'row options' }, summary, h('span', { class: 'spacer' }), advancedBtn),
    advanced.el,
    prepare.el,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(STEP.cut) }, '← Schnitt'),
      h('span', { class: 'spacer' }),
      downloadBtn, publishBtn),
    status,
    result,
    h('div', { class: 'actions' }, nextBtn),
  );

  return {
    el,
    enter() {
      title.input.value = st.meta.title; preacher.input.value = st.meta.preacher; date.input.value = st.meta.date;
      scripture.input.value = st.meta.scripture; album.input.value = st.meta.album;
      updateName();
      showAdvanced();
      showMissing();
      void fromOverview();
      prepare.start(); // loudness and MP3 are worked out while the details are filled in
      if (!st.uploadedAs) status.replaceChildren();
      showResult();
      showButtons();
    },
    leave() { abort?.(); },
  };
}
