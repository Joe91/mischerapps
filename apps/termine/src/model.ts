// Data model of the Termine app, shared by the browser and the tests.

export type Answer = 'yes' | 'maybe' | 'no';
export const ANSWERS: Answer[] = ['yes', 'maybe', 'no'];

export interface DateEntry {
  title: string;
  time: string;
  /** who is assigned (Kürzel or names, free text) */
  assigned: string;
  note: string;
  /** Kürzel → answer */
  votes: Record<string, Answer>;
}

export interface TermineData { dates: Record<string, DateEntry>; }

/** The list of dates is chosen by the admin: a date exists once it has a row, even without any details or answers. */
export type Op =
  | { action: 'add'; date: string }
  | { action: 'vote'; date: string; sign: string; answer: Answer | null }
  | { action: 'update'; date: string; title: string; time: string; assigned: string; note: string }
  | { action: 'delete'; date: string };

export const LIMITS = { title: 100, time: 20, assigned: 60, note: 1000 } as const;

export const emptyEntry = (): DateEntry => ({ title: '', time: '', assigned: '', note: '', votes: {} });

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

/** Kürzel: 1–6 letters/digits, upper case ("jd" → "JD"). Returns '' if invalid. */
export function normalizeSign(s: string): string {
  const v = s.trim().toUpperCase();
  return /^[\p{L}\p{N}]{1,6}$/u.test(v) ? v : '';
}

/** `count` Sundays starting with the first Sunday on or after `from`. */
export function sundays(from: Date, count: number): string[] {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return Array.from({ length: count }, (_, i) => isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i * 7)));
}

export class OpError extends Error {}

/** Applies one change in place. Throws OpError for invalid input (→ HTTP 400). */
export function applyOp(data: TermineData, op: Op): TermineData {
  if (!op || typeof op !== 'object' || !isValidDate(String(op.date))) throw new OpError('bad date');
  if (op.action === 'delete') {
    delete data.dates[op.date];
    return data;
  }
  if (op.action === 'add') {
    data.dates[op.date] ??= emptyEntry();
    return data;
  }
  if (op.action === 'vote') {
    // only dates the admin has put on the list can be answered (a page that is out of date must not bring a deleted date back)
    const entry = data.dates[op.date];
    if (!entry) throw new OpError('unknown date');
    const sign = normalizeSign(String(op.sign ?? ''));
    if (!sign) throw new OpError('bad sign');
    if (op.answer === null) delete entry.votes[sign];
    else if (ANSWERS.includes(op.answer)) entry.votes[sign] = op.answer;
    else throw new OpError('bad answer');
  } else if (op.action === 'update') {
    const entry = data.dates[op.date] ??= emptyEntry();
    for (const k of ['title', 'time', 'assigned', 'note'] as const) {
      entry[k] = String(op[k] ?? '').trim().slice(0, LIMITS[k]);
    }
  } else {
    throw new OpError('bad action');
  }
  return data;
}
