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
import { id3Length, readTags, stripTags, tagMp3, type Tags } from '../../../packages/audio-core/tags';
import { h, $, fmtTime, fmtNum, fmtBytes, progressBar, download, toast } from '../../../packages/ui-kit/dom';
import { replaceUpload, uploadFile } from '../../../packages/upload/http-upload';
import { LOUDNESS_PRESETS, coverUrl, normalizeSettings, settingsStore, upgradeStored } from '../../predigt-schnitt/src/settings';
import { choices, processOptions, type AppState, type Ctx, type Rendered } from '../../predigt-schnitt/src/context';
import { createAdvancedPanel, createPrepareView } from '../../predigt-schnitt/src/steps/prepare';
import { isValidFileName, sanitizeFileName } from '../../predigt-schnitt/src/naming';
import { dateFromFileName, fetchOverview, type OverviewEntry } from '../../predigt-schnitt/src/overview';
import { germanDate, missingTags, processedNote, reprocessTags, type TagMode } from '../../predigt-schnitt/src/tagging';

/**
 * An entry of GET /api/uploads; `original`: replaced before, the first version is kept on the server. `processed`,
 * `originalProcessed`: the app's mark in the file and in that first version (null: none), see PROCESSED_KEY.
 */
interface Published {
  name: string; size: number; modified: string; original: boolean; processed: string | null; originalProcessed?: string | null;
  /** required details the file's tag lacks (missingTags) */
  missing: string[];
}

/** `skipped`: left out by a batch (details unknown), only by hand */
type ItemState = 'waiting' | 'running' | 'done' | 'error' | 'skipped';
/** A file picked on this computer; `target` is the name it is published under, `mark` the app's mark in it, `missing` the required details its tag lacks. */
interface LocalFile { file: File; target: string; state: ItemState; status: string; mark: string | null; missing: string[]; }

/** One file of a batch: where it comes from, the name it is published under, and how to show its state. */
interface BatchItem { source: Source; target: string; set(state: ItemState, status: string): void; }

type Source = { published: Published; fromOriginal: boolean } | { local: LocalFile };

/**
 * `fileTags`: as read (for a local file without tags: those of the published file it replaces, `tagsFromPublished`);
 * `tags`: what will be written, by the tag rules (tagging.ts) with the eAg-Übersicht's entry for `day` – the date in
 * the file name. `tagsOnly`: "Nur Angaben" – new tags on the file's own `audio`, which keeps its `mark`.
 */
interface Loaded {
  src: Source; target: string; size: number;
  fileTags: Tags; tagsFromPublished: boolean; day: string | null; overview: OverviewEntry | null | 'unavailable';
  tags: Tags;
  tagsOnly: boolean; audio: Uint8Array | null; mark: string | null;
}

const ACCEPT = '.mp3,.wav,audio/mpeg,audio/wav,audio/x-wav,audio/wave';
const isAudio = (f: File) => /\.(mp3|wav)$/i.test(f.name) || /^audio\/(mpeg|wav|x-wav|wave)$/.test(f.type);
const noop = () => undefined;

