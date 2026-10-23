import '../../../packages/ui-kit/ui.css';
import './app.css';
import { ensureLogin, isAdmin, logout } from '../../../packages/auth/auth';
import { h, $, toast } from '../../../packages/ui-kit/dom';
import { isoDate } from '../../../packages/plan/cells';
import type { PlanEntry, PlanResponse } from '../../../packages/plan/plan';
import { assignButton, fullNames, knownMischer } from '../../../packages/plan/assign';
import { settingsStore, type Settings } from './settings';
import { fetchPlan, sendAnswer } from './api';
import { ANSWERS, normalizeSign, type Answer } from './model';

// The Termine: the dates of the Einsatzplan in OpenCloud, and who can mix on them. Everything – dates, Mischer,
// answers – is in that spreadsheet; an answer is written into "Mischer möglich" / "nicht möglich" (see plan.ts).

const ANSWER_LABEL: Record<Answer, string> = { yes: 'Ja', maybe: 'Vielleicht', no: 'Nein' };
const ANSWER_ICON: Record<Answer, string> = { yes: '✓', maybe: '?', no: '✗' };
const POLL_MS = 60_000;
const PAST_STEP = 4;

await ensureLogin('Termine');

const main = $('#main');
const stand = $('#stand');
const settings: Settings = settingsStore.load();
let plan: PlanResponse | null = null;
let loadError = '';
/** how many past dates are listed (newest first), raised by "Ältere anzeigen" */
let pastShown = 0;

const parseIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => isoDate(new Date());
const fmtLong = (iso: string) => parseIso(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const names = () => plan?.names ?? {};

/** Who mixes: the plan's Mischer ("??" = nobody yet). */
const mischerText = (e: PlanEntry) => (/^\?*$/.test(e.mischer.trim()) ? '' : e.mischer.trim());
/** Kürzel in the Mischer cell ("JD, MK" / "JD + Gast"). */
const signsIn = (text: string) => text.split(/[\s,;/+&]+/).map(normalizeSign).filter(Boolean);

/** The Mischer team: everyone who answered somewhere or was assigned, to show who has not answered yet. */
function knownSigns(): string[] {
  const all = new Set<string>();
  for (const e of plan?.entries ?? []) {
    Object.keys(e.votes).forEach(s => all.add(s));
    signsIn(mischerText(e)).forEach(s => all.add(s));
  }
  if (settings.sign) all.add(settings.sign);
  return [...all].sort();
}

/** All upcoming dates and the newest `pastShown` past ones. */
function visibleEntries(): PlanEntry[] {
  const all = [...plan?.entries ?? []].sort((a, b) => a.date.localeCompare(b.date));
  const past = all.filter(e => e.date < today());
  return [...(pastShown ? past.slice(-pastShown) : []), ...all.filter(e => e.date >= today())];
}

const pastCount = () => (plan?.entries ?? []).filter(e => e.date < today()).length;

// ---- server ----

async function load(quiet = false) {
  try {
    plan = await fetchPlan();
    loadError = '';
    stand.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    loadError = (e as Error).message;
    if (!quiet) toast(loadError, 'error');
  }
  render();
}

async function vote(e: PlanEntry, answer: Answer | null) {
  if (!settings.sign) { toast('Bitte zuerst oben dein Kürzel eintragen.', 'error'); $<HTMLInputElement>('#sign')?.focus(); return; }
  // shown at once; the spreadsheet in OpenCloud takes a moment
  if (answer) e.votes[settings.sign] = answer; else delete e.votes[settings.sign];
  render();
  try {
    await sendAnswer(e.date, settings.sign, answer);
  } catch (err) {
    toast((err as Error).message, 'error', 8000);
  }
  await load(true);
}

// ---- rendering ----

function signBar() {
  // suggestions: the Kürzel of the Einsatzplan's key, with the names
  const codes = h('datalist', { id: 'sign-codes' }, plan ? knownMischer(plan).map(c => h('option', { value: c }, names()[c] ?? '')) : []);
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
    settings.sign && names()[settings.sign] ? h('span', { class: 'muted small' }, names()[settings.sign]) : '',
    h('span', { class: 'spacer' }),
    pastCount() > pastShown ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { pastShown += PAST_STEP; render(); } }, '↑ Ältere anzeigen') : '',
  );
}

function voteButtons(e: PlanEntry, mine: Answer | undefined) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': 'Meine Antwort' },
    ...ANSWERS.map(a => h('button', {
      type: 'button', class: `seg-btn ans-${a}${mine === a ? ' on' : ''}`, 'aria-pressed': String(mine === a),
      title: mine === a ? 'Nochmal klicken zum Zurücknehmen' : '',
      onclick: () => vote(e, mine === a ? null : a),
    }, h('span', { 'aria-hidden': 'true' }, ANSWER_ICON[a]), ANSWER_LABEL[a])),
  );
}

