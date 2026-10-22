// Storage of the Termine: one .xlsx file in a cloud folder (OpenCloud / Nextcloud public link, WebDAV).
// There is no server of our own, so there is no lock either: every change reads the file, applies the
// change and writes it back. Two safeguards against two people saving at the same moment:
//  1. If-Match (or If-None-Match: * for a new file): if somebody else wrote in between, the cloud answers 412
//     and the change is applied again to the newer file. Nextcloud does this; OpenCloud ignores the headers
//     (and does not expose the ETag to browsers by default).
//  2. After writing, the file is read back. If our change is missing, a slower writer overwrote it, so it is
//     applied again. A writer that overwrote someone else's change notices the same way on its own side.
// What remains is a window of a few hundred milliseconds in which both writes cross; fine for a small team.
import { applyOp, type Op, type TermineData } from './model';
import { readTermineXlsx, writeTermineXlsx, XLSX_MIME } from './xlsx';
import { authHeader, cloudFileUrl, parseShareLink } from '../../../packages/upload/cloud-upload';
import type { Settings } from './settings';

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(describeApiError(status, body));
  }
}

export interface Loaded { data: TermineData; /** rows of the file that were ignored (no valid date) */ skipped: number; }

const MAX_TRIES = 6;
/** random pause before the next try, so two people who collided do not collide again */
const backoff = (attempt: number) => new Promise(r => setTimeout(r, Math.random() * 150 * (attempt + 1)));

/** Plain-language messages for the status codes of the cloud's WebDAV interface. */
export function describeApiError(status: number, body: string): string {
  switch (status) {
    case 0: return 'Cloud nicht erreichbar, oder die Cloud erlaubt Zugriffe von dieser Seite nicht (CORS). Adresse prüfen; der Cloud-Admin muss die Adresse der App freigeben (siehe README, „Termine einrichten“).';
    case 401: return 'Die Cloud hat die Anfrage abgelehnt: Passwort falsch oder Link ungültig.';
    case 403: return 'Die Cloud hat die Anfrage abgelehnt: Der Freigabe-Link muss das Bearbeiten erlauben (nicht nur Hochladen).';
    case 404: return 'Freigabe-Link nicht gefunden – abgelaufen, gelöscht oder falsche Art (OpenCloud / Nextcloud)?';
    case 412: return 'Die Datei wurde gerade von jemand anderem geändert. Bitte noch einmal versuchen.';
    case 423: return 'Die Datei ist in der Cloud gerade gesperrt (z. B. weil jemand sie im Editor offen hat). Später erneut versuchen.';
    case 507: return 'Der Cloud-Ordner ist voll (Speicherplatz erschöpft).';
    case -1: return 'Die Datei in der Cloud ist keine gültige xlsx-Tabelle und wurde nicht verändert. Bitte in der Cloud prüfen.';
    default: return `Anfrage an die Cloud fehlgeschlagen (${status}${body ? `: ${body.slice(0, 200)}` : ''}).`;
  }
}

interface Snapshot extends Loaded {
  /** headers that make the next write fail if the file changed meanwhile */
  precondition: Record<string, string>;
}

function target(s: Settings) {
  let url: string;
  try { url = cloudFileUrl(s.kind, parseShareLink(s.shareUrl), s.file); } catch (e) { throw new Error((e as Error).message); }
  const auth = authHeader(s.kind, s.password);
  return { url, headers: auth ? { Authorization: auth } : {} as Record<string, string> };
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, '');
  }
}

async function read(s: Settings): Promise<Snapshot> {
  const { url, headers } = target(s);
  const res = await call(url, { headers });
  if (res.status === 404) {
    // Either the file does not exist yet (fine: it is created on the first change) or the link is wrong;
    // in the latter case the first write fails with the same 404.
    return { data: { dates: {} }, skipped: 0, precondition: { 'If-None-Match': '*' } };
  }
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  // Without a readable ETag (CORS does not expose it) the write cannot be protected against lost updates.
  const etag = res.headers.get('ETag');
  let parsed;
  try { parsed = await readTermineXlsx(await res.arrayBuffer()); } catch { throw new ApiError(-1, ''); }
  return { ...parsed, precondition: etag ? { 'If-Match': etag } : {} };
}

/** True if applying the change again would not alter the data, i.e. the change is in there. */
function holds(data: TermineData, op: Op): boolean {
  const copy: TermineData = structuredClone(data);
  applyOp(copy, op);
  return JSON.stringify(copy) === JSON.stringify(data);
}

export async function fetchData(s: Settings): Promise<Loaded> {
  const { data, skipped } = await read(s);
  return { data, skipped };
}

export async function sendOp(s: Settings, op: Op): Promise<Loaded> {
  const { url, headers } = target(s);
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (attempt) await backoff(attempt);
    const snap = await read(s);
    applyOp(snap.data, op);
    const res = await call(url, {
      method: 'PUT',
      headers: { ...headers, ...snap.precondition, 'Content-Type': XLSX_MIME },
      body: await writeTermineXlsx(snap.data),
    });
    // 412: somebody else was faster → apply the change to their version
    if (!res.ok && res.status !== 412) throw new ApiError(res.status, await res.text().catch(() => ''));
    if (res.ok) {
      const check = await read(s);
      if (holds(check.data, op)) return { data: check.data, skipped: check.skipped };
    }
  }
  throw new ApiError(412, '');
}
