// Admin: who mixes on a date – the dialog behind ✎ on the start page and in Termine. The server writes it into the
// Einsatzplan (in OpenCloud only that one cell, see server/plan-store.ts).
import { h, toast } from '../ui-kit/dom';
import type { PlanEntry, PlanResponse } from './plan';

const ERRORS: Record<number, string> = {
  404: 'Dieses Datum steht nicht (mehr) in der Tabelle.',
  409: 'Die Tabelle wurde gerade von jemand anderem geändert. Bitte noch einmal versuchen.',
  423: 'Die Tabelle ist gerade in OpenCloud zum Bearbeiten geöffnet. Bitte später noch einmal versuchen.',
  500: 'Die Tabelle kann nicht gelesen werden (beschädigt, oder die Zelle enthält eine Formel).',
  502: 'OpenCloud ist gerade nicht erreichbar, oder das App-Token ist abgelaufen.',
};

const CODE = /^[A-ZÄÖÜ]{1,6}$/;
const parseIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

/** Kürzel from the key below the plan and from earlier assignments, for the suggestions. */
export function knownMischer(plan: Pick<PlanResponse, 'names' | 'entries'>): string[] {
  const codes = new Set(Object.keys(plan.names));
  for (const e of plan.entries) for (const c of e.mischer.split(/[,/ ]+/)) if (CODE.test(c)) codes.add(c);
  return [...codes].sort();
}

/** "KL" → "Udo Klaus", also several ("AS, JD"); words that are no known Kürzel stay as they are. */
export const fullNames = (names: Record<string, string>, text: string) => text.replace(/\p{L}+/gu, w => names[w] ?? w);

/** The ✎ button that opens the dialog (only shown to the admin by the callers). */
export const assignButton = (e: PlanEntry, plan: () => PlanResponse | null, onSaved: () => void) =>
  h('button', {
    class: 'btn btn-ghost btn-sm edit-mischer', type: 'button', title: 'Mischer eintragen', 'aria-label': `Mischer am ${e.date} eintragen`,
    onclick: () => { const p = plan(); if (p) openAssignDialog(e, p, onSaved); },
  }, '✎');

export function openAssignDialog(e: PlanEntry, plan: PlanResponse, onSaved: () => void) {
  const known = knownMischer(plan);
  const list = h('datalist', { id: 'mischer-codes' }, known.map(c => h('option', { value: c }, plan.names[c] ?? '')));
  const open = /^\?*$/.test(e.mischer.trim());
  const input = h('input', { value: open ? '' : e.mischer, list: 'mischer-codes', maxlength: 60, autocomplete: 'off', placeholder: 'Kürzel, z. B. JD' });
  const hint = h('p', { class: 'muted small' });
  const warn = h('p', { class: 'field-warn' });
  const status = h('p', { class: 'login-error', role: 'alert' });
  const showHint = () => {
    const v = input.value.trim();
    hint.textContent = v ? fullNames(plan.names, v) : 'Leer lassen = niemand eingeteilt';
    // a typo would end up in the shared spreadsheet unnoticed: say so (saving stays possible, e.g. for a guest)
    const unknown = v.split(/[,/ ]+/).filter(c => c && CODE.test(c) && !known.includes(c));
    warn.textContent = unknown.length ? `${unknown.join(', ')} steht nicht in der Legende der Tabelle – Tippfehler?` : '';
  };
  input.addEventListener('input', showHint);
  showHint();
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Speichern');
  const dlg = h('dialog', { class: 'assign' },
    h('form', {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        save.disabled = true;
        status.textContent = '';
        try {
          let res: Response;
          try {
            res = await fetch('/api/plan/mischer', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: e.date, mischer: input.value.trim() }),
            });
          } catch { throw new Error('Server nicht erreichbar.'); }
          if (!res.ok) throw new Error(ERRORS[res.status] ?? `Speichern fehlgeschlagen (${res.status}).`);
          dlg.close();
          toast(plan.source === 'OpenCloud' ? 'In der Tabelle in OpenCloud eingetragen.' : 'Eingetragen.', 'ok');
          onSaved();
        } catch (err) {
          status.textContent = (err as Error).message;
        } finally {
          save.disabled = false;
        }
      },
    },
      h('div', { class: 'dlg-head' }, h('h2', null, 'Mischer eintragen')),
      h('div', { class: 'dlg-body' },
        h('p', null, parseIso(e.date).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
          e.team || e.lead ? h('span', { class: 'muted' }, ` · ${[e.team, e.lead].filter(Boolean).join(' · ')}`) : ''),
        h('label', null, 'Mischer', input), list, hint, warn, status,
        h('p', { class: 'muted small' }, plan.source === 'OpenCloud'
          ? 'Wird in die Tabelle Musik_Mischer_Beamer.xlsx in OpenCloud geschrieben – nur diese eine Zelle.'
          : 'Wird in die Tabelle auf dem NAS geschrieben.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'), save),
      ),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
}
