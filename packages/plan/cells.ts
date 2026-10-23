// Reading spreadsheet cells the way people type them: dates as date cells, Excel day numbers, "25.10.2026" or
// "2026-10-25"; text trimmed. Shared by the Einsatzplan, the eAg-Übersicht and the server.

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Real calendar day between 2000 and 2100 (also the range the spreadsheet round-trips safely). */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** ISO date from a date cell, an Excel serial number, "25.10.2026" or "2026-10-25"; null if it is none of those. */
export function toIsoDate(v: unknown): string | null {
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

export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return toIsoDate(v) ?? '';
  return String(v).trim();
}
