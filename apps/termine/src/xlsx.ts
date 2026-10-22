// The Termine data as a human-readable spreadsheet (this file lives in the cloud folder, see api.ts).
//
//   Datum | Wochentag | Uhrzeit | Anlass | Eingeteilt | Hinweis | JD | MK | …
//
// One row per date, one column per Kürzel (from column G on) holding Ja / Vielleicht / Nein.
// "Wochentag" is only there for the eye and is ignored when reading, so people can edit the file in
// Excel / the cloud's office editor. Dates are written as real date cells (UTC midnight, so the
// calendar day is the same in every time zone) and read back as dates, "25.10.2026" or "2026-10-25".
import writeExcelFile from 'write-excel-file/universal';
import { readSheet } from 'read-excel-file/universal';
import { LIMITS, emptyEntry, isBlank, isValidDate, normalizeSign, type Answer, type TermineData } from './model';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const FIXED = ['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis'] as const;
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const ANSWER_TEXT: Record<Answer, string> = { yes: 'Ja', maybe: 'Vielleicht', no: 'Nein' };
const ANSWER_FILL: Record<Answer, string> = { yes: '#c6efce', maybe: '#ffeb9c', no: '#ffc7ce' };

const utcDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

export async function writeTermineXlsx(data: TermineData): Promise<Blob> {
  const dates = Object.keys(data.dates).sort();
  const signs = [...new Set(dates.flatMap(d => Object.keys(data.dates[d].votes)))].sort();
  const head = { fontWeight: 'bold' as const, backgroundColor: '#d9d9d9', align: 'center' as const };

  const rows: unknown[][] = [[...FIXED, ...signs].map(value => ({ value, ...head }))];
  for (const date of dates) {
    const e = data.dates[date];
    const text = (value: string, wrap = false) => (value ? { value, format: '@', wrap, alignVertical: 'top' as const } : null);
    rows.push([
      { value: utcDate(date), format: 'dd.mm.yyyy', align: 'left', alignVertical: 'top' },
      { value: WEEKDAYS[utcDate(date).getUTCDay()], textColor: '#7f7f7f', alignVertical: 'top' },
      text(e.time),
      text(e.title),
      text(e.assigned),
      text(e.note, true),
      ...signs.map(s => {
        const a = e.votes[s];
        return a ? { value: ANSWER_TEXT[a], backgroundColor: ANSWER_FILL[a], align: 'center', alignVertical: 'top' } : null;
      }),
    ]);
  }
  return writeExcelFile(rows as never, {
    sheet: 'Termine',
    columns: [{ width: 12 }, { width: 12 }, { width: 9 }, { width: 24 }, { width: 18 }, { width: 40 }, ...signs.map(() => ({ width: 11 }))],
    stickyRowsCount: 1,
    stickyColumnsCount: 1,
  }).toBlob();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO date from a date cell, an Excel serial number, "25.10.2026" or "2026-10-25"; null if it is none of those. */
function toIsoDate(v: unknown): string | null {
  let iso: string | null = null;
  if (v instanceof Date) iso = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  else if (typeof v === 'number') return toIsoDate(new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000));
  else if (typeof v === 'string') {
    const s = v.trim();
    const de = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4}|\d{2})$/.exec(s);
    if (de) iso = `${de[3].length === 2 ? '20' + de[3] : de[3]}-${pad(+de[2])}-${pad(+de[1])}`;
    else if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) { const [y, m, d] = s.slice(0, 10).split('-'); iso = `${y}-${pad(+m)}-${pad(+d.replace(/\D.*/, ''))}`; }
  }
  return iso && isValidDate(iso) ? iso : null;
}

/** "10:00" from text, a time-of-day fraction (0.4166…) or a time cell. */
function toTime(v: unknown): string {
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const min = Math.round(v * 1440);
    return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
  }
  return toText(v);
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return toIsoDate(v) ?? '';
  return String(v).trim();
}

function toAnswer(v: unknown): Answer | null {
  switch (toText(v).toLowerCase()) {
    case 'ja': case 'j': case 'yes': case 'y': case '✓': return 'yes';
    case 'vielleicht': case 'v': case 'maybe': case '?': return 'maybe';
    case 'nein': case 'n': case 'no': case '✗': return 'no';
    default: return null;
  }
}

export interface ParsedTermine { data: TermineData; /** rows with content but without a usable date */ skipped: number; }

/** An empty or missing first sheet gives no dates. Throws if the input is not an xlsx file. */
export async function readTermineXlsx(file: Blob | ArrayBuffer): Promise<ParsedTermine> {
  const rows = await readSheet(file);
  const data: TermineData = { dates: {} };
  let skipped = 0;
  const header = rows[0] ?? [];
  const signAt = new Map<number, string>();
  for (let c = FIXED.length; c < header.length; c++) {
    const sign = normalizeSign(toText(header[c]));
    if (sign) signAt.set(c, sign);
  }

  for (const row of rows.slice(1)) {
    if (row.every(cell => toText(cell) === '')) continue;
    const date = toIsoDate(row[0]);
    if (!date) { skipped++; continue; }
    const entry = data.dates[date] ?? emptyEntry();
    entry.time = toTime(row[2]).slice(0, LIMITS.time);
    entry.title = toText(row[3]).slice(0, LIMITS.title);
    entry.assigned = toText(row[4]).slice(0, LIMITS.assigned);
    entry.note = toText(row[5]).slice(0, LIMITS.note);
    for (const [c, sign] of signAt) {
      const a = toAnswer(row[c]);
      if (a) entry.votes[sign] = a;
    }
    if (!isBlank(entry)) data.dates[date] = entry;
  }
  return { data, skipped };
}
