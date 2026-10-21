export interface Meta {
  title: string;
  preacher: string;
  date: string; // YYYY-MM-DD
  scripture: string;
  album: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Today if it is Sunday, otherwise the most recent Sunday. */
export function lastSunday(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - d.getDay());
  return isoDate(d);
}

/** ASCII slug that passes the upload script's name check: Ä→Ae, spaces/punctuation → '-'. */
export function slug(text: string): string {
  return text
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** Builds the file name from a pattern like "{datum}_{titel}". Always ends in .mp3, max 120 chars + extension. */
export function buildFileName(pattern: string, m: Meta): string {
  const values: Record<string, string> = {
    datum: m.date, titel: m.title, prediger: m.preacher, bibelstelle: m.scripture, gemeinde: m.album,
  };
  const name = pattern.replace(/\{(\w+)\}/g, (_, k: string) => slug(values[k.toLowerCase()] ?? ''))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/([_-])[_-]+/g, '$1')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return sanitizeFileName(name || 'predigt');
}

export function sanitizeFileName(name: string): string {
  let base = name.replace(/\.mp3$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  if (!base) base = 'predigt';
  return base.slice(0, 120) + '.mp3';
}

export const isValidFileName = (name: string) => /^[A-Za-z0-9._-]{1,120}\.mp3$/.test(name);
