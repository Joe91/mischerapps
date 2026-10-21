import type { Op, TermineData } from './model';
import type { Settings } from './settings';

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(describeApiError(status, body));
  }
}

/** Plain-language messages for the status codes of server/termine.php. */
export function describeApiError(status: number, body: string): string {
  const b = body.trim();
  switch (status) {
    case 0: return 'Server nicht erreichbar oder Anfrage durch CORS blockiert. URL und ALLOWED_ORIGINS im Server-Skript prüfen.';
    case 400: return b === 'bad sign' ? 'Ungültiges Kürzel (1–6 Buchstaben oder Ziffern).' : `Der Server hat die Änderung abgelehnt (${b || 400}).`;
    case 401: return 'Der Server hat die Anfrage abgelehnt: Token falsch.';
    case 404: return 'Termine-Skript nicht gefunden (404). URL in den Einstellungen prüfen.';
    case 500: return `Fehler auf dem Server${b ? ` (${b})` : ''}.`;
    default: return `Anfrage fehlgeschlagen (${status}${b ? `: ${b.slice(0, 200)}` : ''}).`;
  }
}

async function request(s: Settings, init: RequestInit = {}): Promise<TermineData> {
  let res: Response;
  try {
    res = await fetch(s.url, { cache: 'no-store', ...init, headers: { 'X-Termine-Token': s.token, ...init.headers } });
  } catch {
    throw new ApiError(0, '');
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text);
  const data = JSON.parse(text) as TermineData;
  return { dates: data?.dates ?? {} };
}

export const fetchData = (s: Settings) => request(s);

export const sendOp = (s: Settings, op: Op) =>
  request(s, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
