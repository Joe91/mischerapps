import '../../../packages/ui-kit/ui.css';
import './app.css';
import { ensureLogin, isAdmin, logout } from '../../../packages/auth/auth';
import { h, $, download, toast } from '../../../packages/ui-kit/dom';
import { settingsStore, type Settings } from './settings';
import { exportXlsx, fetchData, fetchPlanMischer, importXlsx, sendOp, templateXlsx, type Loaded } from './api';
import {
  ANSWERS, LIMITS, applyOp, emptyEntry, isValidDate, isoDate, normalizeSign,
  type Answer, type DateEntry, type TermineData,
} from './model';

const ANSWER_LABEL: Record<Answer, string> = { yes: 'Ja', maybe: 'Vielleicht', no: 'Nein' };
const ANSWER_ICON: Record<Answer, string> = { yes: '✓', maybe: '?', no: '✗' };
const POLL_MS = 60_000;
const PAST_STEP = 4;

await ensureLogin('Termine');

const main = $('#main');
const stand = $('#stand');
const settings: Settings = settingsStore.load();
let data: TermineData = { dates: {} };
/** date → Mischer from the Einsatzplan: stands in for an empty "Eingeteilt" */
let planMischer: Record<string, string> = {};
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

/** "Eingeteilt" as entered, otherwise the Mischer from the Einsatzplan (so a new plan shows up without editing every date). */
const assignedText = (date: string, e: DateEntry) => e.assigned || planMischer[date] || '';
/** Kürzel mentioned in the free-text "assigned" field ("JD, MK" / "JD + Gast"). */
const assignedSigns = (text: string) => text.split(/[\s,;/+&]+/).map(normalizeSign).filter(Boolean);

/** Everyone who ever answered – used to show who has not answered yet. */
function knownSigns(): string[] {
  const all = new Set<string>();
  for (const e of Object.values(data.dates)) Object.keys(e.votes).forEach(s => all.add(s));
  if (settings.sign) all.add(settings.sign);
  return [...all].sort();
}

/** Only the dates on the list (= rows of the spreadsheet): all upcoming ones and the newest `pastShown` past ones. */
function visibleDates(): string[] {
  const all = Object.keys(data.dates).sort();
  const t = today();
  const past = all.filter(d => d < t);
  const list = new Set([...(pastShown ? past.slice(-pastShown) : []), ...all.filter(d => d >= t)]);
  if (editing) list.add(editing);
  return [...list].sort();
}

const pastCount = () => Object.keys(data.dates).filter(d => d < today()).length;

// ---- server ----

