// Admin tool: reprocesses sermons that were published already – from the shared OpenCloud folder (through the
// server) or picked on this computer, one at a time or several in a row – with the same processing as
// Predigt-Schnitt (loudness, compression, denoising, format), then replaces them there or publishes them as new
// files. Tags and cover are taken over from each file. On the first replacement the server keeps the file as
// published on the NAS (data/original/), and that version is the default source for any further run.
import '../../../packages/ui-kit/ui.css';
import '../../predigt-schnitt/src/app.css';
import './app.css';
import { ensureLogin, isAdmin, logout, publishTarget } from '../../../packages/auth/auth';
import { loadShared } from '../../../packages/settings/shared';
import { AudioWorkerClient } from '../../../packages/audio-core/client';
import { id3Length, readTags, tagMp3, type Tags } from '../../../packages/audio-core/tags';
import { h, $, fmtTime, fmtNum, fmtBytes, progressBar, download, toast } from '../../../packages/ui-kit/dom';
import { replaceUpload, uploadFile } from '../../../packages/upload/http-upload';
import { LOUDNESS_PRESETS, normalizeSettings, settingsStore, upgradeStored } from '../../predigt-schnitt/src/settings';
import { choices, type AppState, type Ctx } from '../../predigt-schnitt/src/context';
import { createAdvancedPanel, createPrepareView } from '../../predigt-schnitt/src/steps/prepare';
import { isValidFileName, sanitizeFileName } from '../../predigt-schnitt/src/naming';

/** An entry of GET /api/uploads; `original`: replaced before, the first version is kept on the server. */
interface Published { name: string; size: number; modified: string; original: boolean; }

/** A file picked on this computer; `target` is the name it is published under. */
interface LocalFile { file: File; target: string; state: 'waiting' | 'running' | 'done' | 'error'; status: string; }

type Source = { published: Published; fromOriginal: boolean } | { local: LocalFile };

/** `tagsFromPublished`: the local file had no tags, they come from the file it replaces */
interface Loaded { src: Source; target: string; size: number; tags: Tags; tagsFromPublished: boolean; }

const ACCEPT = '.mp3,.wav,audio/mpeg,audio/wav,audio/x-wav,audio/wave';
const isAudio = (f: File) => /\.(mp3|wav)$/i.test(f.name) || /^audio\/(mpeg|wav|x-wav|wave)$/.test(f.type);
const noop = () => undefined;

function emptyState(): AppState {
  return {
    file: null, audioUrl: null, analysis: null, start: 0, end: 0,
    meta: { title: '', preacher: '', date: '', scripture: '', album: '' }, fileName: '', fileNameEdited: false,
    advanced: true, overrides: {},
    measurement: null, measurementKey: '', denoised: null, prepared: null, rendered: null, uploadedAs: null,
  };
}

