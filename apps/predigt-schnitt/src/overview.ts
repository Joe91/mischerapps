// What the eAg-Übersicht (in OpenCloud) says about a date: sermon series, its number in the series, preacher.
// The server reads the spreadsheet (see server/overview-store.ts); the export fills the tags with it.

export interface OverviewEntry { date: string; series: string; index: number; preacher: string; }

/** the entry, null if the overview has none for the date, "unavailable" if there is no overview (or no answer) */
export async function fetchOverview(date: string): Promise<OverviewEntry | null | 'unavailable'> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    const res = await fetch(`/api/overview?date=${date}`, { cache: 'no-store' });
    if (res.ok) return await res.json();
    return res.status === 404 && (await res.text()) === 'date not in overview' ? null : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** "Zeit - 04": series and number, as the title of the MP3 */
export const seriesTitle = (e: Pick<OverviewEntry, 'series' | 'index'>) =>
  e.index ? `${e.series} - ${String(e.index).padStart(2, '0')}` : e.series;

/** predigt-eag-260628.mp3 → 2026-06-28 (the naming scheme's {jjmmdd}); null without such a date */
export function dateFromFileName(name: string): string | null {
  const m = /(?:^|\D)(\d{2})(\d{2})(\d{2})(?:\D|$)/.exec(name);
  if (!m) return null;
  const iso = `20${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !isNaN(+d) && d.toISOString().startsWith(iso) ? iso : null;
}