function emptyState(): AppState {
  return {
    file: null, audioUrl: null, analysis: null, start: 0, end: 0,
    meta: { title: '', preacher: '', date: '', scripture: '', album: '' }, fileName: '', fileNameEdited: false, metaEdited: new Set(),
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

/** The tags of a file on this computer (only its ID3 tag is read). */
async function headTags(file: File): Promise<Tags> {
  const len = id3Length(new Uint8Array(await file.slice(0, 10).arrayBuffer()));
  return len ? readTags(new Uint8Array(await file.slice(0, Math.min(len, 2 << 20)).arrayBuffer())) : {};
}

/** Required details a file's own tag lacks, as a badge in the lists. */
const missingBadge = (missing: string[]) => (missing.length ? h('span', {
  class: 'badge missing', title: 'Diese Angaben fehlen in der Datei. „Nur Angaben“ trägt sie nach, ohne das Audio neu zu bearbeiten.',
}, `fehlt: ${missing.join(', ')}`) : '');

const TAGS_ONLY_HINT = 'Nur Titel, Prediger/in, Datum usw. ändern – das Audio bleibt, wie es ist (keine neue Bearbeitung)';

/** The mark of what reprocessing starts from: the first version, or the current one (see open()). */
const markFor = (f: Published, fromOriginal = f.original) => (fromOriginal ? f.originalProcessed ?? null : f.processed);

/** Made with the app already: processing it again filters twice and encodes the MP3 a second time. Asks first. */
const confirmAgain = (what: string, mark: string) => confirm(`${what} ist schon mit der App bearbeitet (${mark}).\n\n` +
  'Noch einmal bearbeiten reduziert Hall und Rauschen doppelt (die Stimme wird dünner) und kodiert die MP3 ein zweites Mal. Trotzdem bearbeiten?');

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
  let batch: { stop: boolean; at: number; of: number; waiting: number } | null = null;
  /** published files ticked for a batch, and how far it got with them */
  const selected = new Set<string>();
  const publishedState = new Map<string, { state: ItemState; status: string }>();

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

  /** Selection of published files and the batch for it (next to the search). */
  const tools = h('span', { class: 'row list-batch' });
  function renderTools() {
    for (const name of selected) if (!findPublished(name)) selected.delete(name); // gone from the folder
    // files made with the app already are left out (they can still be ticked one by one)
    const shown = published.filter(f => f.name.toLowerCase().includes(filter.value.trim().toLowerCase()));
    const shownNames = shown.filter(f => !markFor(f)).map(f => f.name);
    const all = shownNames.length > 0 && shownNames.every(n => selected.has(n));
    const label = shown.length > shownNames.length ? 'alle noch nicht bearbeiteten' : 'Alle';
    tools.replaceChildren(
      published.length ? h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', disabled: !!batch,
        onclick: () => { for (const n of shownNames) if (all) selected.delete(n); else selected.add(n); renderList(); },
      }, all ? 'Auswahl aufheben' : `${label} auswählen`) : '',
      selected.size ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: busy || !!batch, onclick: () => void runPublishedBatch() },
        `${selected.size} ausgewählte bearbeiten und ersetzen`) : '',
    );
  }

  function renderList() {
    renderTools();
    const q = filter.value.trim().toLowerCase();
    const shown = published.filter(f => f.name.toLowerCase().includes(q));
    listBox.replaceChildren(
      listError ? h('div', { class: 'notice error' }, listError) : '',
      !published.length && !listError ? h('p', { class: 'muted' }, `${inT[0].toUpperCase()}${inT.slice(1)} liegen noch keine Predigten.`) : '',
      published.length && !shown.length ? h('p', { class: 'muted' }, 'Keine Datei passt zur Suche.') : '',
      shown.length ? h('ul', { class: 'file-list' }, shown.map(f =>
        h('li', { class: `file-row${loaded && 'published' in loaded.src && loaded.target === f.name ? ' active' : ''}` },
          h('input', {
            type: 'checkbox', class: 'pick', checked: selected.has(f.name), disabled: !!batch, 'aria-label': `${f.name} auswählen`,
            onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) selected.add(f.name); else selected.delete(f.name); renderTools(); },
          }),
          h('span', { class: 'file-cell mono' }, f.name),
          f.original ? h('span', { class: 'badge', title: `Wurde schon ersetzt; die erste Fassung liegt ${KEPT}.` }, 'nachbearbeitet') : '',
          markFor(f) ? h('span', { class: 'badge', title: `Schon mit der App bearbeitet: ${markFor(f)}` }, 'schon bearbeitet') : '',
          missingBadge(f.missing ?? []),
          h('span', { class: 'muted small' }, `${new Date(f.modified).toLocaleDateString('de-DE')} · ${fmtBytes(f.size)}`),
          publishedState.get(f.name) ? h('span', { class: `small local-status ${publishedState.get(f.name)!.state}` }, publishedState.get(f.name)!.status) : '',
          h('span', { class: 'row-buttons' },
            f.original ? h('a', {
              class: 'btn btn-sm btn-ghost', href: fileUrl(f.name, true), download: f.name.replace(/\.mp3$/, '-original.mp3'),
              title: 'Die zuerst veröffentlichte Fassung herunterladen (vor dem ersten Ersetzen)',
            }, '⬇ erste Fassung') : '',
            h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.name), download: f.name, title: 'Herunterladen', 'aria-label': `${f.name} herunterladen` }, '⬇'),
            // the current version: its audio stays (the first version would bring back the unprocessed sound)
            h('button', {
              class: 'btn btn-sm btn-ghost', type: 'button', disabled: busy || !!batch, title: TAGS_ONLY_HINT,
              onclick: () => open({ published: f, fromOriginal: false }, true).catch(noop),
            }, 'Nur Angaben'),
            h('button', {
              class: 'btn btn-sm', type: 'button', disabled: busy || !!batch,
              onclick: () => { if (!markFor(f) || confirmAgain(f.name, markFor(f)!)) open({ published: f, fromOriginal: f.original }).catch(noop); },
            }, 'Bearbeiten')),
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
    void addLocal([...e.dataTransfer?.files ?? []]);
  });
  localInput.addEventListener('change', () => { void addLocal([...localInput.files ?? []]); localInput.value = ''; });

  async function addLocal(files: File[]) {
    const audio = files.filter(isAudio);
    if (audio.length < files.length) toast(`${files.length - audio.length} Datei(en) übersprungen – nur MP3 oder WAV.`, 'error');
    for (const file of audio) {
      if (locals.some(l => l.file.name === file.name && l.file.size === file.size)) continue;
      const own = await headTags(file).catch((): Tags => ({}));
      locals.push({
        file, target: sanitizeFileName(file.name.replace(/\.(mp3|wav)$/i, '')), state: 'waiting', status: '',
        mark: own.processed ?? null, missing: missingTags(own),
      });
    }
    renderLocal();
  }

  function renderLocal() {
    // files made with the app already are not taken by the batch (one by one after a question)
    // nor those a batch skipped because their details are unknown
    const todo = locals.filter(l => l.state !== 'done' && l.state !== 'skipped' && !l.mark).length;
    const marked = locals.filter(l => l.state !== 'done' && l.mark).length;
    const done = locals.filter(l => l.state === 'done').length;
    localBox.replaceChildren(
      locals.length ? h('ul', { class: 'file-list' }, locals.map(l =>
        h('li', { class: `file-row${loaded && 'local' in loaded.src && loaded.src.local === l ? ' active' : ''}` },
          h('span', { class: 'file-cell mono' }, l.file.name),
          l.target !== l.file.name ? h('span', { class: 'muted small mono', title: `Name ${inT}` }, `→ ${l.target}`) : '',
          h('span', { class: 'muted small' }, fmtBytes(l.file.size)),
          l.state !== 'done' && findPublished(l.target)
            ? h('span', { class: 'badge', title: `Eine Datei mit diesem Namen liegt schon ${inT}; sie wird ersetzt.` }, 'ersetzt veröffentlichte') : '',
          l.mark && l.state !== 'done' ? h('span', { class: 'badge', title: `Schon mit der App bearbeitet: ${l.mark}` }, 'schon bearbeitet') : '',
          l.state !== 'done' ? missingBadge(l.missing) : '',
          l.status ? h('span', { class: `small local-status ${l.state}` }, l.status) : '',
          h('span', { class: 'row-buttons' },
            /\.mp3$/i.test(l.file.name) ? h('button', {
              class: 'btn btn-sm btn-ghost', type: 'button', disabled: busy || !!batch, title: TAGS_ONLY_HINT,
              onclick: () => open({ local: l }, true).catch(noop),
            }, 'Nur Angaben') : '',
            h('button', {
              class: 'btn btn-sm', type: 'button', disabled: busy || !!batch,
              onclick: () => { if (!l.mark || confirmAgain(l.file.name, l.mark)) open({ local: l }).catch(noop); },
            }, 'Bearbeiten'),
            h('button', {
              class: 'btn btn-sm btn-ghost', type: 'button', title: 'Aus der Liste entfernen', 'aria-label': `${l.file.name} entfernen`,
              disabled: !!batch, onclick: () => { locals.splice(locals.indexOf(l), 1); renderLocal(); },
            }, '✕')),
        ))) : '',
      !batch && marked ? h('p', { class: 'muted small' }, `${marked === 1 ? 'Eine Datei ist schon mit der App bearbeitet und wird'
        : `${marked} Dateien sind schon mit der App bearbeitet und werden`} beim Stapel übersprungen – einzeln mit „Bearbeiten“ nach einer Rückfrage.`) : '',
      batch ? '' : locals.length ? h('div', { class: 'actions' },
        done ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { locals.splice(0, locals.length, ...locals.filter(l => l.state !== 'done')); renderLocal(); } },
          'Erledigte entfernen') : '',
        todo ? h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: () => void runLocalBatch() },
          todo === 1 ? 'Bearbeiten und veröffentlichen' : `Alle ${todo} nacheinander bearbeiten und veröffentlichen`) : '',
      ) : '',
    );
  }

  /** The running batch: which file, the files still on their way to OpenCloud, stop after this file. */
  const batchBox = h('div');
  function renderBatch() {
    batchBox.replaceChildren(batch ? h('div', { class: 'actions batch-bar' },
      h('span', { class: 'muted small batch-status' }, batch.at <= batch.of && !batch.stop
        ? `Datei ${batch.at} von ${batch.of} …${batch.waiting ? ` · ${batch.waiting} wird/werden noch in ${T} gespeichert` : ''}`
        : `Warte auf ${T} (${batch.waiting} Datei(en)) …`),
      h('button', { class: 'btn', type: 'button', disabled: batch.stop, onclick: () => { if (batch) batch.stop = true; renderBatch(); } },
        batch.stop ? 'Hält nach dieser Datei an …' : 'Nach dieser Datei anhalten'),
    ) : '');
  }

  function renderLists() { renderList(); renderLocal(); renderBatch(); }

  /**
   * Loads a file into the editor and decodes it in the worker: a published one (by default its first version, so it
   * is not processed twice) or from this computer. Resolves false when nothing was started; rejects on errors.
   */
  async function open(src: Source, tagsOnly = false): Promise<boolean> {
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
        bytes = await fetchPublished(name, pub.fromOriginal, p => bar.set(p * (tagsOnly ? 1 : 0.3), `Wird aus ${T} geladen …`));
        file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'audio/mpeg' });
      } else {
        file = local!.file;
        bytes = new Uint8Array(await file.arrayBuffer());
      }
      if (tagsOnly) Object.assign(st, { file, audioUrl: URL.createObjectURL(file), fileName: name }); // nothing to decode
      else {
        const share = pub ? 0.3 : 0;
        const out = await ctx.worker.analyze(file, { minSermon: settings.minSermonMin * 60, mergeGap: settings.mergeGapSec },
          p => bar.set(share + p * (1 - share), 'Wird dekodiert …'));
        Object.assign(st, { file, audioUrl: URL.createObjectURL(file), analysis: out, start: 0, end: out.info.duration, fileName: name });
      }
      const target = pub ? name : local!.target;
      let tags = readTags(bytes), tagsFromPublished = false;
      const mark = tags.processed ?? null;
      // a local copy without tags must not wipe title, preacher and cover of the published file it replaces
      if (local && !Object.keys(tags).length && findPublished(target)) {
        tags = await publishedTags(target).catch(() => ({}));
        tagsFromPublished = Object.keys(tags).length > 0;
      }
      const day = dateFromFileName(target);
      const overview = day ? await fetchOverview(day) : null;
      loaded = {
        src, target, size: file.size, fileTags: tags, tagsFromPublished, day, overview, tags: tagsFor(tags, day, overview),
        tagsOnly, audio: tagsOnly ? stripTags(bytes) : null, mark,
      };
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

  /** The tags to write: as in the export ("auto"), or the file's own with gaps filled ("keep"); see tagging.ts. */
  let tagMode: TagMode = 'auto';
  const tagsFor = (file: Tags, day: string | null, o: Loaded['overview']) =>
    ({ ...reprocessTags(file, settings, day, o === 'unavailable' ? null : o, tagMode), cover: file.cover });

  // ---- 2 · processing options (for every file on this page) ----

  // the MP3 is prepared in the background as soon as a file is loaded and after every option change
  const prepare = createPrepareView(ctx);
  const advanced = createAdvancedPanel(ctx, null, () => { if (loaded?.tagsOnly) return; resultStale(); if (loaded) prepare.start(); },
    'Gilt für alle Dateien auf dieser Seite. Die Standardwerte von Predigt-Schnitt bleiben unverändert.');
  const tagModeSelect = h('select', null,
    h('option', { value: 'auto' }, 'automatisch, wie beim Export'),
    h('option', { value: 'keep' }, 'aus der Datei, nur Fehlendes ergänzen'));
  tagModeSelect.addEventListener('change', () => {
    tagMode = tagModeSelect.value as TagMode;
    if (loaded) { loaded.tags = tagsFor(loaded.fileTags, loaded.day, loaded.overview); showTags(); resultStale(); }
  });
  const optionsSet = h('fieldset', { class: 'plain options-set' }, advanced.el,
    h('label', { class: 'tag-mode' }, 'Angaben der MP3 (Titel, Prediger/in, Album …)', tagModeSelect));

  // ---- 3 · the loaded file ----

  const heading = h('h2');
  const source = h('div', { class: 'source muted small' });
  const before = h('audio', { controls: true, preload: 'metadata' });

  const tagField = (label: string, attrs: Record<string, unknown> = {}) => {
    const input = h('input', attrs);
    input.addEventListener('input', () => { resultStale(); checkTags(); });
    return { input, el: h('label', null, label, input) };
  };
  const title = tagField('Titel'), artist = tagField('Prediger/in'), album = tagField('Album (Predigtreihe)');
  const track = tagField('Nr. in der Reihe', { type: 'number', min: 1, max: 999, inputmode: 'numeric' });
  const albumArtist = tagField('Album-Interpret'), genre = tagField('Genre');
  const date = tagField('Datum', { type: 'date' });
  const comment = tagField('Kommentar', { placeholder: 'z. B. Lk 18,1-8 · 18.10.2026' });
  const tagInfo = h('span');
  /** details that are unknown or missing: shown above the fields, publishing waits for them */
  const tagWarn = h('div');
  const newCover = h('input', { type: 'checkbox' });
  const coverHint = h('small');
  const coverRow = h('label', { class: 'check-hint cover-row' }, newCover, h('span', null, settings.coverDataUrl ? 'Cover aus den Einstellungen verwenden' : 'eAg-Cover verwenden'), coverHint);
  newCover.addEventListener('change', () => { showCover(); resultStale(); });

  function showCover() {
    const had = !!loaded?.tags.cover;
    coverHint.textContent = newCover.checked ? (had ? 'ersetzt das bisherige Cover' : 'die Datei hatte bisher keins')
      : had ? 'sonst bleibt das bisherige Cover' : 'sonst ohne Cover (wie bisher)';
  }

  const tags = (): Tags => ({
    title: title.input.value.trim() || undefined,
    artist: artist.input.value.trim() || undefined,
    album: album.input.value.trim() || undefined,
    albumArtist: albumArtist.input.value.trim() || undefined,
    genre: genre.input.value.trim() || undefined,
    date: date.input.value || undefined,
    year: Number(date.input.value.slice(0, 4)) || loaded?.tags.year,
    comment: comment.input.value.trim() || undefined,
    track: Number(track.input.value) || undefined,
  });

  /** The tag fields and where their values come from. */
  function showTags() {
    const l = loaded!, t = l.tags, o = l.overview;
    title.input.value = t.title ?? ''; artist.input.value = t.artist ?? ''; album.input.value = t.album ?? '';
    track.input.value = t.track ? String(t.track) : ''; albumArtist.input.value = t.albumArtist ?? ''; genre.input.value = t.genre ?? '';
    date.input.value = t.date ?? ''; comment.input.value = t.comment ?? '';
    tagInfo.textContent = tagMode === 'keep' ? '· Angaben aus der Datei, Fehlendes ergänzt'
      : !l.day ? '· kein Datum im Dateinamen – Angaben aus der Datei'
      : o === 'unavailable' ? ''
      : o ? `· Angaben aus der eAg-Übersicht vom ${germanDate(l.day)}` : `· ${germanDate(l.day)} steht nicht in der eAg-Übersicht`;
    checkTags();
  }

  /** Where the eAg-Übersicht could not help, and which required details are still empty. */
  function checkTags() {
    const l = loaded;
    if (!l) return;
    const unknown = tagMode === 'keep' ? ''
      : !l.day ? 'Kein Datum im Dateinamen – die Angaben stammen aus der Datei.'
      : l.overview === 'unavailable' ? 'Die eAg-Übersicht war nicht erreichbar – die Angaben stammen aus der Datei.'
      : !l.overview ? `${germanDate(l.day)} steht nicht in der eAg-Übersicht – die Angaben stammen aus der Datei.` : '';
    const missing = missingTags(tags());
    tagWarn.replaceChildren(
      unknown ? h('div', { class: 'notice warn' }, `${unknown} Bitte Titel, Prediger/in und Album prüfen. Im Stapel wird so eine Datei übersprungen.`) : '',
      missing.length ? h('div', { class: 'notice error' }, `Es fehlt: ${missing.join(', ')} – ohne diese Angaben wird nicht veröffentlicht.`) : '');
  }

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
    heading.textContent = `3 · ${l.target}${l.tagsOnly ? ' · nur Angaben' : ''}`;
    const size = `${l.tagsOnly ? '' : `${fmtTime(st.end, false)} · `}${fmtBytes(l.size)}`;
    source.replaceChildren(...'published' in src ? [
      h('span', null, `Aus ${T} · ${size}`),
      src.fromOriginal ? h('span', null, '· Ausgang: die zuerst veröffentlichte Fassung')
        : src.published.original ? h('span', null, '· Ausgang: die aktuelle, schon nachbearbeitete Fassung') : '',
      src.published.original && !l.tagsOnly ? h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
          const mark = markFor(src.published, !src.fromOriginal);
          if (!mark || confirmAgain(src.fromOriginal ? 'Die aktuelle Fassung' : 'Die erste Fassung', mark)) open({ published: src.published, fromOriginal: !src.fromOriginal }).catch(noop);
        },
      }, src.fromOriginal ? 'Stattdessen die aktuelle Fassung laden' : 'Die erste Fassung laden') : '',
    ] : [
      h('span', null, `Vom Rechner: ${src.local.file.name} · ${size}`),
      h('span', null, findPublished(l.target) ? `· ersetzt die gleichnamige Datei ${inT}` : `· wird neu ${inT} veröffentlicht`),
      l.tagsFromPublished ? h('span', null, `· Titel, Prediger und Cover von der Datei ${inT} übernommen`) : '',
    ], l.tagsOnly ? h('span', null, '· nur die Angaben ändern sich, das Audio bleibt, wie es ist') : '', tagInfo);
    before.src = st.audioUrl!;
    showTags();
    newCover.checked = !t.cover;
    showCover();
    status.replaceChildren();
    saveStatus.replaceChildren();
    editor.classList.remove('hidden');
    prepare.el.classList.toggle('hidden', l.tagsOnly);
    prepare.details.classList.toggle('hidden', l.tagsOnly);
    createBtn.textContent = l.tagsOnly ? 'Angaben übernehmen' : 'MP3 erstellen';
    if (!l.tagsOnly) prepare.start();
    if (!batch) editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Waits for the prepared MP3 and adds the tags. Rejects on errors (shown in the editor). */
  async function create() {
    if (!loaded || creating) return;
    creating = true;
    createBtn.disabled = true;
    status.replaceChildren();
    try {
      const l = loaded;
      let mp3: Uint8Array, stats: Rendered['stats'] = null;
      if (l.tagsOnly) {
        // the file's own audio with new tags; its mark stays (or stays absent: nothing was processed)
        const cover = newCover.checked ? await coverFromDataUrl(coverUrl(settings)) : l.tags.cover;
        mp3 = tagMp3(l.audio!, { ...tags(), cover, processed: l.mark ?? undefined });
      } else {
        const p = await prepare.run();
        const cover = newCover.checked ? await coverFromDataUrl(coverUrl(settings)) : l.tags.cover;
        mp3 = tagMp3(p.mp3, { ...tags(), cover, processed: processedNote(processOptions(ctx)) });
        stats = p.stats;
      }
      if (loaded !== l) return; // another file was opened meanwhile
      resultStale();
      const blob = new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' });
      st.rendered = { blob, url: URL.createObjectURL(blob), stats, key: '' };
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
    const s = r.stats; // null: only the tags were changed
    nameInput.value = l.target;
    showSaveLabel();
    saveStatus.replaceChildren();
    result.replaceChildren(
      h('div', { class: 'result-box' },
        h('div', { class: 'listen' }, h('span', { class: 'muted small' }, 'Nachher'), h('audio', { controls: true, src: r.url, preload: 'metadata' })),
        h('dl', { class: 'stats' },
          s ? [h('dt', null, 'Länge'), h('dd', null, fmtTime(s.duration, false))] : '',
          h('dt', null, 'Größe'), h('dd', null, `${fmtBytes(r.blob.size)} (vorher ${fmtBytes(l.size)})`),
          s ? [
            h('dt', null, 'Lautheit'), h('dd', null, `${fmtNum(s.outputLufs)} LUFS (Ziel ${fmtNum(target.lufs)})`),
            h('dt', null, 'True Peak'), h('dd', { class: s.truePeakDb <= target.tp + 0.05 ? '' : 'warn-text' }, `${fmtNum(s.truePeakDb)} dBTP (max. ${fmtNum(target.tp)})`),
          ] : [h('dt', null, 'Audio'), h('dd', null, 'unverändert – nur die Angaben sind neu')],
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
   * Publishes the result: replaces the file of that name, or adds a new one. `confirmed`: the batch asked once
   * for all files. `stored` (batch): returns as soon as the server has the file and reports later whether it
   * arrived in OpenCloud – meanwhile the next file is processed. Resolves false when nothing was saved.
   */
  async function save(confirmed = false, stored?: (ok: boolean, message: string) => void): Promise<boolean> {
    const r = st.rendered, l = loaded;
    if (!r || !l) return false;
    const name = sanitizeFileName(nameInput.value);
    nameInput.value = name;
    showSaveLabel();
    if (!isValidFileName(name)) { saveStatus.replaceChildren(h('div', { class: 'notice error' }, 'Ungültiger Dateiname.')); return false; }
    const missing = missingTags(tags());
    if (missing.length) {
      saveStatus.replaceChildren(h('div', { class: 'notice error' }, `Es fehlt: ${missing.join(', ')}. Bitte oben eintragen, dann die MP3 neu erstellen.`));
      return false;
    }
    const existing = findPublished(name);
    if (existing && !confirmed && !confirm(existing.original
      ? `${name} ${inT} ersetzen?\n\nDie aktuelle Fassung wird überschrieben; die zuerst veröffentlichte bleibt ${KEPT} erhalten.`
      : `${name} ${inT} ersetzen?\n\nDie bisherige Fassung wird ${KEPT} aufbewahrt.`)) return false;
    const bar = progressBar('Lade hoch …');
    saveStatus.replaceChildren(bar.el);
    saveBtn.disabled = true;
    try {
      const progress = (p: number, inCloud?: boolean) => bar.set(p, inCloud ? `Wird in ${T} gespeichert …` : 'Lade hoch …');
      const up = existing ? replaceUpload(name, r.blob, progress) : uploadFile(r.blob, name, progress);
      if (stored) {
        await up.received;
        st.uploadedAs = name;
        const note = h('div', { class: 'notice ok' }, `Angekommen: ${name} – wird in ${T} gespeichert`);
        saveStatus.replaceChildren(note);
        // the editor may show this file still: tell it there too
        const show = (cls: string, text: string) => { if (saveStatus.contains(note)) saveStatus.replaceChildren(h('div', { class: `notice ${cls}` }, text)); };
        up.promise.then(
          () => { show('ok', existing ? `Ersetzt: ${name}` : `Veröffentlicht: ${name}`); stored(true, existing ? `✓ ersetzt: ${name}` : `✓ veröffentlicht: ${name}`); },
          e => { show('error', (e as Error).message); stored(false, `⚠ ${(e as Error).message}`); });
        return true;
      }
      await up.promise;
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

  /**
   * Processes the files one after another with the options above and publishes them (replacing files of the same
   * name after one question). While OpenCloud still takes a file, the next one is already processed.
   */
  /**
   * Why a batch leaves this file out: no date in its name, or a date the eAg-Übersicht does not know ("unavailable":
   * no answer from it at all). Null if it may go through; with tags taken from the file ("keep") always.
   */
  async function unknownDetails(target: string): Promise<string | 'unavailable' | null> {
    if (tagMode === 'keep') return null;
    const day = dateFromFileName(target);
    if (!day) return 'kein Datum im Dateinamen';
    const o = await fetchOverview(day);
    return o === 'unavailable' ? o : o ? null : `${germanDate(day)} nicht in der eAg-Übersicht`;
  }

  async function runBatch(items: BatchItem[]) {
    if (batch || busy || !items.length) return;
    const targets = items.map(i => i.target);
    const twice = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
    if (twice.length) {
      toast(`Mehrere Dateien ergäben denselben Namen (${twice.join(', ')}). Bitte eine davon entfernen.`, 'error', 8000);
      return;
    }
    // unattended only where the eAg-Übersicht knows the date; the others are left for doing by hand
    const unknown = await Promise.all(items.map(i => unknownDetails(i.target)));
    if (unknown.includes('unavailable')) {
      toast('Die eAg-Übersicht ist gerade nicht erreichbar – ohne sie veröffentlicht der Stapel nichts. Bitte später noch einmal.', 'error', 10000);
      return;
    }
    items.forEach((item, k) => { if (unknown[k]) item.set('skipped', `nur einzeln: ${unknown[k]}`); });
    const total = items.length;
    items = items.filter((_, k) => !unknown[k]);
    let skipped = total - items.length;
    if (!items.length) {
      renderLists();
      toast(`Keine Datei für den Stapel: bei ${skipped === 1 ? 'der' : 'allen'} fehlen die Angaben in der eAg-Übersicht – nur einzeln möglich.`, 'error', 8000);
      return;
    }
    const clashes = items.map(i => i.target).filter(t => findPublished(t));
    if (clashes.length && !confirm(`${clashes.length === 1 ? 'Diese Datei wird' : `Diese ${clashes.length} Dateien werden`} ${inT} ersetzt:\n\n` +
      `${clashes.join('\n')}\n\nDie zuerst veröffentlichte Fassung bleibt jeweils ${KEPT} erhalten.`)) return;
    if (st.rendered && !st.uploadedAs && !confirm('Das aktuelle Ergebnis wurde noch nicht gespeichert. Trotzdem starten?')) return;

    const run = batch = { stop: false, at: 0, of: items.length, waiting: 0 };
    optionsSet.disabled = editorSet.disabled = true;
    let ok = 0;
    const pending: Promise<void>[] = [];
    for (const item of items) {
      if (run.stop) break;
      run.at++;
      item.set('running', 'wird bearbeitet …');
      renderLists();
      try {
        if (!await open(item.source)) throw new Error('nicht geladen');
        const missing = missingTags(tags());
        if (missing.length) {
          item.set('skipped', `nur einzeln: es fehlt ${missing.join(', ')}`);
          skipped++;
          renderLists();
          continue;
        }
        await create();
        // a quick server may report "stored" before save() returns: then the item is done, nothing to wait for
        let settled = false, waiting = false;
        let report: (ok: boolean, message: string) => void = () => undefined;
        const result = new Promise<void>(r => {
          report = (good, message) => {
            settled = true;
            item.set(good ? 'done' : 'error', message);
            if (good) ok++;
            if (waiting) run.waiting--;
            renderLists();
            r();
          };
        });
        if (!await save(true, report)) throw new Error('nicht gespeichert');
        if (!settled) {
          waiting = true;
          run.waiting++;
          item.set('running', `wird in ${T} gespeichert …`);
        }
        pending.push(result);
      } catch (e) {
        item.set('error', `⚠ ${(e as Error).message}`);
      }
      renderLists();
    }
    run.at = run.of + 1; // processing done; maybe still waiting for OpenCloud
    renderBatch();
    await Promise.all(pending);
    const stopped = run.stop && pending.length < items.length;
    batch = null;
    optionsSet.disabled = editorSet.disabled = false;
    await loadList();
    renderLists();
    toast(`${ok} von ${total} Dateien ${clashes.length === items.length ? 'ersetzt' : 'veröffentlicht'}` +
      `${skipped ? `, ${skipped} übersprungen (nur einzeln möglich)` : ''}${stopped ? ' – angehalten' : ''}.`, ok === total ? 'ok' : 'error', 8000);
  }

  /** The local files that are not done yet. */
  const runLocalBatch = () => runBatch(locals.filter(l => l.state !== 'done' && l.state !== 'skipped' && !l.mark).map(l => ({
    source: { local: l }, target: l.target, set: (state, status) => Object.assign(l, { state, status }),
  })));

  /** The ticked published files: each is processed from its first version and replaced. */
  const runPublishedBatch = () => {
    const files = published.filter(f => selected.has(f.name));
    const again = files.filter(f => markFor(f));
    if (again.length && !confirm(`${again.length === 1 ? 'Eine der ausgewählten Dateien ist' : `${again.length} der ausgewählten Dateien sind`} schon mit der App bearbeitet:\n\n` +
      `${again.slice(0, 20).map(f => f.name).join('\n')}${again.length > 20 ? '\n…' : ''}\n\n` +
      'Noch einmal bearbeiten reduziert Hall und Rauschen doppelt (die Stimme wird dünner) und kodiert die MP3 ein zweites Mal. Trotzdem alle bearbeiten?')) return;
    for (const f of files) publishedState.set(f.name, { state: 'waiting', status: 'wartet' });
    return runBatch(files.map(f => ({
      source: { published: f, fromOriginal: f.original }, target: f.name,
      set: (state, status) => { publishedState.set(f.name, { state, status }); if (state === 'done' || state === 'skipped') selected.delete(f.name); },
    })));
  };

  const editorSet = h('fieldset', { class: 'plain' },
    source,
    h('div', { class: 'listen' }, h('span', { class: 'muted small' }, 'Vorher'), before),
    tagWarn,
    h('div', { class: 'grid tag-grid' }, title.el, artist.el, album.el, track.el, albumArtist.el, genre.el, date.el, comment.el),
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
      h('div', { class: 'row list-tools' }, filter, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: loadList }, '↻ Neu laden'), tools),
      listBox,
      h('h3', { class: 'files-head' }, 'Vom Rechner'),
      drop, localInput,
      localBox,
      batchBox,
      loadStatus,
    ),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '2 · Bearbeitung')), optionsSet),
    editor,
  );
  advanced.sync();
  window.addEventListener('beforeunload', e => { if (batch || (st.rendered && !st.uploadedAs)) e.preventDefault(); });
  await loadList();
}
