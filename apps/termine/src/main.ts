import '../../../packages/ui-kit/ui.css';
import './app.css';
import { ensureLogin, isAdmin, logout } from '../../../packages/auth/auth';
import { h, $, download, toast } from '../../../packages/ui-kit/dom';
import { settingsStore, type Settings } from './settings';
import { exportXlsx, fetchData, fetchPlan, importXlsx, sendOp, type Loaded } from './api';
import { ANSWERS, LIMITS, applyOp, emptyEntry, isoDate, normalizeSign, type Answer, type DateEntry, type TermineData } from './model';
import type { PlanEntry, PlanResponse } from '../../../packages/plan/plan';
import { assignButton, fullNames, knownMischer } from '../../../packages/plan/assign';

const ANSWER_LABEL: Record<Answer, string> = { yes: 'Ja', maybe: 'Vielleicht', no: 'Nein' };
const ANSWER_ICON: Record<Answer, string> = { yes: '✓', maybe: '?', no: '✗' };
const POLL_MS = 60_000;
const PAST_STEP = 4;

await ensureLogin('Termine');

const main = $('#main');
const stand = $('#stand');
const settings: Settings = settingsStore.load();
let data: TermineData = { dates: {} };
/** the dates: the Einsatzplan from OpenCloud (team, Mischer, Beamer, remarks); `data` adds answers and notes */
let plan: PlanResponse | null = null;
const planEntry = (date: string) => plan?.entries.find(e => e.date === date);
let loaded = false;
let loadError = '';
/** how many past dates are listed (newest first), raised by "Ältere anzeigen" */
let pastShown = 0;
/** date whose card is in edit mode; its form is kept across re-renders so typing is not lost */
let editing: string | null = null;
let openForm: HTMLFormElement | null = null;
const startEdit = (date: string | null) => { editing = date; openForm = null; render(); };

const parseIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => isoDate(new Date());
const fmtLong = (iso: string) => parseIso(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Applies a server answer; warns once per count if rows of the spreadsheet had to be ignored. */
let warnedSkipped = 0;
function take(res: Loaded) {
  data = res.data;
  if (isAdmin() && res.skipped && res.skipped !== warnedSkipped) {
    toast(`${res.skipped} Zeile(n) in termine.xlsx haben kein gültiges Datum und werden ignoriert – beim nächsten Speichern gehen sie verloren.`, 'error', 10_000);
  }
  warnedSkipped = res.skipped;
}

/** Who mixes: the Einsatzplan's Mischer ("??" = nobody yet). */
const assignedText = (date: string) => { const m = planEntry(date)?.mischer.trim() ?? ''; return /^\?*$/.test(m) ? '' : m; };
/** Kürzel in the Mischer cell ("JD, MK" / "JD + Gast"). */
const assignedSigns = (text: string) => text.split(/[\s,;/+&]+/).map(normalizeSign).filter(Boolean);

/** Everyone who ever answered – used to show who has not answered yet. */
function knownSigns(): string[] {
  const all = new Set<string>();
  for (const e of Object.values(data.dates)) Object.keys(e.votes).forEach(s => all.add(s));
  if (settings.sign) all.add(settings.sign);
  return [...all].sort();
}

/** The dates of the Einsatzplan: all upcoming ones and the newest `pastShown` past ones. */
function visibleDates(): string[] {
  const all = (plan?.entries ?? []).map(e => e.date).sort();
  const t = today();
  const past = all.filter(d => d < t);
  const list = new Set([...(pastShown ? past.slice(-pastShown) : []), ...all.filter(d => d >= t)]);
  if (editing) list.add(editing);
  return [...list].sort();
}

const pastCount = () => (plan?.entries ?? []).filter(e => e.date < today()).length;

// ---- server ----

async function load(quiet = false) {
  try {
    const [res, p] = await Promise.all([fetchData(), fetchPlan()]);
    take(res);
    plan = p;
    loaded = true;
    loadError = '';
    stand.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    loadError = (e as Error).message;
    if (!quiet) toast(loadError, 'error');
  }
  render();
}

async function vote(date: string, answer: Answer | null) {
  if (!settings.sign) { toast('Bitte zuerst oben dein Kürzel eintragen.', 'error'); $<HTMLInputElement>('#sign')?.focus(); return; }
  const op = { action: 'vote' as const, date, sign: settings.sign, answer };
  try {
    applyOp(data, op); // optimistic; throws if the date is gone meanwhile (deleted in another window)
    render();
    take(await sendOp(op));
  } catch (e) {
    toast((e as Error).message, 'error');
    await load(true);
    return;
  }
  render();
}

async function saveEntry(date: string, fields: Pick<DateEntry, 'title' | 'time' | 'note'>) {
  try {
    take(await sendOp({ action: 'update', date, ...fields }));
    toast('Gespeichert.', 'ok', 2000);
    startEdit(null);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---- rendering ----

function signBar() {
  // suggestions: the Kürzel of the Einsatzplan's key, with the names
  const codes = h('datalist', { id: 'sign-codes' }, plan ? knownMischer(plan).map(c => h('option', { value: c }, plan!.names[c] ?? '')) : []);
  const input = h('input', {
    id: 'sign', value: settings.sign, maxlength: 6, placeholder: 'z. B. JD', autocomplete: 'off', list: 'sign-codes',
    autocapitalize: 'characters', spellcheck: 'false', class: 'sign-input',
  });
  const apply = () => {
    const v = normalizeSign(input.value);
    if (input.value.trim() && !v) { toast('Kürzel: 1–6 Buchstaben oder Ziffern.', 'error'); return; }
    if (v === settings.sign) { input.value = v; return; }
    settings.sign = v;
    settingsStore.save(settings);
    render();
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });

  return h('div', { class: 'toolbar' },
    h('label', { class: 'sign-label' }, 'Mein Kürzel', input), codes,
    h('span', { class: 'spacer' }),
    pastCount() > pastShown ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { pastShown += PAST_STEP; render(); } }, '↑ Ältere anzeigen') : '',
  );
}

