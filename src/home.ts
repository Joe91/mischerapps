import '../packages/ui-kit/ui.css';
import './home.css';
import apps from '../apps.json';
import { ensureLogin, isAdmin, logout } from '../packages/auth/auth';
import { h, $, toast } from '../packages/ui-kit/dom';
import { isoDate } from '../apps/termine/src/model';
import type { PlanEntry, PlanResponse } from '../packages/plan/plan';

interface AppEntry { id: string; title: string; description: string; path: string; icon: string; }

const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---- Einsatzplan: the next two dates as cards, the rest (logged in only) behind a button ----

const planBox = $('#plan');
let plan: PlanResponse | null = null;
let planError = '';
let showAll = false;
let loads = 0;

const parseIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => isoDate(new Date());

async function loadPlan() {
  const load = ++loads;
  let next: PlanResponse | null = null;
  try {
    const res = await fetch('/api/plan', { cache: 'no-store' });
    if (res.ok) next = await res.json();
  } catch { /* offline */ }
  if (load !== loads) return; // a later load (e.g. right after logging in) wins
  if (next) plan = next;
  planError = next ? '' : 'Der Einsatzplan konnte nicht geladen werden.';
  renderPlan();
}

/** "KL" → "Udo Klaus", also several ("AS, JD"); words that are no known Kürzel stay as they are. */
const fullNames = (text: string) => text.replace(/\p{L}+/gu, w => plan?.names[w] ?? w);
/** nobody entered yet ("", "?", "??") */
const isOpen = (text: string) => /^\?*$/.test(text.trim());
const team = (e: PlanEntry) => [e.team, e.lead].filter(Boolean).join(' · ');

function relativeDay(iso: string): string {
  const days = Math.round((parseIso(iso).getTime() - parseIso(today()).getTime()) / 86_400_000);
  return days === 0 ? 'heute' : days === 1 ? 'morgen' : days < 14 ? `in ${days} Tagen` : '';
}

function person(label: string, value: string, main = false) {
  const open = isOpen(value);
  const name = fullNames(value);
  return h('div', { class: `role${main ? ' role-main' : ''}${open ? ' open' : ''}` },
    h('span', { class: 'role-label' }, label),
    h('span', { class: 'role-name' }, open ? value || 'offen' : name),
    !open && name !== value ? h('span', { class: 'role-code' }, value) : '',
  );
}

function nextCard(e: PlanEntry, first: boolean) {
  const rel = relativeDay(e.date);
  return h('article', { class: `card plan-card${first ? ' first' : ''}` },
    h('div', { class: 'plan-when' },
      h('span', { class: 'plan-date' }, parseIso(e.date).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })),
      rel ? h('span', { class: 'plan-rel' }, rel) : ''),
    person('Mischer', e.mischer, true),
    h('div', { class: 'plan-roles' },
      person('Beamer', e.beamer),
      h('div', { class: 'role' }, h('span', { class: 'role-label' }, 'Musik'), h('span', { class: 'role-name' }, team(e) || '–')),
    ),
    [e.special, e.note].filter(Boolean).map(t => h('p', { class: 'plan-extra' }, t)),
  );
}

function planList(entries: PlanEntry[], past = false) {
  return h('ul', { class: `plan-list${past ? ' past' : ''}` },
    h('li', { class: 'plan-row plan-list-head', 'aria-hidden': 'true' }, h('span', null, 'Datum'), h('span', null, 'Mischer'), h('span', null, 'Beamer · Musik')),
    entries.map(e => h('li', { class: 'plan-row' },
      h('span', { class: 'plan-row-date' }, parseIso(e.date).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })),
      h('span', { class: `plan-row-mischer${isOpen(e.mischer) ? ' open' : ''}` }, isOpen(e.mischer) ? e.mischer || 'offen' : fullNames(e.mischer)),
      h('span', { class: 'plan-row-rest' }, [`Beamer ${fullNames(e.beamer) || '–'}`, team(e), e.special, e.note].filter(Boolean).join(' · ')),
    )),
  );
}

