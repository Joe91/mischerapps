// The Einsatzplan: who mixes, who runs the beamer and which music team plays, from the church's own spreadsheet
// (e.g. Musik_Mischer_Beamer.xlsx), one sheet per year ("Musik+Mischer+Beamer 2027", "… 2026", …):
//
//   Datum | Besonderheiten | Musikteam | Teamleitung | Mischer | Mischer möglich | … | Beamer | … | Bemerkungen
//
// Columns are found by their header, so their order and any further columns do not matter. Rows with "kein eAg"
// (no service) are left out. Rows without a date may hold a key "KL | Udo Klaus": a Kürzel and the full name next to it.
//
// Who can mix (the answers of the Termine app): Kürzel in "Mischer möglich" ("JD", "JD?" = maybe) and in the
// "nicht möglich" column right after it (the second "nicht möglich" belongs to the Beamer). Only Kürzel in capitals
// count, so other text in these cells stays what it is.
import { toText } from './cells';

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

/** A sheet's cells: row number (1-based) → column index (0 = A) → value. */
export type SheetRows = Map<number, Map<number, unknown>>;

export interface PlanSheet {
  name: string;
  rows: SheetRows;
}

/** A row of the plan: where it is and its date. */
export interface PlanRow {
  sheet: number;
  row: number;
  date: string;
  col: ReturnType<typeof planColumns>;
}

/** how many of the newest year sheets are read: this year's and the last (or the next) one */
const YEAR_SHEETS = 2;
const YEAR_IN_NAME = /(?<!\d)(\d{4})(?!\d)/;

/** The header row (with "Datum" and "Mischer", within the first 20 rows) and the columns, or null. */
function headerOf(rows: SheetRows) {
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  const norm = (v: unknown) => toText(v).toLowerCase();
  const row = numbers.slice(0, 20).find(r => {
    const titles = [...rows.get(r)!.values()].map(norm);
    return titles.includes(COLUMNS.date) && titles.includes(COLUMNS.mischer);
  });
  if (row === undefined) return null;
  const titles: string[] = [];
  for (const [c, v] of rows.get(row)!) titles[c] = norm(v);
  return { row, numbers, col: planColumns(Array.from(titles, t => t ?? '')) };
}

/**
 * Where the plan is. Sheets named by year: the newest two with a plan header, newest first, and a date only from
 * the sheet of its year where there is one (a new year's sheet may still hold rows of the old year). Otherwise the
 * first sheet with a plan header. Each date once. `dates` are the rows with a date, `other` those without (the key).
 * `toDate` reads a date cell. Throws PlanFormatError if no sheet has a header with "Datum" and "Mischer".
 */
export function locatePlan(sheets: PlanSheet[], toDate: (v: unknown) => string | null) {
  const found = sheets.map((s, i) => ({ i, year: YEAR_IN_NAME.exec(s.name)?.[1], header: headerOf(s.rows) }))
    .filter(s => s.header);
  if (!found.length) throw new PlanFormatError('no header with "Datum" and "Mischer"');
  const byYear = found.filter(s => s.year).sort((a, b) => Number(b.year) - Number(a.year));
  const used = byYear.length ? byYear.slice(0, YEAR_SHEETS) : found.slice(0, 1);
  const years = new Set(used.map(s => s.year));
  const dates: PlanRow[] = [], other: { sheet: number; row: number }[] = [];
  const seen = new Set<string>();
  for (const { i, year, header } of used) {
    const { row: headerRow, numbers, col } = header!;
    for (const row of numbers.filter(r => r > headerRow)) {
      const date = toDate(sheets[i].rows.get(row)!.get(col.date));
      if (!date) { other.push({ sheet: i, row }); continue; }
      if (seen.has(date) || (year && date.slice(0, 4) !== year && years.has(date.slice(0, 4)))) continue;
      seen.add(date);
      dates.push({ sheet: i, row, date, col });
    }
  }
  return { dates, other };
}

/** The plan in the sheets (see locatePlan); `hidden`: dates without service. Throws PlanFormatError. */
export function readPlan(sheets: PlanSheet[], toDate: (v: unknown) => string | null): Plan & { hidden: number } {
  const { dates, other } = locatePlan(sheets, toDate);
  const entries: PlanEntry[] = [];
  const names: Record<string, string> = {};
  let hidden = 0;
  // the key: a Kürzel and the full name next to it; the newest sheet's wins
  for (const { sheet, row } of other) {
    const cells = sheets[sheet].rows.get(row)!;
    for (const [c, v] of cells) {
      const code = toText(v), name = toText(cells.get(c + 1));
      if (KUERZEL.test(code) && /\p{L}\s+\p{L}/u.test(name) && !(code in names)) names[code] = name.slice(0, MAX_TEXT);
    }
  }
  for (const { sheet, row, date, col } of dates) {
    const cells = sheets[sheet].rows.get(row)!;
    const cell = (c: number) => (c < 0 ? '' : toText(cells.get(c)).slice(0, MAX_TEXT));
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
