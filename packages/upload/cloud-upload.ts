// Upload into a cloud folder shared as a public link with upload permission
// (OpenCloud / ownCloud Infinite Scale, Nextcloud ≥ 29), via WebDAV PUT.
//
// Endpoints (tested against OpenCloud 8.1 and Nextcloud 35):
//   OpenCloud:  PUT {base}/dav/public-files/{token}/{name}     Basic "public:<password>"
//   Nextcloud:  PUT {base}/public.php/dav/files/{token}/{name} Basic "anonymous:<password>"
// Both overwrite existing files on normal (edit) links, so a HEAD request checks first.
// The cloud must allow this app's origin via CORS (see README).
import { UploadError } from './http-upload';

export type CloudKind = 'opencloud' | 'nextcloud';

export interface ShareLink { base: string; token: string; }

/** Parses https://host[/sub][/index.php]/s/<token>[/…] */
export function parseShareLink(url: string): ShareLink {
  let u: URL;
  try { u = new URL(url.trim()); } catch { throw new Error('Der Freigabe-Link ist keine gültige Adresse.'); }
  const m = /^(.*?)(?:\/index\.php)?\/s\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (!m) throw new Error('Der Freigabe-Link muss die Form https://cloud.example.org/s/AbC123 haben.');
  return { base: u.origin + m[1], token: m[2] };
}

export function cloudFileUrl(kind: CloudKind, link: ShareLink, name: string): string {
  const file = encodeURIComponent(name);
  return kind === 'opencloud'
    ? `${link.base}/dav/public-files/${link.token}/${file}`
    : `${link.base}/public.php/dav/files/${link.token}/${file}`;
}

function authHeader(kind: CloudKind, password: string): string | null {
  if (!password) return null;
  const user = kind === 'opencloud' ? 'public' : 'anonymous';
  return 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${password}`)));
}

export function describeCloudError(status: number): string {
  switch (status) {
    case 0: return 'Cloud nicht erreichbar, oder die Cloud erlaubt Uploads von dieser Seite nicht (CORS). ' +
      'Der Cloud-Admin muss die Adresse dieser App freigeben (siehe README, „Cloud-Ordner“).';
    case 401: return 'Die Cloud hat den Upload abgelehnt: Passwort falsch oder Link ungültig.';
    case 403: return 'Die Cloud hat den Upload abgelehnt: Der Link erlaubt kein Hochladen.';
    case 404: return 'Freigabe-Link nicht gefunden – abgelaufen oder gelöscht?';
    case 409: return 'Die Datei existiert im Cloud-Ordner bereits. Bitte Dateinamen ändern.';
    case 413: return 'Die Cloud hat die Datei abgelehnt: zu groß.';
    case 423: return 'Die Datei ist in der Cloud gerade gesperrt. Später erneut versuchen.';
    case 507: return 'Der Cloud-Ordner ist voll (Speicherplatz erschöpft).';
    default: return `Upload in die Cloud fehlgeschlagen (${status}).`;
  }
}

class CloudError extends UploadError {
  constructor(status: number) { super(status, ''); this.message = describeCloudError(status); }
}

/** HEAD: true if the file exists, false if not or not checkable (file-drop links). */
async function exists(url: string, auth: string | null, signal: AbortSignal): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', headers: auth ? { Authorization: auth } : {}, signal, cache: 'no-store' });
  } catch {
    if (signal.aborted) throw new Error('Upload abgebrochen.');
    throw new CloudError(0);
  }
  if (res.status === 200) return true;
  if (res.status === 401) throw new CloudError(res.status);
  return false; // 404 = free; 405 = file drop without read access (the server renames duplicates itself)
}

export function uploadToCloud(kind: CloudKind, shareUrl: string, password: string, file: Blob, name: string,
  onProgress: (p: number) => void): { promise: Promise<string>; abort: () => void } {
  const ctrl = new AbortController();
  const xhr = new XMLHttpRequest();
  const promise = (async () => {
    const url = cloudFileUrl(kind, parseShareLink(shareUrl), name);
    const auth = authHeader(kind, password);
    if (await exists(url, auth, ctrl.signal)) throw new CloudError(409);
    return new Promise<string>((resolve, reject) => {
      xhr.open('PUT', url);
      if (auth) xhr.setRequestHeader('Authorization', auth);
      xhr.setRequestHeader('Content-Type', 'audio/mpeg');
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(name) : reject(new CloudError(xhr.status));
      xhr.onerror = () => reject(new CloudError(0));
      xhr.onabort = () => reject(new Error('Upload abgebrochen.'));
      if (ctrl.signal.aborted) return reject(new Error('Upload abgebrochen.'));
      xhr.send(file);
    });
  })();
  return { promise, abort: () => { ctrl.abort(); xhr.abort(); } };
}
