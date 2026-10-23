// The answers of the Termine app: who can mix on a date. They live in the Einsatzplan in OpenCloud – a Kürzel in
// "Mischer möglich" (with "?" for maybe) or "nicht möglich", see packages/plan/plan.ts.

export type Answer = 'yes' | 'maybe' | 'no';
export const ANSWERS: Answer[] = ['yes', 'maybe', 'no'];

/** Kürzel: 1–6 letters/digits, upper case ("jd" → "JD"). Returns '' if invalid. */
export function normalizeSign(s: string): string {
  const v = s.trim().toUpperCase();
  return /^[\p{L}\p{N}]{1,6}$/u.test(v) ? v : '';
}