function voteButtons(date: string, mine: Answer | undefined) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': 'Meine Antwort' },
    ...ANSWERS.map(a => h('button', {
      type: 'button', class: `seg-btn ans-${a}${mine === a ? ' on' : ''}`, 'aria-pressed': String(mine === a),
      title: mine === a ? 'Nochmal klicken zum Zurücknehmen' : '',
      onclick: () => vote(date, mine === a ? null : a),
    }, h('span', { 'aria-hidden': 'true' }, ANSWER_ICON[a]), ANSWER_LABEL[a])),
  );
}

function voteSummary(e: DateEntry, assigned: string[]) {
  const by: Record<Answer, string[]> = { yes: [], maybe: [], no: [] };
  for (const [sign, a] of Object.entries(e.votes).sort(([x], [y]) => x.localeCompare(y))) by[a].push(sign);
  const open = knownSigns().filter(s => !e.votes[s]);
  const chip = (s: string, cls: string) => h('span', {
    class: `chip ${cls}${s === settings.sign ? ' me' : ''}${assigned.includes(s) ? ' assigned' : ''}`,
    title: assigned.includes(s) ? 'eingeteilt' : '',
  }, s);
  return h('div', { class: 'votes' },
    Object.keys(e.votes).length ? '' : h('div', { class: 'muted' }, 'Noch keine Antworten.'),
    ...ANSWERS.filter(a => by[a].length).map(a => h('div', { class: `vote-line ans-${a}` },
      h('span', { class: 'vote-head' }, `${ANSWER_LABEL[a]} (${by[a].length})`),
      h('span', { class: 'chips' }, ...by[a].map(s => chip(s, `ans-${a}`))),
    )),
    open.length ? h('div', { class: 'vote-line open' },
      h('span', { class: 'vote-head' }, `Offen (${open.length})`),
      h('span', { class: 'chips' }, ...open.map(s => chip(s, 'ans-open'))),
    ) : '',
  );
}