function voteSummary(e: PlanEntry, assigned: string[]) {
  const by: Record<Answer, string[]> = { yes: [], maybe: [], no: [] };
  for (const [sign, a] of Object.entries(e.votes).sort(([x], [y]) => x.localeCompare(y))) by[a].push(sign);
  const open = knownSigns().filter(s => !e.votes[s]);
  const chip = (s: string, cls: string) => h('span', {
    class: `chip ${cls}${s === settings.sign ? ' me' : ''}${assigned.includes(s) ? ' assigned' : ''}`,
    title: [names()[s], assigned.includes(s) ? 'eingeteilt' : ''].filter(Boolean).join(' · '),
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

/** The Mischer, with a warning if an assigned person said no; the admin changes it with ✎. */
function assignedInfo(e: PlanEntry, assigned: string[]) {
  const text = mischerText(e);
  const edit = isAdmin() ? assignButton(e, () => plan, () => void load()) : '';
  if (!text) return h('div', { class: 'assigned none' }, 'Mischer: noch niemand eingeteilt', edit);
  const warnings = assigned.filter(s => e.votes[s] === 'no' || e.votes[s] === 'maybe')
    .map(s => h('span', { class: `warn-tag ans-${e.votes[s]}` }, `${s} hat ${e.votes[s] === 'no' ? 'abgesagt' : '„vielleicht“ gesagt'}`));
  const full = fullNames(names(), text);
  return h('div', { class: 'assigned' },
    h('span', { class: 'muted' }, 'Mischer: '), h('strong', null, full), full !== text ? h('span', { class: 'muted' }, ` (${text})`) : '',
    edit,
    settings.sign && assigned.includes(settings.sign) ? h('span', { class: 'you-tag' }, 'Du') : '',
    ...warnings,
  );
}

/** What else the plan says about the date. */
function planInfo(e: PlanEntry) {
  const parts = [
    e.beamer && `Beamer: ${fullNames(names(), e.beamer)}`,
    (e.team || e.lead) && `Musik: ${[e.team, e.lead].filter(Boolean).join(' · ')}`,
  ].filter(Boolean);
  return parts.length ? h('div', { class: 'plan-info muted small' }, parts.join(' · ')) : '';
}

function dateCard(e: PlanEntry, isNext: boolean) {
  const d = parseIso(e.date);
  const past = e.date < today();
  const assigned = signsIn(mischerText(e));
  const mine = settings.sign ? e.votes[settings.sign] : undefined;
  return h('article', { class: `card date-card${past ? ' past' : ''}${isNext ? ' next' : ''}${d.getDay() !== 0 ? ' extra' : ''}`, id: `d-${e.date}` },
    h('div', { class: 'date-head' },
      h('div', { class: 'cal', 'aria-hidden': 'true' },
        h('span', { class: 'cal-dow' }, d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')),
        h('span', { class: 'cal-day' }, String(d.getDate())),
        h('span', { class: 'cal-mon' }, d.toLocaleDateString('de-DE', { month: 'short' }).replace('.', '')),
      ),
      h('div', { class: 'date-info' },
        h('h2', null, fmtLong(e.date), isNext ? h('span', { class: 'next-tag' }, 'Nächster Termin') : ''),
        e.special ? h('div', { class: 'date-title' }, e.special) : '',
        assignedInfo(e, assigned),
        planInfo(e),
      ),
    ),
    e.note ? h('p', { class: 'note' }, e.note) : '',
    h('div', { class: 'vote-row' },
      h('span', { class: 'vote-q' }, settings.sign ? `${settings.sign}, kannst du mischen?` : 'Kannst du mischen?'),
      voteButtons(e, mine),
    ),
    voteSummary(e, assigned),
  );
}

function render() {
  const head = signBar();
  if (!plan) {
    main.replaceChildren(head, loadError
      ? h('div', { class: 'notice error' }, loadError, ' ', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() }, 'Erneut versuchen'))
      : h('p', { class: 'muted' }, 'Lade Termine …'));
    return;
  }
  // keep focus in the sign field if the user is typing there
  const signFocused = document.activeElement?.id === 'sign';
  const entries = visibleEntries();
  const next = entries.find(e => e.date >= today());
  main.replaceChildren(head,
    loadError ? h('div', { class: 'notice error' }, `Aktualisieren fehlgeschlagen: ${loadError}`) : '',
    plan.syncError ? h('div', { class: 'notice warn' }, `Der Einsatzplan in OpenCloud kann gerade nicht gelesen werden (${plan.syncError}). Angezeigt wird der zuletzt gelesene Stand.`) : '',
    next ? '' : h('p', { class: 'muted center' }, 'Im Einsatzplan stehen keine kommenden Termine.'),
    ...entries.map(e => dateCard(e, e === next)),
    h('p', { class: 'muted small center' }, plan.source === 'OpenCloud'
      ? 'Termine und Antworten stehen im Einsatzplan in OpenCloud (Musik_Mischer_Beamer.xlsx, Spalten „Mischer möglich“ und „nicht möglich“).'
      : 'Termine und Antworten stehen im Einsatzplan (Startseite).'),
  );
  if (signFocused) $<HTMLInputElement>('#sign').focus();
}

$('#logout').addEventListener('click', logout);
$('#refresh').addEventListener('click', () => load());

// Keep the list fresh while the page is open, and catch up when the tab becomes visible again
setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load(true); });

render();
void load();
