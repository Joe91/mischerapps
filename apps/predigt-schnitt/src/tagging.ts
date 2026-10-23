// The tags the app fills in by itself – the same rules for the export (Predigt-Schnitt) and when reprocessing
// (Predigt nachbearbeiten). See README, "Angaben der MP3":
//
//   Titel         "Zeit - 04" (Predigtreihe - Nr.), without series "Predigt vom 18.10.2026"
//   Interpret     Prediger/in (eAg-Übersicht, else the default from the settings)
//   Album-Interpret "Predigt eAg" (settings) – groups all sermons in players and podcast apps
//   Album         Predigtreihe, without series the setting "Album ohne Reihe" or the album artist
//   Track         number of the sermon in its series
//   Genre         "Predigt" (settings)
//   Jahr, Datum   the date of the service
//   Kommentar     Bibelstelle · 18.10.2026
import type { Tags } from '../../../packages/audio-core/tags';
import { seriesTitle, type OverviewEntry } from './overview';
import type { Settings } from './settings';

type TagSettings = Pick<Settings, 'titlePrefix' | 'preacher' | 'congregation' | 'albumArtist' | 'genre'>;

const isIso = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
/** 2026-10-18 → 18.10.2026 */
export const germanDate = (iso: string) => (isIso(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso);

/** What the app proposes for a sermon on `date`, with the eAg-Übersicht's entry (null if there is none). */
export function autoTags(s: TagSettings, date: string, o: OverviewEntry | null) {
  const series = o?.series ?? '';
  const albumArtist = s.albumArtist.trim();
  return {
    title: series ? seriesTitle(o!) : [s.titlePrefix.trim() || 'Predigt', isIso(date) ? `vom ${germanDate(date)}` : ''].filter(Boolean).join(' '),
    artist: o?.preacher || s.preacher.trim(),
    album: series || s.congregation.trim() || albumArtist,
    albumArtist,
    genre: s.genre.trim(),
    track: series ? o!.index : 0,
    series,
  };
}

/** Comment: Bible passage and date. */
export const commentFor = (scripture: string, date: string) => [scripture.trim(), germanDate(date)].filter(Boolean).join(' · ');

export type TagMode = 'auto' | 'keep';

/**
 * The tags for a file that is reprocessed. "auto": as in the export – what the overview knows wins, the file's
 * own details stay only where it knows nothing (a bare "Predigt" title counts as none); album artist and genre
 * from the settings. "keep": the file's tags stay, only missing ones are filled in. The cover is not touched.
 */
export function reprocessTags(file: Tags, s: TagSettings, date: string | null, o: OverviewEntry | null, mode: TagMode): Tags {
  const auto = autoTags(s, date ?? '', o);
  const day = date ?? file.date ?? '';
  const fromDate = isIso(day) ? { date: day, year: Number(day.slice(0, 4)) } : { date: file.date, year: file.year };
  const comment = file.comment || (isIso(day) ? germanDate(day) : undefined);
  const or = <T>(v: T) => v || undefined;
  if (mode === 'keep') {
    return {
      ...file,
      title: or(file.title || auto.title), artist: or(file.artist || auto.artist), album: or(file.album || auto.album),
      albumArtist: or(file.albumArtist || auto.albumArtist), genre: or(file.genre || auto.genre),
      track: or(file.track || auto.track), ...(file.date || file.year ? {} : fromDate), comment,
    };
  }
  const generic = (t?: string) => !t || t.trim().toLowerCase() === s.titlePrefix.trim().toLowerCase();
  return {
    ...file,
    title: or(auto.series ? auto.title : generic(file.title) ? auto.title : file.title),
    artist: or(o?.preacher || file.artist || auto.artist),
    album: or(auto.series || file.album || auto.album),
    albumArtist: or(auto.albumArtist), genre: or(auto.genre),
    track: or(auto.series ? auto.track : file.track),
    ...fromDate, comment,
  };
}