/** The Mischer from the Einsatzplan, with a warning if an assigned person said no; the admin changes it with ✎. */
function assignedInfo(entry: PlanEntry, e: DateEntry, assigned: string[]) {
  const text = assignedText(entry.date);
  const edit = isAdmin() ? assignButton(entry, () => plan, () => void load()) : '';
  if (!text) return h('div', { class: 'assigned none' }, 'Mischer: noch niemand eingeteilt', edit);
  const warnings = assigned.filter(s => e.votes[s] === 'no' || e.votes[s] === 'maybe')
    .map(s => h('span', { class: `warn-tag ans-${e.votes[s]}` }, `${s} hat ${e.votes[s] === 'no' ? 'abgesagt' : '„vielleicht“ gesagt'}`));
  const names = fullNames(plan?.names ?? {}, text);
  return h('div', { class: 'assigned' },
    h('span', { class: 'muted' }, 'Mischer: '), h('strong', null, names), names !== text ? h('span', { class: 'muted' }, ` (${text})`) : '',
    edit,
    settings.sign && assigned.includes(settings.sign) ? h('span', { class: 'you-tag' }, 'Du') : '',
    ...warnings,
  );
}

/** What else the Einsatzplan says about the date. */
function planInfo(entry: PlanEntry) {
  const names = plan?.names ?? {};
  const parts = [
    entry.beamer && `Beamer: ${fullNames(names, entry.beamer)}`,
    (entry.team || entry.lead) && `Musik: ${[entry.team, entry.lead].filter(Boolean).join(' · ')}`,
  ].filter(Boolean);
  return parts.length ? h('div', { class: 'plan-info muted small' }, parts.join(' · ')) : '';
}

/** Admin: time, occasion and notes for a date (the date itself and the Mischer come from the Einsatzplan). */
function editForm(date: string, e: DateEntry) {
  const field = (label: string, key: 'title' | 'time', placeholder: string) =>
    h('label', null, label, h('input', { name: key, value: e[key], maxlength: LIMITS[key], placeholder }));
  const note = h('textarea', { name: 'note', rows: 3, maxlength: LIMITS.note, placeholder: 'z. B. Band spielt, Beamer wird gebraucht, Taufe …' });
  note.value = e.note;
  const form = h('form', {
    class: 'edit-form',
    onsubmit: (ev: Event) => {
      ev.preventDefault();
      const f = new FormData(form);
      const get = (k: string) => String(f.get(k) ?? '');
      void saveEntry(date, { title: get('title'), time: get('time'), note: get('note') });
    },
  },
    h('div', { class: 'grid' },
      field('Anlass / Titel', 'title', planEntry(date)?.special ? `leer = laut Einsatzplan: ${planEntry(date)!.special}` : 'z. B. Gottesdienst mit Abendmahl'),
      field('Uhrzeit', 'time', 'z. B. 10:00'),
    ),
    h('label', null, 'Hinweise', note),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => startEdit(null) }, 'Abbrechen'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Speichern'),
    ),
  );
  return form;
}

