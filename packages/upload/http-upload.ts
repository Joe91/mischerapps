export class UploadError extends Error {
  constructor(public status: number, public body: string) {
    super(describeUploadError(status, body));
  }
}

/** Plain-language messages for the status codes of server/upload.php. */
export function describeUploadError(status: number, body: string): string {
  const b = body.trim();
  switch (status) {
    case 0: return 'Server nicht erreichbar oder Anfrage durch CORS blockiert. Upload-URL und ALLOWED_ORIGIN im Server-Skript prüfen.';
    case 400: return b === 'bad name'
      ? 'Der Server hat den Dateinamen abgelehnt (erlaubt: Buchstaben, Ziffern, . _ - und Endung .mp3).'
      : 'Der Server hat die Datei nicht erhalten (Upload-Fehler, evtl. upload_max_filesize zu klein).';
    case 401: return 'Der Server hat die Datei abgelehnt: Token falsch.';
    case 404: return 'Upload-Skript nicht gefunden (404). Upload-URL prüfen.';
    case 405: return 'Der Server akzeptiert an dieser Adresse keine Uploads (405). Upload-URL prüfen.';
    case 409: return 'Der Server hat die Datei abgelehnt: Datei existiert bereits. Bitte Dateinamen ändern.';
    case 413: return 'Der Server hat die Datei abgelehnt: Datei zu groß.';
    case 415: return 'Der Server hat die Datei abgelehnt: keine gültige MP3-Datei.';
    case 500: return `Fehler auf dem Server beim Speichern${b ? ` (${b})` : ''}.`;
    default: return `Upload fehlgeschlagen (${status}${b ? `: ${b.slice(0, 200)}` : ''}).`;
  }
}

export function uploadFile(url: string, token: string, file: Blob, name: string,
  onProgress: (p: number) => void): { promise: Promise<string>; abort: () => void } {
  const xhr = new XMLHttpRequest(); // XHR, because fetch has no upload progress
  const promise = new Promise<string>((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, name);
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Upload-Token', token);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.responseText)
      : reject(new UploadError(xhr.status, xhr.responseText));
    xhr.onerror = () => reject(new UploadError(0, ''));
    xhr.onabort = () => reject(new Error('Upload abgebrochen.'));
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
