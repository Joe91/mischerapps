// The Einsatzplan: who mixes, who runs the beamer and which music team plays, from the church's own spreadsheet
// (e.g. Musik_Mischer_Beamer.xlsx). Only its first sheet is read:
//
//   Datum | Besonderheiten | Musikteam | Teamleitung | Mischer | Mischer möglich | … | Beamer | … | Bemerkungen
//
// Columns are found by their header, so their order and any further columns do not matter. Rows with "kein eAg"
// (no service) are left out. Rows without a date may hold a key "KL | Udo Klaus": a Kürzel and the full name next to it.
//
// Who can mix (the answers of the Termine app): Kürzel in "Mischer möglich" ("JD", "JD?" = maybe) and in the
// "nicht möglich" column right after it (the second "nicht möglich" belongs to the Beamer). Only Kürzel in capitals
// count, so other text in these cells stays what it is.
import { readSheet } from 'read-excel-file/universal';
import { toIsoDate, toText } from './cells';

export type Availability = 'yes' | 'maybe' | 'no';

export interface PlanEntry {
  date: string;
  team: string;
  lead: string;
  mischer: string;
  beamer: string;
  /** "Besonderheiten" */
  special: string;
  /** "Bemerkungen" (only for logged-in users) */
  note: string;
  /** who can mix: Kürzel → answer (only for logged-in users) */
  votes: Record<string, Availability>;
}

export interface Plan {
  entries: PlanEntry[];
  /** Kürzel → full name, from the key below the dates (only for logged-in users) */
  names: Record<string, string>;
}

/** What GET /api/plan returns. */
export interface PlanResponse extends Plan {
  /** last import (ISO time), null if there is no plan yet */
  updated: string | null;
  /** not logged in: only the next few dates, without names and remarks */
  public: boolean;
  /** "OpenCloud": read from (and Mischer written to) the spreadsheet there; "NAS": imported by the admin */
  source: 'OpenCloud' | 'NAS';
  /** logged in only: why OpenCloud could not be read just now (the last copy is shown) */
  syncError: string | null;
}

export class PlanFormatError extends Error {}

const COLUMNS = {
  date: 'datum', team: 'musikteam', lead: 'teamleitung', mischer: 'mischer', beamer: 'beamer',
  special: 'besonderheiten', note: 'bemerkungen',
} as const;
const MAX_TEXT = 200;
const NO_SERVICE = /kein\s*eag/i;
const KUERZEL = /^[A-ZÄÖÜ]{1,6}$/;
/** an answer in a cell: a Kürzel in capitals, "?" for maybe */
const ANSWER = /(?<![\p{L}\p{N}])([A-ZÄÖÜ][A-ZÄÖÜ0-9]{0,5})(\?)?(?![\p{L}\p{N}?])/gu;
const SEPARATORS = /\s*[,;]\s*(?:[,;]\s*)*/g;

/** The answers in the two cells: "möglich" (JD = yes, JD? = maybe) and "nicht möglich" (no; it wins). */
export function readAvailability(possible: string, notPossible: string): Record<string, Availability> {
  const votes: Record<string, Availability> = {};
  for (const m of possible.matchAll(ANSWER)) votes[m[1]] = m[2] ? 'maybe' : 'yes';
  for (const m of notPossible.matchAll(ANSWER)) votes[m[1]] = 'no';
  return votes;
}

/** `text` without the Kürzel `sign` (also "JD?"); everything else stays, separators are tidied up. */
export function withoutSign(text: string, sign: string): string {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${sign.replace(/[^\p{L}\p{N}]/gu, '')}\\??(?![\\p{L}\\p{N}?])`, 'gu');
  if (!re.test(text)) return text;
  return text.replace(re, '').replace(SEPARATORS, ', ').replace(/ {2,}/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '');
}

/** `text` with `token` ("JD" or "JD?") added at the end, comma-separated. */
export const withSign = (text: string, token: string) => (text.trim() ? `${text.trim()}, ${token}` : token);

/** The two cells after `sign` answered `answer` (null: withdrawn). */
export function answerCells(possible: string, notPossible: string, sign: string, answer: Availability | null) {
  let p = withoutSign(possible, sign), n = withoutSign(notPossible, sign);
  if (answer === 'yes') p = withSign(p, sign);
  if (answer === 'maybe') p = withSign(p, `${sign}?`);
  if (answer === 'no') n = withSign(n, sign);
  return { possible: p, notPossible: n };
}

/** Columns of the header row: by title; "nicht möglich" is the one right after "Mischer möglich". */
export function planColumns(header: string[]) {
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, title]) => [k, header.indexOf(title)])) as Record<keyof typeof COLUMNS, number>;
  const possible = header.indexOf('mischer möglich');
  const notPossible = possible >= 0 ? header.indexOf('nicht möglich', possible + 1) : -1;
  return { ...col, possible, notPossible };
}

/** Throws PlanFormatError if the first sheet has no header row with "Datum" and "Mischer", or if it is no xlsx file. */
export async function readPlanXlsx(file: Blob | ArrayBuffer): Promise<Plan & { hidden: number }> {
  let rows: unknown[][];
  try { rows = await readSheet(file); } catch { throw new PlanFormatError('not an xlsx file'); }
  const norm = (v: unknown) => toText(v).toLowerCase();
  const headerAt = rows.slice(0, 20).findIndex(r => r.some(c => norm(c) === COLUMNS.date) && r.some(c => norm(c) === COLUMNS.mischer));
  if (headerAt < 0) throw new PlanFormatError('no header with "Datum" and "Mischer"');
  const col = planColumns(rows[headerAt].map(norm));

  const entries: PlanEntry[] = [];
  const names: Record<string, string> = {};
  let hidden = 0;
  for (const row of rows.slice(headerAt + 1)) {
    const date = toIsoDate(row[col.date]);
    if (!date) {
      for (let c = 0; c + 1 < row.length; c++) {
        const code = toText(row[c]), name = toText(row[c + 1]);
        if (KUERZEL.test(code) && /\p{L}\s+\p{L}/u.test(name)) names[code] = name.slice(0, MAX_TEXT);
      }
      continue;
    }
    const cell = (c: number) => (c < 0 ? '' : toText(row[c]).slice(0, MAX_TEXT));
    const entry: PlanEntry = {
      date, team: cell(col.team), lead: cell(col.lead), mischer: cell(col.mischer), beamer: cell(col.beamer),
      special: cell(col.special), note: cell(col.note), votes: readAvailability(cell(col.possible), cell(col.notPossible)),
    };
    // a remark like "nächste Woche kein eAg" must not hide this date
    if ([entry.team, entry.lead, entry.mischer, entry.beamer, entry.special].some(t => NO_SERVICE.test(t))) { hidden++; continue; }
    entries.push(entry);
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return { entries, names, hidden };
}

/** The view for visitors who are not logged in: the next `count` dates from `today` on, without names and remarks. */
export const publicPlan = (plan: Plan, today: string, count = 3): Plan => ({
  entries: plan.entries.filter(e => e.date >= today).slice(0, count).map(e => ({ ...e, note: '', votes: {} })),
  names: {},
});
