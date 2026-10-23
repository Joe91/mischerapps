// The Termine's data: the Einsatzplan from the server (OpenCloud), and the answers written into it.
import type { Answer } from './model';
import type { PlanResponse } from '../../../packages/plan/plan';

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(describeApiError(status, body));
  }
}

/** Plain-language messages for the status codes of the server. */
export function describeApiError(status: number, body: string): string {
  const b = body.trim();
  switch (status) {
    case 0: return 'Server nicht erreichbar. Bitte die Internetverbindung prüfen.';
    case 400:
      if (b === 'bad sign') return 'Ungültiges Kürzel (1–6 Buchstaben oder Ziffern).';
      if (b === 'unknown date') return 'Diesen Termin gibt es im Einsatzplan nicht (mehr). Die Liste wird neu geladen.';
      return `Der Server hat die Antwort abgelehnt (${b || 400}).`;
    case 401: return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und anmelden.';
    case 409: return 'Die Tabelle wurde gerade von jemand anderem geändert. Bitte die Antwort noch einmal geben.';
    case 423: return 'Die Tabelle ist gerade in OpenCloud zum Bearbeiten geöffnet – die Antwort konnte nicht eingetragen werden. Bitte später noch einmal.';
    case 500: return 'Die Tabelle kann nicht gelesen werden (beschädigt, oder die Spalten „Mischer möglich“ / „nicht möglich“ fehlen).';
    case 502: return 'OpenCloud ist gerade nicht erreichbar – die Antwort konnte nicht eingetragen werden.';
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

/** The Einsatzplan (OpenCloud): the dates with team, Mischer, Beamer, remarks and who can mix. */
export const fetchPlan = async (): Promise<PlanResponse> => (await request('/api/plan')).json();

/** Enters whether `sign` can mix on `date` (null: withdrawn) in the Einsatzplan. */
export async function sendAnswer(date: string, sign: string, answer: Answer | null): Promise<void> {
  await request('/api/termine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, sign, answer }) });
}