/** Admin: uploads the church's spreadsheet (e.g. Musik_Mischer_Beamer.xlsx); it replaces the previous plan. */
function importButton() {
  const input = h('input', { type: 'file', accept: XLSX_ACCEPT, class: 'hidden' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      let res: Response;
      try { res = await fetch('/api/plan/import', { method: 'POST', body: f }); } catch { throw new Error('Server nicht erreichbar.'); }
      if (!res.ok) {
        throw new Error(res.status === 400 ? 'Das ist keine Excel-Datei mit den Spalten „Datum“ und „Mischer“ auf dem ersten Blatt.'
          : res.status === 413 ? 'Die Datei ist zu groß.' : `Hochladen fehlgeschlagen (${res.status}).`);
      }
      const r = await res.json() as { dates: number; hidden: number };
      toast(`${r.dates} Termine übernommen${r.hidden ? `, ${r.hidden} ohne eAg ausgeblendet` : ''}.`, 'ok', 6000);
      await loadPlan();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });
  return [
    h('button', {
      class: 'btn btn-sm', type: 'button', onclick: () => input.click(),
      title: 'Excel-Datei hochladen. Gelesen wird das erste Blatt mit den Spalten Datum, Musikteam, Teamleitung, Mischer und Beamer.',
    }, plan?.updated ? '⬆ Neuen Plan importieren' : '⬆ Plan importieren'),
    input,
  ];
}

function renderPlan() {
  const admin = isAdmin();
  if (!plan || (!plan.updated && !admin)) {
    planBox.replaceChildren(planError ? h('p', { class: 'notice error' }, planError) : '');
    return;
  }
  const t = today();
  const upcoming = plan.entries.filter(e => e.date >= t);
  const past = plan.entries.filter(e => e.date < t).reverse();
  const rest = upcoming.slice(2);
  const more = rest.length + past.length;
  planBox.replaceChildren(...[
    h('div', { class: 'plan-head' },
      h('h2', null, 'Einsatzplan'),
      plan.updated && !plan.public ? h('span', { class: 'muted small' }, `Stand ${new Date(plan.updated).toLocaleDateString('de-DE')}`) : '',
      h('span', { class: 'spacer' }),
      admin ? importButton() : '',
    ),
    planError ? h('p', { class: 'notice error' }, planError) : '',
    !plan.updated ? h('p', { class: 'muted' }, 'Noch kein Einsatzplan. Die Excel-Tabelle mit Datum, Musikteam, Teamleitung, Mischer und Beamer hier importieren.')
      : !upcoming.length ? h('p', { class: 'muted' }, 'Keine kommenden Termine im Einsatzplan.') : '',
    upcoming.length ? h('div', { class: 'plan-next' }, upcoming.slice(0, 2).map((e, i) => nextCard(e, i === 0))) : '',
    plan.public
      ? [rest.length ? planList(rest) : '', h('p', { class: 'muted small' }, 'Alle Termine und Namen nach der Anmeldung.')]
      : more ? [
        h('button', { class: 'btn btn-sm plan-toggle', type: 'button', 'aria-expanded': String(showAll), onclick: () => { showAll = !showAll; renderPlan(); } },
          showAll ? 'Weniger anzeigen' : `Alle Termine anzeigen (${more})`),
        showAll ? [
          rest.length ? planList(rest) : '',
          past.length ? h('details', { class: 'plan-past' }, h('summary', null, `Vergangene Termine (${past.length})`), planList(past, true)) : '',
        ] : '',
      ] : '',
  ].flat(2));
}

// ---- page ----

$('#logout').addEventListener('click', logout);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void loadPlan(); });
await loadPlan(); // visitors see the next dates without logging in
await ensureLogin('Anmelden', $<HTMLElement>('#login'));
// now all dates, and the import button for the admin (`plan` was set by loadPlan meanwhile)
if ((plan as PlanResponse | null)?.public !== false) await loadPlan(); else renderPlan();

$('#tiles').append(...(apps as AppEntry[]).map(a =>
  h('a', { class: 'tile', href: a.path },
    h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, a.icon),
    h('span', { class: 'tile-title' }, a.title),
    h('span', { class: 'tile-desc' }, a.description),
  ),
));
