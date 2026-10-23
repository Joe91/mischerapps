// The eAg-Übersicht (eAg_Übersicht.xlsx in OpenCloud, "cloud.overview" in the config): per service the date
// (column A), the sermon series (G) and the preacher (K), one sheet per year ("2026", "2025", …). The export uses
// it to fill in the tags of a sermon; the number of a sermon within its series ("Zeit – 4") is counted from the dates.
import { toIsoDate, toText } from '../apps/termine/src/xlsx';
import { SyncedFile, type CloudFile } from './cloud-file';
import { Xlsx, colIndex } from './xlsx';

export interface OverviewEntry {
  date: string;
  /** "Predigtreihe" – the album of the MP3 */
  series: string;
  /** the how-manieth sermon of its series (by date), 0 without series */
  index: number;
  preacher: string;
}

const COL = { date: colIndex('A'), series: colIndex('G'), preacher: colIndex('K') };
const MAX_TEXT = 120;
/** a series name coming back after this long is a new series (counted from 1 again) */
const NEW_SERIES_AFTER_DAYS = 60;
const YEAR = /^\d{4}$/;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/**
 * All dates of the overview, sorted. With sheets named by year, only those count, and a date only from the sheet
 * of its year (where there is one): the sheets overlap a little ("2025" runs into March 2026).
 */
export function readOverview(data: Uint8Array): OverviewEntry[] {
  const x = new Xlsx(data);
  const years = new Set(x.sheets.map(s => s.name.trim()).filter(n => YEAR.test(n)));
  const byDate = new Map<string, OverviewEntry>();
  /** the date's entry came from the sheet of its year */
  const fromOwnSheet = new Set<string>();
  x.sheets.forEach((sheet, i) => {
    const name = sheet.name.trim();
    if (years.size && !YEAR.test(name)) return;
    for (const cells of x.rows(i).values()) {
      const v = cells.get(COL.date);
      const date = typeof v === 'number' ? x.serialToIso(v) : toIsoDate(v);
      if (!date) continue;
      const year = date.slice(0, 4);
      if (years.size && year !== name && years.has(year)) continue;
      const text = (c: number) => toText(cells.get(c)).replace(/\s+/g, ' ').slice(0, MAX_TEXT);
      const entry = { date, series: text(COL.series), index: 0, preacher: text(COL.preacher) };
      // several rows of a date: the one from its own sheet, then one that says something
      const known = byDate.get(date), own = year === name;
      if (!known || (own && !fromOwnSheet.has(date)) || (!known.series && !known.preacher && (entry.series || entry.preacher))) {
        byDate.set(date, entry);
        if (own) fromOwnSheet.add(date);
      }
    }
  });
  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const last = new Map<string, { date: string; index: number }>();
  for (const e of entries) {
    const key = e.series.toLowerCase();
    if (!key) continue;
    const before = last.get(key);
    e.index = before && days(before.date, e.date) <= NEW_SERIES_AFTER_DAYS ? before.index + 1 : 1;
    last.set(key, { date: e.date, index: e.index });
  }
  return entries;
}

/** How often OpenCloud is asked whether the overview changed. */
const CHECK_EVERY_MS = 5 * 60_000;

export class OverviewStore {
  private cloud: SyncedFile | null;
  private parsed: { data: Uint8Array; entries: OverviewEntry[] } | null = null;

  constructor(cloud: CloudFile | null) {
    this.cloud = cloud ? new SyncedFile(cloud, CHECK_EVERY_MS, v => { this.parsed = { data: v.data, entries: readOverview(v.data) }; }) : null;
  }

  get configured() { return !!this.cloud; }

  /** The entry for `date` (with series or preacher, if there are several), null if the overview has none. */
  async find(date: string): Promise<OverviewEntry | null> {
    if (!this.cloud) return null;
    // while OpenCloud cannot be reached, the last version read serves
    await this.cloud.get().catch(e => { if (!this.parsed) throw e; });
    const same = this.parsed?.entries.filter(e => e.date === date) ?? [];
    return same.find(e => e.series || e.preacher) ?? same[0] ?? null;
  }
}