function dateCard(date: string, isNext: boolean) {
  const entry = planEntry(date)!;
  const e = data.dates[date] ?? emptyEntry();
  const d = parseIso(date);
  const past = date < today();
  const assigned = assignedSigns(assignedText(date));
  const title = e.title || entry.special;
  const mine = settings.sign ? e.votes[settings.sign] : undefined;
  const isEditing = editing === date;

  const card = h('article', { class: `card date-card${past ? ' past' : ''}${isNext ? ' next' : ''}${d.getDay() !== 0 ? ' extra' : ''}`, id: `d-${date}` },
    h('div', { class: 'date-head' },
      h('div', { class: 'cal', 'aria-hidden': 'true' },
        h('span', { class: 'cal-dow' }, d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')),
        h('span', { class: 'cal-day' }, String(d.getDate())),
        h('span', { class: 'cal-mon' }, d.toLocaleDateString('de-DE', { month: 'short' }).replace('.', '')),
      ),
      h('div', { class: 'date-info' },
        h('h2', null, fmtLong(date), e.time ? h('span', { class: 'muted' }, ` · ${e.time}`) : '',
          isNext ? h('span', { class: 'next-tag' }, 'Nächster Termin') : ''),
        title ? h('div', { class: 'date-title' }, title) : '',
        assignedInfo(entry, e, assigned),
        planInfo(entry),
      ),
      isEditing || !isAdmin() ? '' : h('button', {
        class: 'btn btn-ghost btn-sm edit-btn', type: 'button', title: 'Anlass, Uhrzeit und Hinweise bearbeiten',
        onclick: () => startEdit(date),
      }, '✎ Bearbeiten'),
    ),
    isEditing ? (openForm ??= editForm(date, e)) : e.note ? h('p', { class: 'note' }, e.note) : '',
    entry.note ? h('p', { class: 'note plan-note' }, entry.note) : '',
    h('div', { class: 'vote-row' },
      h('span', { class: 'vote-q' }, settings.sign ? `${settings.sign}, kannst du?` : 'Kannst du?'),
      voteButtons(date, mine),
    ),
    voteSummary(e, assigned),
  );
  return card;
}

function render() {
  const head = signBar();
  if (!loaded) {
    main.replaceChildren(head, loadError
      ? h('div', { class: 'notice error' }, loadError, ' ', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() }, 'Erneut versuchen'))
      : h('p', { class: 'muted' }, 'Lade Termine …'));
    return;
  }
  // keep focus in the sign field if the user is typing there
  const signFocused = document.activeElement?.id === 'sign';
  const dates = visibleDates();
  const next = dates.find(d => d >= today());
  main.replaceChildren(head,
    loadError ? h('div', { class: 'notice error' }, `Aktualisieren fehlgeschlagen: ${loadError}`) : '',
    plan?.syncError ? h('div', { class: 'notice warn' }, `Der Einsatzplan in OpenCloud kann gerade nicht gelesen werden (${plan.syncError}). Angezeigt wird der zuletzt gelesene Stand.`) : '',
    next ? '' : h('p', { class: 'muted center' }, 'Im Einsatzplan stehen keine kommenden Termine.'),
    ...dates.map(date => dateCard(date, date === next)),
    h('p', { class: 'muted small center' }, plan?.source === 'OpenCloud'
      ? 'Die Termine kommen aus dem Einsatzplan in OpenCloud (Musik_Mischer_Beamer.xlsx); ohne Gottesdienst („kein eAg“) erscheinen sie nicht.'
      : 'Die Termine kommen aus dem Einsatzplan (Startseite).'),
  );
  if (signFocused) $<HTMLInputElement>('#sign').focus();
}

// ---- settings ----

function openSettings() {
  const dlg = h('dialog', { class: 'settings narrow-dialog' });
  const downloadSheet = (fetchSheet: () => Promise<Blob>, name: string) => async () => {
    try { download(await fetchSheet(), name); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const importInput = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'hidden' });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    importInput.value = '';
    if (!f) return;
    if (!confirm(`Alle Antworten und Hinweise durch den Inhalt von „${f.name}“ ersetzen? Die bisherige Tabelle wird als termine.backup.xlsx auf dem Server aufgehoben.`)) return;
    try {
      const r = await importXlsx(f);
      toast(`${r.dates} Zeilen übernommen${r.skipped ? `, ${r.skipped} Zeile(n) ohne gültiges Datum ignoriert` : ''}.`, r.skipped ? 'info' : 'ok', 7000);
      dlg.close();
      void load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });

  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', null, 'Einstellungen'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => dlg.close() }, 'Schließen'),
    ),
    h('div', { class: 'dlg-body' },
      h('fieldset', null, h('legend', null, 'Termine (Excel)'),
        h('p', { class: 'muted small' },
          'Die Termine selbst kommen aus dem Einsatzplan in OpenCloud. In der Excel-Datei auf dem Server (termine.xlsx) stehen die ' +
          'Antworten (eine Spalte pro Kürzel) und die Hinweise. Hochladen ersetzt sie alle; der alte Stand bleibt als termine.backup.xlsx.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: downloadSheet(exportXlsx, 'termine.xlsx') }, '⬇ Aktuelle Tabelle'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => importInput.click() }, '⬆ Hochladen …'),
          importInput,
        ),
      ),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

$('#settings').addEventListener('click', openSettings);
$('#logout').addEventListener('click', logout);
$('#refresh').addEventListener('click', () => load());

// Keep the list fresh while the page is open, and catch up when the tab becomes visible again
setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load(true); });

render();
void load();
