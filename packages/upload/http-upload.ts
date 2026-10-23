export class UploadError extends Error {
  constructor(public status: number, public body: string) {
    super(describeUploadError(status, body));
  }
}

/** Plain-language messages for the status codes of the server's /api/upload. */
export function describeUploadError(status: number, body: string): string {
  const b = body.trim();
  switch (status) {
    case 0: return 'Server nicht erreichbar. Bitte die Internetverbindung prüfen.';
    case 400: return b === 'bad name'
      ? 'Der Server hat den Dateinamen abgelehnt (erlaubt: Buchstaben, Ziffern, . _ - und Endung .mp3).'
      : `Der Server hat die Datei nicht angenommen${b ? ` (${b.slice(0, 100)})` : ''}.`;
    case 401: return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und anmelden (die bearbeitete Datei geht dabei verloren – vorher herunterladen).';
    case 403: return 'Das darf nur der Admin.';
    case 404: return 'Die Datei gibt es auf dem Server nicht (mehr).';
    case 409: return 'Unter diesem Namen ist schon eine Predigt veröffentlicht. Ist es dieselbe, ist nichts mehr zu tun; ' +
      'sonst kann der Admin sie in „Predigt nachbearbeiten“ ersetzen.';
    case 413: return 'Der Server hat die Datei abgelehnt: Datei zu groß.';
    case 415: return 'Der Server hat die Datei abgelehnt: keine gültige MP3-Datei.';
    case 500: return `Fehler auf dem Server beim Speichern${b ? ` (${b})` : ''}.`;
    case 502: return describeCloudError(b);
    default: return `Upload fehlgeschlagen (${status}${b ? `: ${b.slice(0, 200)}` : ''}).`;
  }
}

/** The server passes on what OpenCloud answered (see server/sermon-store.ts). */
function describeCloudError(b: string): string {
  if (b === 'cloud 401') return 'OpenCloud hat die Anmeldung des Servers abgelehnt – das App-Token ist vermutlich abgelaufen. ' +
    'Bitte dem Admin Bescheid geben (neues Token in der config.json). Die Datei vorher herunterladen.';
  if (b === 'cloud 404') return 'Der Ordner in OpenCloud wurde nicht gefunden (gelöscht oder nicht mehr freigegeben?). Bitte dem Admin Bescheid geben.';
  if (b === 'cloud 403') return 'OpenCloud erlaubt dem Server das Schreiben in den Ordner nicht (Freigabe nur zum Lesen?). Bitte dem Admin Bescheid geben.';
  if (b === 'cloud 507') return 'Der Speicherplatz in OpenCloud ist voll.';
  if (b === 'cloud 423') return 'Die Datei ist in OpenCloud gerade gesperrt (dort zum Bearbeiten geöffnet?). Bitte später noch einmal versuchen.';
  if (b.startsWith('cloud unreachable')) return 'OpenCloud ist gerade nicht erreichbar. Bitte später noch einmal hochladen (die Datei vorher herunterladen).';
  return `OpenCloud hat die Datei nicht angenommen${b ? ` (${b})` : ''}.`;
}

/**
 * Progress of an upload; `stored`: the file has reached the server, which is now passing it on to OpenCloud
 * (the answer comes when it is stored there).
 */
export type UploadProgress = (p: number, stored?: boolean) => void;

/** Whether a sermon of this name is published already (null if the server cannot tell just now). */
export async function isPublished(name: string): Promise<boolean | null> {
  try {
    const res = await fetch(`/api/published?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
    return res.ok ? (await res.json()).exists : null;
  } catch {
    return null;
  }
}

/** Publishes the file under `name` via the server; the login cookie is sent automatically. */
export const uploadFile = (file: Blob, name: string, onProgress: UploadProgress) =>
  send('POST', `/api/upload?name=${encodeURIComponent(name)}`, file, onProgress);

/** Admin: replaces the published file `name` (the server keeps the first version, see server/api.ts). */
export const replaceUpload = (name: string, file: Blob, onProgress: UploadProgress) =>
  send('PUT', `/api/uploads/${encodeURIComponent(name)}`, file, onProgress);

/** Asks every 2 s how a job of the server is doing (see server/api.ts, finish); short network gaps are no failure. */
async function waitForJob(id: string): Promise<void> {
  for (let failures = 0; ;) {
    await new Promise(r => setTimeout(r, 2000));
    let res: Response;
    try { res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' }); } catch {
      if (++failures > 30) throw new UploadError(0, '');
      continue;
    }
    if (res.status === 404) {
      throw new Error('Der Server kennt diesen Upload nicht mehr (neu gestartet?). Bitte in der Liste nachsehen, ob die Datei angekommen ist, sonst noch einmal hochladen.');
    }
    if (!res.ok) {
      if (++failures > 30) throw new UploadError(res.status, await res.text().catch(() => ''));
      continue;
    }
    const job = await res.json() as { state: string; status: number | null; error: string | null };
    if (job.state === 'done') return;
    if (job.state === 'failed') throw new UploadError(job.status ?? 500, job.error ?? '');
    failures = 0;
  }
}

function send(method: 'POST' | 'PUT', url: string, file: Blob,
  onProgress: UploadProgress): { promise: Promise<string>; abort: () => void } {
  const xhr = new XMLHttpRequest(); // XHR, because fetch has no upload progress
  const promise = new Promise<string>((resolve, reject) => {
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', 'audio/mpeg');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.upload.onload = () => onProgress(1, true);
    xhr.onload = () => {
      // 202: the server is still passing the file on to OpenCloud; ask until it is done
      if (xhr.status === 202) { waitForJob(JSON.parse(xhr.responseText).job).then(() => resolve(xhr.responseText), reject); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new UploadError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => reject(new UploadError(0, ''));
    xhr.onabort = () => reject(new Error('Upload abgebrochen.'));
    xhr.send(file); // the bare file: the server writes it to disk as it arrives
  });
  return { promise, abort: () => xhr.abort() };
}
