// Storage of the Termine: the server (server/api.ts) keeps them in a spreadsheet on the NAS.
import type { Op, TermineData } from './model';
import type { PlanResponse } from '../../../packages/plan/plan';

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(describeApiError(status, body));
  }
}

export interface Loaded { data: TermineData; /** rows of the spreadsheet that were ignored (no valid date) */ skipped: number; }

/** Plain-language messages for the status codes of the server. */
export function describeApiError(status: number, body: string): string {
  const b = body.trim();
  switch (status) {
    case 0: return 'Server nicht erreichbar. Bitte die Internetverbindung prüfen.';
    case 400:
      if (b === 'bad sign') return 'Ungültiges Kürzel (1–6 Buchstaben oder Ziffern).';
      if (b === 'unknown date') return 'Diesen Termin gibt es nicht mehr. Die Liste wird neu geladen.';
      return `Der Server hat die Änderung abgelehnt (${b || 400}).`;
    case 401: return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und anmelden.';
    case 403: return 'Das darf nur der Admin.';
    case 413: return 'Die Datei ist zu groß.';
    case 500: return 'Fehler auf dem Server (ist die Datei termine.xlsx kaputt?).';
    default: return `Anfrage fehlgeschlagen (${status}${b ? `: ${b.slice(0, 200)}` : ''}).`;
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, '');
  }
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  return res;
}

async function loaded(res: Response): Promise<Loaded> {
  const body = await res.json() as { dates?: TermineData['dates']; skipped?: number };
  return { data: { dates: body.dates ?? {} }, skipped: body.skipped ?? 0 };
}

export const fetchData = async (): Promise<Loaded> => loaded(await request('/api/termine'));

export const sendOp = async (op: Op): Promise<Loaded> =>
  loaded(await request('/api/termine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }));

/** Admin: the current spreadsheet. */
export const exportXlsx = async (): Promise<Blob> => (await request('/api/termine/export')).blob();

/** Admin: the current spreadsheet plus the coming Sundays, to delete the rows that are not needed. */
export const templateXlsx = async (): Promise<Blob> => (await request('/api/termine/template')).blob();

/** Admin: replaces all dates with the content of a spreadsheet. */
export async function importXlsx(file: Blob): Promise<{ dates: number; skipped: number }> {
  try {
    return await (await request('/api/termine/import', { method: 'POST', body: file })).json();
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) throw new Error('Das ist keine gültige Excel-Datei (.xlsx).');
    throw e;
  }
}

/**
 * Date → Mischer from the Einsatzplan the admin imported on the home page (see packages/plan/plan.ts).
 * Dates without a Mischer ("", "??") are left out.
 */
export async function fetchPlanMischer(): Promise<Record<string, string>> {
  const { entries } = await (await request('/api/plan')).json() as PlanResponse;
  return Object.fromEntries(entries.filter(e => !/^\?*$/.test(e.mischer.trim())).map(e => [e.date, e.mischer]));
}