async function load(quiet = false) {
  try {
    // the plan is extra information: if it fails, keep the last one
    const [res, plan] = await Promise.all([fetchData(), fetchPlanMischer().catch(() => planMischer)]);
    take(res);
    planMischer = plan;
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

async function saveEntry(date: string, fields: Pick<DateEntry, 'title' | 'time' | 'assigned' | 'note'>) {
  try {
    take(await sendOp({ action: 'update', date, ...fields }));
    toast('Gespeichert.', 'ok', 2000);
    startEdit(null);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Admin: puts a date on the list (any day, e.g. a holiday) and opens it for details. */
async function addDate(date: string) {
  if (!data.dates[date]) {
    try {
      take(await sendOp({ action: 'add', date }));
    } catch (e) {
      toast((e as Error).message, 'error');
      return;
    }
    if (date < today()) pastShown = Math.max(pastShown, Object.keys(data.dates).filter(d => d >= date && d < today()).length);
  }
  startEdit(date);
  document.getElementById(`d-${date}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---- rendering ----

function signBar() {
  const input = h('input', {
    id: 'sign', value: settings.sign, maxlength: 6, placeholder: 'z. B. JD', autocomplete: 'off',
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

  const extra = h('input', { type: 'date', class: 'hidden' });
  extra.addEventListener('change', () => { if (isValidDate(extra.value)) void addDate(extra.value); });

  return h('div', { class: 'toolbar' },
    h('label', { class: 'sign-label' }, 'Mein Kürzel', input),
    h('span', { class: 'spacer' }),
    pastCount() > pastShown ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { pastShown += PAST_STEP; render(); } }, '↑ Ältere anzeigen') : '',
    isAdmin() ? h('button', {
      class: 'btn btn-sm', type: 'button', title: 'Einen Tag (Sonntag oder z. B. Feiertag) zur Liste hinzufügen',
      onclick: () => { extra.classList.remove('hidden'); extra.showPicker?.(); extra.focus(); },
    }, '+ Termin hinzufügen') : '',
    isAdmin() ? extra : '',
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

function assignedInfo(date: string, e: DateEntry, assigned: string[]) {
  const text = assignedText(date, e);
  if (!text) return h('div', { class: 'assigned none' }, 'Noch niemand eingeteilt');
  const warnings = assigned.filter(s => e.votes[s] === 'no' || e.votes[s] === 'maybe')
    .map(s => h('span', { class: `warn-tag ans-${e.votes[s]}` }, `${s} hat ${e.votes[s] === 'no' ? 'abgesagt' : '„vielleicht“ gesagt'}`));
  return h('div', { class: 'assigned' },
    h('span', { class: 'muted' }, 'Eingeteilt: '), h('strong', null, text),
    e.assigned ? '' : h('span', {
      class: 'plan-tag', title: 'Mischer aus dem Einsatzplan (Startseite). Ein eigener Eintrag unter „Bearbeiten“ hat Vorrang.',
    }, 'laut Einsatzplan'),
    settings.sign && assigned.includes(settings.sign) ? h('span', { class: 'you-tag' }, 'Du') : '',
    ...warnings,
  );
}

async function deleteEntry(date: string) {
  if (!confirm(`Den Termin am ${fmtLong(date)} mit allen Antworten löschen?`)) return;
  try {
    take(await sendOp({ action: 'delete', date }));
    toast('Termin gelöscht.', 'ok', 2000);
    startEdit(null);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function editForm(date: string, e: DateEntry) {
  const field = (label: string, key: 'title' | 'time' | 'assigned', placeholder: string) =>
    h('label', null, label, h('input', { name: key, value: e[key], maxlength: LIMITS[key], placeholder }));
  const note = h('textarea', { name: 'note', rows: 3, maxlength: LIMITS.note, placeholder: 'z. B. Band spielt, Beamer wird gebraucht, Taufe …' });
  note.value = e.note;
  const form = h('form', {
    class: 'edit-form',
    onsubmit: (ev: Event) => {
      ev.preventDefault();
      const f = new FormData(form);
      const get = (k: string) => String(f.get(k) ?? '');
      void saveEntry(date, { title: get('title'), time: get('time'), assigned: get('assigned'), note: get('note') });
    },
  },
    h('div', { class: 'grid' },
      field('Anlass / Titel', 'title', 'z. B. Gottesdienst mit Abendmahl'),
      field('Uhrzeit', 'time', 'z. B. 10:00'),
      // the plan's Mischer only as placeholder: saved, it would no longer follow a newly imported plan
      field('Eingeteilt', 'assigned', planMischer[date] ? `leer = laut Einsatzplan: ${planMischer[date]}` : 'Kürzel, z. B. JD, MK'),
    ),
    h('label', null, 'Hinweise', note),
    h('div', { class: 'actions' },
      data.dates[date] ? h('button', { class: 'btn btn-danger', type: 'button', onclick: () => deleteEntry(date) }, 'Termin löschen') : '',
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => startEdit(null) }, 'Abbrechen'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Speichern'),
    ),
  );
  return form;
}

function dateCard(date: string, isNext: boolean) {
  const e = data.dates[date] ?? emptyEntry();
  const d = parseIso(date);
  const past = date < today();
  const assigned = assignedSigns(assignedText(date, e));
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
        e.title ? h('div', { class: 'date-title' }, e.title) : '',
        assignedInfo(date, e, assigned),
      ),
      isEditing || !isAdmin() ? '' : h('button', {
        class: 'btn btn-ghost btn-sm edit-btn', type: 'button', title: 'Anlass, Uhrzeit, Einteilung und Hinweise bearbeiten',
        onclick: () => startEdit(date),
      }, '✎ Bearbeiten'),
    ),
    isEditing ? (openForm ??= editForm(date, e)) : e.note ? h('p', { class: 'note' }, e.note) : '',
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
    next ? '' : h('p', { class: 'muted center' }, isAdmin()
      ? 'Noch keine kommenden Termine. Mit „+ Termin hinzufügen“ oder über ⚙ Einstellungen → Tabelle (Vorlage mit allen Sonntagen) anlegen.'
      : 'Noch keine kommenden Termine eingetragen.'),
    ...dates.map(date => dateCard(date, date === next)),
    h('p', { class: 'muted small center' }, isAdmin()
      ? 'Angezeigt werden nur die eingetragenen Termine – weitere über „+ Termin hinzufügen“ oder die Tabelle in den Einstellungen.'
      : 'Angezeigt werden die Termine, die der Admin eingetragen hat.'),
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
    if (!confirm(`Alle Termine durch den Inhalt von „${f.name}“ ersetzen? Die bisherige Tabelle wird als termine.backup.xlsx auf dem Server aufgehoben.`)) return;
    try {
      const r = await importXlsx(f);
      toast(`${r.dates} Termine übernommen${r.skipped ? `, ${r.skipped} Zeile(n) ohne gültiges Datum ignoriert` : ''}.`, r.skipped ? 'info' : 'ok', 7000);
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
          'Die App zeigt genau die Termine, die in der Excel-Datei auf dem Server (termine.xlsx) stehen: eine Zeile pro Termin, ' +
          'eine Spalte pro Kürzel. Es gibt keine automatischen Sonntage.'),
        h('p', { class: 'muted small' },
          'Auswählen mit der Vorlage: Sie enthält die bisherigen Termine und dazu die nächsten 52 Sonntage. Zeilen, die ihr nicht braucht, ' +
          'in Excel löschen, speichern und wieder hochladen – das Hochladen ersetzt alle Termine.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: downloadSheet(templateXlsx, 'termine-vorlage.xlsx') }, '⬇ Vorlage mit allen Sonntagen'),
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