/** Downloads a published file (or its first version) with progress. */
async function fetchPublished(name: string, original: boolean, onProgress: (p: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try { res = await fetch(`/api/uploads/${encodeURIComponent(name)}${original ? '?original=1' : ''}`, { cache: 'no-store' }); } catch {
    throw new Error('Server nicht erreichbar.');
  }
  if (!res.ok || !res.body) throw new Error(res.status === 404 ? 'Die Datei gibt es auf dem Server nicht (mehr).' : `Server-Antwort ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const reader = res.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (total) onProgress(size / total);
  }
  const bytes = new Uint8Array(size);
  chunks.reduce((at, c) => { bytes.set(c, at); return at + c.length; }, 0);
  return bytes;
}

/** The tags of a published file; reads only the ID3 tag at its start. */
async function publishedTags(name: string): Promise<Tags> {
  const res = await fetch(`/api/uploads/${encodeURIComponent(name)}`, { cache: 'no-store' });
  if (!res.ok || !res.body) return {};
  const reader = res.body.getReader();
  let bytes = new Uint8Array(0), need = 10;
  while (bytes.length < need) {
    const { done, value } = await reader.read();
    if (done) break;
    const more = new Uint8Array(bytes.length + value.length);
    more.set(bytes);
    more.set(value, bytes.length);
    bytes = more;
    if (need === 10 && bytes.length >= 10) need = id3Length(bytes);
  }
  reader.cancel().catch(noop);
  return readTags(bytes);
}

async function coverFromDataUrl(dataUrl: string): Promise<Tags['cover']> {
  if (!dataUrl) return undefined;
  const res = await fetch(dataUrl);
  return { data: await res.arrayBuffer(), mime: res.headers.get('content-type') ?? 'image/jpeg' };
}

await ensureLogin('Predigt nachbearbeiten');
$('#logout').addEventListener('click', logout);
const main = $('#main');

if (!isAdmin()) {
  main.replaceChildren(h('section', { class: 'card' }, h('div', { class: 'notice warn' }, 'Diese Seite ist nur für den Admin.')));
} else {
  // the defaults the admin saved in Predigt-Schnitt; changes here apply to this page only and are not saved
  const settings = settingsStore.load();
  Object.assign(settings, upgradeStored(await loadShared('predigt')));
  normalizeSettings(settings);

  const ctx: Ctx = {
    worker: new AudioWorkerClient(),
    settings,
    state: emptyState(),
    // one page instead of the wizard: nothing to navigate, nothing to save
    saveSettings() {}, goto() {}, changed() {}, updateNav() {},
    resetForNewFile() {
      if (ctx.state.audioUrl) URL.revokeObjectURL(ctx.state.audioUrl);
      if (ctx.state.rendered) URL.revokeObjectURL(ctx.state.rendered.url);
      // the processing options apply to every file on this page
      Object.assign(ctx.state, emptyState(), { overrides: ctx.state.overrides });
    },
  };
  const st = ctx.state;

  let published: Published[] = [];
  let listError = '';
  const locals: LocalFile[] = [];
  let loaded: Loaded | null = null;
  let busy = false, creating = false;
  /** several local files processed and uploaded in a row */
  let batch: { stop: boolean; at: number; of: number } | null = null;

  const findPublished = (name: string) => published.find(f => f.name === name);
  /** where the files are published: "OpenCloud" (or "NAS" without cloud configuration) */
  const T = publishTarget(), inT = T === 'OpenCloud' ? 'in OpenCloud' : 'auf dem NAS';
  const KEPT = 'auf dem NAS (data/original/)';
  const fileUrl = (name: string, original = false) => `/api/uploads/${encodeURIComponent(name)}${original ? '?original=1' : ''}`;

  // ---- 1 · files: published ----

  const filter = h('input', { type: 'search', placeholder: 'Suchen, z. B. 2603', 'aria-label': 'Dateien filtern' });
  const listBox = h('div');
  const loadStatus = h('div');
  filter.addEventListener('input', () => renderList());

  async function loadList() {
    try {
      const res = await fetch('/api/uploads', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Server-Antwort ${res.status}`);
      published = await res.json();
      listError = '';
    } catch (e) {
      listError = `Die Liste konnte nicht geladen werden (${(e as Error).message}).`;
    }
    renderList();
    renderLocal(); // marks local files that would replace a published one
  }

  function renderList() {
    const q = filter.value.trim().toLowerCase();
    const shown = published.filter(f => f.name.toLowerCase().includes(q));
    listBox.replaceChildren(
      listError ? h('div', { class: 'notice error' }, listError) : '',
      !published.length && !listError ? h('p', { class: 'muted' }, `${inT[0].toUpperCase()}${inT.slice(1)} liegen noch keine Predigten.`) : '',
      published.length && !shown.length ? h('p', { class: 'muted' }, 'Keine Datei passt zur Suche.') : '',
      shown.length ? h('ul', { class: 'file-list' }, shown.map(f =>
        h('li', { class: `file-row${loaded && 'published' in loaded.src && loaded.target === f.name ? ' active' : ''}` },
          h('span', { class: 'file-cell mono' }, f.name),
          f.original ? h('span', { class: 'badge', title: `Wurde schon ersetzt; die erste Fassung liegt ${KEPT}.` }, 'nachbearbeitet') : '',
          h('span', { class: 'muted small' }, `${new Date(f.modified).toLocaleDateString('de-DE')} · ${fmtBytes(f.size)}`),
          h('span', { class: 'row-buttons' },
            f.original ? h('a', {
              class: 'btn btn-sm btn-ghost', href: fileUrl(f.name, true), download: f.name.replace(/\.mp3$/, '-original.mp3'),
              title: 'Die zuerst veröffentlichte Fassung herunterladen (vor dem ersten Ersetzen)',
            }, '⬇ erste Fassung') : '',
            h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.name), download: f.name, title: 'Herunterladen', 'aria-label': `${f.name} herunterladen` }, '⬇'),
            h('button', { class: 'btn btn-sm', type: 'button', disabled: busy || !!batch, onclick: () => open({ published: f, fromOriginal: f.original }).catch(noop) }, 'Bearbeiten')),
        ))) : '',
    );
  }

  // ---- 1 · files: from this computer ----

  const localInput = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'hidden' });
  const drop = h('div', { class: 'dropzone compact', tabindex: 0, role: 'button', 'aria-label': 'MP3-Dateien vom Rechner auswählen' },
    h('strong', null, 'MP3-Dateien hierher ziehen'),
    h('span', { class: 'muted small' }, 'oder klicken zum Auswählen – auch mehrere auf einmal'),
  );
  const localBox = h('div');
  drop.addEventListener('click', () => localInput.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); localInput.click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    addLocal([...e.dataTransfer?.files ?? []]);
  });
  localInput.addEventListener('change', () => { addLocal([...localInput.files ?? []]); localInput.value = ''; });

  function addLocal(files: File[]) {
    const audio = files.filter(isAudio);
    if (audio.length < files.length) toast(`${files.length - audio.length} Datei(en) übersprungen – nur MP3 oder WAV.`, 'error');
    for (const file of audio) {
      if (locals.some(l => l.file.name === file.name && l.file.size === file.size)) continue;
      locals.push({ file, target: sanitizeFileName(file.name.replace(/\.(mp3|wav)$/i, '')), state: 'waiting', status: '' });
    }
    renderLocal();
  }

  function renderLocal() {
    const todo = locals.filter(l => l.state !== 'done').length;
    const done = locals.length - todo;
    localBox.replaceChildren(
      locals.length ? h('ul', { class: 'file-list' }, locals.map(l =>
        h('li', { class: `file-row${loaded && 'local' in loaded.src && loaded.src.local === l ? ' active' : ''}` },
          h('span', { class: 'file-cell mono' }, l.file.name),
          l.target !== l.file.name ? h('span', { class: 'muted small mono', title: `Name ${inT}` }, `→ ${l.target}`) : '',
          h('span', { class: 'muted small' }, fmtBytes(l.file.size)),
          l.state !== 'done' && findPublished(l.target)
            ? h('span', { class: 'badge', title: `Eine Datei mit diesem Namen liegt schon ${inT}; sie wird ersetzt.` }, 'ersetzt veröffentlichte') : '',
          l.status ? h('span', { class: `small local-status ${l.state}` }, l.status) : '',
          h('span', { class: 'row-buttons' },
            h('button', { class: 'btn btn-sm', type: 'button', disabled: busy || !!batch, onclick: () => open({ local: l }).catch(noop) }, 'Bearbeiten'),
            h('button', {
              class: 'btn btn-sm btn-ghost', type: 'button', title: 'Aus der Liste entfernen', 'aria-label': `${l.file.name} entfernen`,
              disabled: !!batch, onclick: () => { locals.splice(locals.indexOf(l), 1); renderLocal(); },
            }, '✕')),
        ))) : '',
      batch ? h('div', { class: 'actions' },
        h('span', { class: 'muted small batch-status' }, `Datei ${batch.at} von ${batch.of} …`),
        h('button', { class: 'btn', type: 'button', disabled: batch.stop, onclick: () => { if (batch) batch.stop = true; renderLocal(); } },
          batch.stop ? 'Hält nach dieser Datei an …' : 'Nach dieser Datei anhalten'),
      ) : locals.length ? h('div', { class: 'actions' },
        done ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { locals.splice(0, locals.length, ...locals.filter(l => l.state !== 'done')); renderLocal(); } },
          'Erledigte entfernen') : '',
        todo ? h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: runBatch },
          todo === 1 ? 'Bearbeiten und veröffentlichen' : `Alle ${todo} nacheinander bearbeiten und veröffentlichen`) : '',
      ) : '',
    );
  }

  function renderLists() { renderList(); renderLocal(); }

  /**
   * Loads a file into the editor and decodes it in the worker: a published one (by default its first version, so it
   * is not processed twice) or from this computer. Resolves false when nothing was started; rejects on errors.
   */
  async function open(src: Source): Promise<boolean> {
    if (busy) return false;
    if (!batch && st.rendered && !st.uploadedAs && !confirm('Das Ergebnis wurde noch nicht gespeichert. Trotzdem eine andere Datei laden?')) return false;
    busy = true;
    loaded = null;
    editor.classList.add('hidden');
    resultStale();
    ctx.resetForNewFile();
    renderLists();
    const pub = 'published' in src ? src : null, local = 'local' in src ? src.local : null;
    const name = pub ? pub.published.name : local!.file.name;
    const bar = progressBar('Wird geladen …');
    loadStatus.replaceChildren(h('p', null, h('strong', null, name)), bar.el);
    try {
      let file: File, bytes: Uint8Array;
      if (pub) {
        bytes = await fetchPublished(name, pub.fromOriginal, p => bar.set(p * 0.3, `Wird aus ${T} geladen …`));
        file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'audio/mpeg' });
      } else {
        file = local!.file;
        bytes = new Uint8Array(await file.arrayBuffer());
      }
      const share = pub ? 0.3 : 0;
      const out = await ctx.worker.analyze(file, { minSermon: settings.minSermonMin * 60, mergeGap: settings.mergeGapSec },
        p => bar.set(share + p * (1 - share), 'Wird dekodiert …'));
      Object.assign(st, { file, audioUrl: URL.createObjectURL(file), analysis: out, start: 0, end: out.info.duration, fileName: name });
      const target = pub ? name : local!.target;
      let tags = readTags(bytes), tagsFromPublished = false;
      // a local copy without tags must not wipe title, preacher and cover of the published file it replaces
      if (local && !Object.keys(tags).length && findPublished(target)) {
        tags = await publishedTags(target).catch(() => ({}));
        tagsFromPublished = Object.keys(tags).length > 0;
      }
      loaded = { src, target, size: file.size, tags, tagsFromPublished };
      loadStatus.replaceChildren();
      showEditor();
      return true;
    } catch (e) {
      loadStatus.replaceChildren(h('div', { class: 'notice error' }, `${name} konnte nicht geladen werden: ${(e as Error).message}`));
      throw e;
    } finally {
      busy = false;
      renderLists();
    }
  }

  // ---- 2 · processing options (for every file on this page) ----

  // the MP3 is prepared in the background as soon as a file is loaded and after every option change
  const prepare = createPrepareView(ctx);
  const advanced = createAdvancedPanel(ctx, null, () => { resultStale(); if (loaded) prepare.start(); },
    'Gilt für alle Dateien auf dieser Seite. Die Standardwerte von Predigt-Schnitt bleiben unverändert.');
  const optionsSet = h('fieldset', { class: 'plain' }, advanced.el);

  // ---- 3 · the loaded file ----

  const heading = h('h2');
  const source = h('div', { class: 'source muted small' });
  const before = h('audio', { controls: true, preload: 'metadata' });

  const tagField = (label: string, attrs: Record<string, unknown> = {}) => {
    const input = h('input', attrs);
    input.addEventListener('input', resultStale);
    return { input, el: h('label', null, label, input) };
  };
  const title = tagField('Titel'), artist = tagField('Prediger/in'), album = tagField('Gemeinde (Album)');
  const year = tagField('Jahr', { type: 'number', min: 1900, max: 2100, inputmode: 'numeric' });
  const comment = tagField('Kommentar', { placeholder: 'z. B. Lk 18,1-8 · 2026-10-18' });
  const newCover = h('input', { type: 'checkbox' });
  const coverHint = h('small');
  const coverRow = h('label', { class: 'check-hint cover-row' }, newCover, h('span', null, 'Cover aus den Einstellungen verwenden'), coverHint);
  newCover.addEventListener('change', () => { showCover(); resultStale(); });

  function showCover() {
    const had = !!loaded?.tags.cover;
    coverRow.classList.toggle('hidden', !settings.coverDataUrl);
    coverHint.textContent = newCover.checked ? (had ? 'ersetzt das bisherige Cover' : 'die Datei hatte bisher keins')
      : had ? 'sonst bleibt das bisherige Cover' : 'sonst ohne Cover (wie bisher)';
  }

  const tags = (): Tags => ({
    title: title.input.value.trim() || undefined,
    artist: artist.input.value.trim() || undefined,
    album: album.input.value.trim() || undefined,
    year: Number(year.input.value) || undefined,
    comment: comment.input.value.trim() || undefined,
  });

  const createBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => create().catch(noop) }, 'MP3 erstellen');
  const status = h('div');
  const result = h('div');
  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save().catch(noop) });
  const saveStatus = h('div');
  nameInput.addEventListener('input', showSaveLabel);
  nameInput.addEventListener('change', () => { nameInput.value = sanitizeFileName(nameInput.value); showSaveLabel(); });

  function showSaveLabel() {
    saveBtn.textContent = findPublished(sanitizeFileName(nameInput.value)) ? `⬆ ${inT[0].toUpperCase()}${inT.slice(1)} ersetzen` : '⬆ Veröffentlichen';
  }

  /** Tags or options changed: the finished file no longer matches. */
  function resultStale() {
    if (st.rendered) URL.revokeObjectURL(st.rendered.url);
    st.rendered = null;
    st.uploadedAs = null;
    result.replaceChildren();
  }

  function showEditor() {
    const l = loaded!, t = l.tags, src = l.src;
    heading.textContent = `3 · ${l.target}`;
    const size = `${fmtTime(st.end, false)} · ${fmtBytes(l.size)}`;
    source.replaceChildren(...'published' in src ? [
      h('span', null, `Aus ${T} · ${size}`),
      src.fromOriginal ? h('span', null, '· Ausgang: die zuerst veröffentlichte Fassung')
        : src.published.original ? h('span', null, '· Ausgang: die aktuelle, schon nachbearbeitete Fassung') : '',
      src.published.original ? h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => open({ published: src.published, fromOriginal: !src.fromOriginal }).catch(noop),
      }, src.fromOriginal ? 'Stattdessen die aktuelle Fassung laden' : 'Die erste Fassung laden') : '',
    ] : [
      h('span', null, `Vom Rechner: ${src.local.file.name} · ${size}`),
      h('span', null, findPublished(l.target) ? `· ersetzt die gleichnamige Datei ${inT}` : `· wird neu ${inT} veröffentlicht`),
      l.tagsFromPublished ? h('span', null, `· Titel, Prediger und Cover von der Datei ${inT} übernommen`) : '',
    ]);
    before.src = st.audioUrl!;
    title.input.value = t.title ?? ''; artist.input.value = t.artist ?? ''; album.input.value = t.album ?? '';
    year.input.value = t.year ? String(t.year) : ''; comment.input.value = t.comment ?? '';
    newCover.checked = !t.cover && !!settings.coverDataUrl;
    showCover();
    status.replaceChildren();
    saveStatus.replaceChildren();
    editor.classList.remove('hidden');
    prepare.start();
    if (!batch) editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Waits for the prepared MP3 and adds the tags. Rejects on errors (shown in the editor). */
  async function create() {
    if (!loaded || creating) return;
    creating = true;
    createBtn.disabled = true;
    status.replaceChildren();
    try {
      const l = loaded, p = await prepare.run();
      const cover = newCover.checked ? await coverFromDataUrl(settings.coverDataUrl) : l.tags.cover;
      const mp3 = tagMp3(p.mp3, { ...tags(), cover });
      if (loaded !== l) return; // another file was opened meanwhile
      resultStale();
      const blob = new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' });
      st.rendered = { blob, url: URL.createObjectURL(blob), stats: p.stats, key: '' };
      showResult();
    } catch (e) {
      status.replaceChildren(h('div', { class: 'notice error' }, `Erstellen fehlgeschlagen: ${(e as Error).message}`));
      throw e;
    } finally {
      creating = false;
      createBtn.disabled = false;
    }
  }

  function showResult() {
    const r = st.rendered, l = loaded;
    if (!r || !l) return;
    const target = LOUDNESS_PRESETS[choices(ctx).loudnessPreset];
    const tpOk = r.stats.truePeakDb <= target.tp + 0.05;
    nameInput.value = l.target;
    showSaveLabel();
    saveStatus.replaceChildren();
    result.replaceChildren(
      h('div', { class: 'result-box' },
        h('div', { class: 'listen' }, h('span', { class: 'muted small' }, 'Nachher'), h('audio', { controls: true, src: r.url, preload: 'metadata' })),
        h('dl', { class: 'stats' },
          h('dt', null, 'Länge'), h('dd', null, fmtTime(r.stats.duration, false)),
          h('dt', null, 'Größe'), h('dd', null, `${fmtBytes(r.blob.size)} (vorher ${fmtBytes(l.size)})`),
          h('dt', null, 'Lautheit'), h('dd', null, `${fmtNum(r.stats.outputLufs)} LUFS (Ziel ${fmtNum(target.lufs)})`),
          h('dt', null, 'True Peak'), h('dd', { class: tpOk ? '' : 'warn-text' }, `${fmtNum(r.stats.truePeakDb)} dBTP (max. ${fmtNum(target.tp)})`),
        ),
      ),
      h('label', { class: 'file-name' }, `Dateiname – liegt eine Datei mit diesem Namen ${inT}, wird sie ersetzt`, nameInput),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => download(r.blob, sanitizeFileName(nameInput.value)) }, '⬇ Herunterladen'),
        saveBtn),
      saveStatus,
    );
  }

  /**
   * Publishes the result: replaces the file of that name, or adds a new one. `confirmed`: the batch
   * asked once for all files. Resolves false when nothing was saved; rejects on errors (shown in the editor).
   */
  async function save(confirmed = false): Promise<boolean> {
    const r = st.rendered, l = loaded;
    if (!r || !l) return false;
    const name = sanitizeFileName(nameInput.value);
    nameInput.value = name;
    showSaveLabel();
    if (!isValidFileName(name)) { saveStatus.replaceChildren(h('div', { class: 'notice error' }, 'Ungültiger Dateiname.')); return false; }
    const existing = findPublished(name);
    if (existing && !confirmed && !confirm(existing.original
      ? `${name} ${inT} ersetzen?\n\nDie aktuelle Fassung wird überschrieben; die zuerst veröffentlichte bleibt ${KEPT} erhalten.`
      : `${name} ${inT} ersetzen?\n\nDie bisherige Fassung wird ${KEPT} aufbewahrt.`)) return false;
    const bar = progressBar('Lade hoch …');
    saveStatus.replaceChildren(bar.el);
    saveBtn.disabled = true;
    try {
      const progress = (p: number, stored?: boolean) => bar.set(p, stored ? `Wird in ${T} gespeichert …` : 'Lade hoch …');
      await (existing ? replaceUpload(name, r.blob, progress) : uploadFile(r.blob, name, progress)).promise;
      st.uploadedAs = name;
      saveStatus.replaceChildren(h('div', { class: 'notice ok' }, existing ? `Ersetzt: ${name}` : `Veröffentlicht: ${name}`));
      if ('local' in l.src) Object.assign(l.src.local, { state: 'done', status: existing ? `✓ ersetzt: ${name}` : `✓ veröffentlicht: ${name}` });
      await loadList();
      return true;
    } catch (e) {
      saveStatus.replaceChildren(h('div', { class: 'notice error' }, (e as Error).message));
      throw e;
    } finally {
      saveBtn.disabled = false;
    }
  }

  /** Processes the local files that are not done yet, one after another, with the options above, and uploads them. */
  async function runBatch() {
    if (batch || busy) return;
    const todo = locals.filter(l => l.state !== 'done');
    const targets = todo.map(l => l.target);
    const twice = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
    if (twice.length) {
      toast(`Mehrere Dateien ergäben denselben Namen (${twice.join(', ')}). Bitte eine davon entfernen.`, 'error', 8000);
      return;
    }
    const clashes = targets.filter(t => findPublished(t));
    if (clashes.length && !confirm(`${clashes.length === 1 ? 'Diese Datei gibt' : `Diese ${clashes.length} Dateien gibt`} es schon ${inT} – sie werden ersetzt:\n\n` +
      `${clashes.join('\n')}\n\nDie zuerst veröffentlichte Fassung bleibt jeweils ${KEPT} erhalten.`)) return;
    if (st.rendered && !st.uploadedAs && !confirm('Das aktuelle Ergebnis wurde noch nicht gespeichert. Trotzdem starten?')) return;

    batch = { stop: false, at: 0, of: todo.length };
    optionsSet.disabled = editorSet.disabled = true;
    let ok = 0;
    for (const l of todo) {
      if (batch.stop) break;
      batch.at++;
      Object.assign(l, { state: 'running', status: 'wird bearbeitet …' });
      renderLocal();
      try {
        if (!await open({ local: l })) throw new Error('nicht geladen');
        await create();
        if (!await save(true)) throw new Error('nicht gespeichert');
        ok++;
      } catch (e) {
        Object.assign(l, { state: 'error', status: `⚠ ${(e as Error).message}` });
      }
      renderLocal();
    }
    const stopped = batch.stop && batch.at < batch.of;
    batch = null;
    optionsSet.disabled = editorSet.disabled = false;
    renderLists();
    toast(`${ok} von ${todo.length} Dateien veröffentlicht${stopped ? ' – angehalten' : ''}.`, ok === todo.length ? 'ok' : 'error', 8000);
  }

  const editorSet = h('fieldset', { class: 'plain' },
    source,
    h('div', { class: 'listen' }, h('span', { class: 'muted small' }, 'Vorher'), before),
    h('div', { class: 'grid tag-grid' }, title.el, artist.el, album.el, year.el, comment.el),
    coverRow,
    prepare.el,
    prepare.details,
    h('div', { class: 'actions' }, createBtn),
    status,
    result,
  );
  const editor = h('section', { class: 'card hidden' }, h('div', { class: 'card-head' }, heading), editorSet);

  main.replaceChildren(
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '1 · Predigten wählen')),
      h('p', { class: 'muted small' },
        'Bearbeitet schon veröffentlichte Predigten mit den aktuellen Einstellungen neu, z. B. mit der Hall- und Rauschreduzierung – ' +
        `aus ${T} oder vom Rechner, einzeln oder mehrere nacheinander. Titel, Prediger und Cover werden übernommen. ` +
        `Beim Ersetzen bleibt die zuerst veröffentlichte Fassung ${KEPT} erhalten.`),
      h('h3', { class: 'files-head' }, `Veröffentlicht (${T})`),
      h('div', { class: 'row list-tools' }, filter, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: loadList }, '↻ Neu laden')),
      listBox,
      h('h3', { class: 'files-head' }, 'Vom Rechner'),
      drop, localInput,
      localBox,
      loadStatus,
    ),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '2 · Bearbeitung')), optionsSet),
    editor,
  );
  advanced.sync();
  window.addEventListener('beforeunload', e => { if (batch || (st.rendered && !st.uploadedAs)) e.preventDefault(); });
  await loadList();
}
