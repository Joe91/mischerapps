import '../../../packages/ui-kit/ui.css';
import './app.css';
import { ensureLogin, logout } from '../../../packages/auth/auth';
import { h, $, toast } from '../../../packages/ui-kit/dom';
import { settingsStore, type Settings } from './settings';
import { fetchData, sendOp } from './api';
import {
  ANSWERS, LIMITS, applyOp, emptyEntry, isValidDate, isoDate, normalizeSign, sundays,
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
let loaded = false;
let loadError = '';
let pastWeeks = 0;
/** date whose card is in edit mode; its form is kept across re-renders so typing is not lost */
let editing: string | null = null;
let openForm: HTMLFormElement | null = null;
const startEdit = (date: string | null) => { editing = date; openForm = null; render(); };

const parseIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => isoDate(new Date());
const fmtLong = (iso: string) => parseIso(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const configured = () => !!(settings.url && settings.token);

/** Kürzel mentioned in the free-text "assigned" field ("JD, MK" / "JD + Gast"). */
const assignedSigns = (e: DateEntry) => e.assigned.split(/[\s,;/+&]+/).map(normalizeSign).filter(Boolean);

/** Everyone who ever answered – used to show who has not answered yet. */
function knownSigns(): string[] {
  const all = new Set<string>();
  for (const e of Object.values(data.dates)) Object.keys(e.votes).forEach(s => all.add(s));
  if (settings.sign) all.add(settings.sign);
  return [...all].sort();
}

function visibleDates(): string[] {
  const shown = sundays(new Date(), settings.weeks + pastWeeks, -pastWeeks);
  const from = pastWeeks ? shown[0] : today();
  const list = new Set(shown);
  for (const d of Object.keys(data.dates)) if (d >= from) list.add(d);
  if (editing) list.add(editing);
  return [...list].filter(d => d >= from || d === editing).sort();
}

// ---- server ----

async function load(quiet = false) {
  if (!configured()) { render(); return; }
  try {
    data = await fetchData(settings);
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
  applyOp(data, op); // optimistic
  render();
  try {
    data = await sendOp(settings, op);
  } catch (e) {
    toast((e as Error).message, 'error');
    await load(true);
    return;
  }
  render();
}

async function saveEntry(date: string, fields: Pick<DateEntry, 'title' | 'time' | 'assigned' | 'note'>) {
  try {
    data = await sendOp(settings, { action: 'update', date, ...fields });
    toast('Gespeichert.', 'ok', 2000);
    startEdit(null);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
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
  extra.addEventListener('change', () => {
    if (!isValidDate(extra.value)) return;
    startEdit(extra.value);
    document.getElementById(`d-${extra.value}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  return h('div', { class: 'toolbar' },
    h('label', { class: 'sign-label' }, 'Mein Kürzel', input),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { pastWeeks += PAST_STEP; render(); } }, '↑ Ältere anzeigen'),
    h('button', {
      class: 'btn btn-sm', type: 'button', title: 'Termin an einem anderen Tag (z. B. Feiertag) anlegen',
      onclick: () => { extra.classList.remove('hidden'); extra.showPicker?.(); extra.focus(); },
    }, '+ Weiterer Termin'),
    extra,
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

function assignedInfo(e: DateEntry, assigned: string[]) {
  if (!e.assigned) return h('div', { class: 'assigned none' }, 'Noch niemand eingeteilt');
  const warnings = assigned.filter(s => e.votes[s] === 'no' || e.votes[s] === 'maybe')
    .map(s => h('span', { class: `warn-tag ans-${e.votes[s]}` }, `${s} hat ${e.votes[s] === 'no' ? 'abgesagt' : '„vielleicht“ gesagt'}`));
  return h('div', { class: 'assigned' },
    h('span', { class: 'muted' }, 'Eingeteilt: '), h('strong', null, e.assigned),
    settings.sign && assigned.includes(settings.sign) ? h('span', { class: 'you-tag' }, 'Du') : '',
    ...warnings,
  );
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
      field('Eingeteilt', 'assigned', 'Kürzel, z. B. JD, MK'),
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
  const e = data.dates[date] ?? emptyEntry();
  const d = parseIso(date);
  const past = date < today();
  const assigned = assignedSigns(e);
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
        assignedInfo(e, assigned),
      ),
      isEditing ? '' : h('button', {
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
  if (!configured()) {
    main.replaceChildren(head, h('div', { class: 'notice warn' },
      'Kein Server eingerichtet. Bitte unter ', h('button', { class: 'btn btn-sm', type: 'button', onclick: openSettings }, '⚙ Einstellungen'),
      ' die URL von termine.php und das Token eintragen.'));
    return;
  }
  if (!loaded) {
    main.replaceChildren(head, loadError
      ? h('div', { class: 'notice error' }, loadError, ' ', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() }, 'Erneut versuchen'))
      : h('p', { class: 'muted' }, 'Lade Termine …'));
    return;
  }
  // keep focus in the sign field if the user is typing there
  const signFocused = document.activeElement?.id === 'sign';
  const next = visibleDates().find(d => d >= today());
  main.replaceChildren(head,
    loadError ? h('div', { class: 'notice error' }, `Aktualisieren fehlgeschlagen: ${loadError}`) : '',
    ...visibleDates().map(date => dateCard(date, date === next)),
    h('p', { class: 'muted small center' }, `Angezeigt: die nächsten ${settings.weeks} Sonntage und alle weiteren eingetragenen Termine. Anzahl in den Einstellungen änderbar.`),
  );
  if (signFocused) $<HTMLInputElement>('#sign').focus();
}

// ---- settings ----

function openSettings() {
  const draft = { ...settings };
  const dlg = h('dialog', { class: 'settings narrow-dialog' });
  const input = (label: string, key: 'url' | 'token', attrs: Record<string, unknown>) => {
    const el = h('input', { ...attrs, value: draft[key], spellcheck: 'false', autocomplete: 'off' });
    el.addEventListener('input', () => { draft[key] = el.value.trim(); });
    return { el, label: h('label', null, label, el) };
  };
  const url = input('Server-URL (termine.php)', 'url', { type: 'url', placeholder: 'https://example.org/termine.php' });
  const token = input('Token', 'token', { type: 'password' });
  const weeks = h('input', { type: 'number', min: 1, max: 52, value: String(draft.weeks) });
  weeks.addEventListener('change', () => { const v = Math.round(Number(weeks.value)); if (v >= 1 && v <= 52) draft.weeks = v; });

  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', null, 'Einstellungen'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button', {
        class: 'btn btn-primary', type: 'button', onclick: () => {
          Object.assign(settings, draft);
          settingsStore.save(settings);
          dlg.close();
          loaded = false;
          void load();
        },
      }, 'Speichern'),
    ),
    h('div', { class: 'dlg-body' },
      h('fieldset', null, h('legend', null, 'Server'),
        h('p', { class: 'muted small' }, 'Adresse von server/termine.php und das dort eingetragene Token. Wird nur in diesem Browser gespeichert.'),
        h('div', { class: 'grid' }, url.label,
          h('label', null, 'Token', h('div', { class: 'row nowrap' }, token.el,
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { token.el.type = token.el.type === 'password' ? 'text' : 'password'; } }, '👁')))),
      ),
      h('fieldset', null, h('legend', null, 'Anzeige'),
        h('label', null, 'Anzahl kommender Sonntage', weeks),
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
