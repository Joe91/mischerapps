// Data model of the Termine app, shared by the browser, the dev server (dev-server.ts) and the tests.
// server/termine.php implements the same rules in PHP – keep both in sync.

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

export type Op =
  | { action: 'vote'; date: string; sign: string; answer: Answer | null }
  | { action: 'update'; date: string; title: string; time: string; assigned: string; note: string };

export const LIMITS = { title: 100, time: 20, assigned: 60, note: 1000 } as const;

export const emptyEntry = (): DateEntry => ({ title: '', time: '', assigned: '', note: '', votes: {} });

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Kürzel: 1–6 letters/digits, upper case ("jd" → "JD"). Returns '' if invalid. */
export function normalizeSign(s: string): string {
  const v = s.trim().toUpperCase();
  return /^[\p{L}\p{N}]{1,6}$/u.test(v) ? v : '';
}

/** `count` Sundays starting with the first Sunday on or after `from` (or before it, for negative offsets). */
export function sundays(from: Date, count: number, offsetWeeks = 0): string[] {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + offsetWeeks * 7);
  return Array.from({ length: count }, (_, i) => isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i * 7)));
}

const isBlank = (e: DateEntry) => !e.title && !e.time && !e.assigned && !e.note && !Object.keys(e.votes).length;

export class OpError extends Error {}

/** Applies one change in place. Throws OpError for invalid input (→ HTTP 400). */
export function applyOp(data: TermineData, op: Op): TermineData {
  if (!op || typeof op !== 'object' || !isValidDate(String(op.date))) throw new OpError('bad date');
  const entry = data.dates[op.date] ?? emptyEntry();
  if (op.action === 'vote') {
    const sign = normalizeSign(String(op.sign ?? ''));
    if (!sign) throw new OpError('bad sign');
    if (op.answer === null) delete entry.votes[sign];
    else if (ANSWERS.includes(op.answer)) entry.votes[sign] = op.answer;
    else throw new OpError('bad answer');
  } else if (op.action === 'update') {
    for (const k of ['title', 'time', 'assigned', 'note'] as const) {
      entry[k] = String(op[k] ?? '').trim().slice(0, LIMITS[k]);
    }
  } else {
    throw new OpError('bad action');
  }
  if (isBlank(entry)) delete data.dates[op.date];
  else data.dates[op.date] = entry;
  return data;
}
