// The Einsatzplan: who mixes, who runs the beamer and which music team plays, from the church's own spreadsheet
// (e.g. Musik_Mischer_Beamer.xlsx). Only its first sheet is read:
//
//   Datum | Besonderheiten | Musikteam | Teamleitung | Mischer | Mischer möglich | … | Beamer | … | Bemerkungen
//
// Columns are found by their header, so their order and any further columns do not matter. Rows with "kein eAg"
// (no service) are left out. Rows without a date may hold a key "KL | Udo Klaus": a Kürzel and the full name next to it.
import { readSheet } from 'read-excel-file/universal';
import { toIsoDate, toText } from '../../apps/termine/src/xlsx';

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
}

export class PlanFormatError extends Error {}

const COLUMNS = {
  date: 'datum', team: 'musikteam', lead: 'teamleitung', mischer: 'mischer', beamer: 'beamer',
  special: 'besonderheiten', note: 'bemerkungen',
} as const;
const MAX_TEXT = 200;
const NO_SERVICE = /kein\s*eag/i;
const KUERZEL = /^[A-ZÄÖÜ]{1,6}$/;

/** Throws PlanFormatError if the first sheet has no header row with "Datum" and "Mischer", or if it is no xlsx file. */
export async function readPlanXlsx(file: Blob | ArrayBuffer): Promise<Plan & { hidden: number }> {
  let rows: unknown[][];
  try { rows = await readSheet(file); } catch { throw new PlanFormatError('not an xlsx file'); }
  const norm = (v: unknown) => toText(v).toLowerCase();
  const headerAt = rows.slice(0, 20).findIndex(r => r.some(c => norm(c) === COLUMNS.date) && r.some(c => norm(c) === COLUMNS.mischer));
  if (headerAt < 0) throw new PlanFormatError('no header with "Datum" and "Mischer"');
  const header = rows[headerAt].map(norm);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, title]) => [k, header.indexOf(title)])) as Record<keyof typeof COLUMNS, number>;

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
      special: cell(col.special), note: cell(col.note),
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
  entries: plan.entries.filter(e => e.date >= today).slice(0, count).map(e => ({ ...e, note: '' })),
  names: {},
});
