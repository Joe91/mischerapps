import { describe, expect, it } from 'vitest';
import { autoTags, commentFor, germanDate, reprocessTags } from '../apps/predigt-schnitt/src/tagging';
import { dateFromFileName, seriesTitle } from '../apps/predigt-schnitt/src/overview';
import { defaultSettings } from '../apps/predigt-schnitt/src/settings';
import { buildFileName } from '../apps/predigt-schnitt/src/naming';

const s = defaultSettings();
const zeit = { date: '2026-10-18', series: 'Zeit', index: 4, preacher: 'Pfr. Vier' };

describe('tags filled in automatically', () => {
  it('from the eAg-Übersicht: "Reihe - Nr.", preacher, series as album, "Predigt eAg" as album artist', () => {
    expect(autoTags(s, '2026-10-18', zeit)).toEqual({
      title: 'Zeit - 04', artist: 'Pfr. Vier', album: 'Zeit', albumArtist: 'Predigt eAg', genre: 'Predigt', track: 4, series: 'Zeit',
    });
  });

  it('without an entry: "Predigt vom …", the defaults, and the album artist as album', () => {
    expect(autoTags({ ...s, preacher: 'Pfr. Standard' }, '2026-10-18', null)).toMatchObject({
      title: 'Predigt vom 18.10.2026', artist: 'Pfr. Standard', album: 'Predigt eAg', track: 0, series: '',
    });
    expect(autoTags({ ...s, congregation: 'eAg Esslingen' }, '2026-10-18', { ...zeit, series: '' })).toMatchObject({ album: 'eAg Esslingen', artist: 'Pfr. Vier' });
  });

  it('formats dates, comments and names', () => {
    expect(germanDate('2026-06-28')).toBe('28.06.2026');
    expect(commentFor(' Lk 18,1-8 ', '2026-10-18')).toBe('Lk 18,1-8 · 18.10.2026');
    expect(commentFor('', '2026-10-18')).toBe('18.10.2026');
    expect(seriesTitle({ series: 'Zeit', index: 12 })).toBe('Zeit - 12');
    expect(dateFromFileName('predigt-eag-260628.mp3')).toBe('2026-06-28');
    expect(dateFromFileName('predigt-eag-261018-1.mp3')).toBe('2026-10-18');
    expect(dateFromFileName('predigt-eag-261399.mp3')).toBeNull();
    expect(dateFromFileName('aufnahme.mp3')).toBeNull();
    expect(buildFileName('predigt-eag-{jjmmdd}-{reihe}-{nr}', { title: '', preacher: '', date: '2026-10-18', scripture: '', album: '', series: 'Was ist Wahrheit?', track: 4 }))
      .toBe('predigt-eag-261018-Was-ist-Wahrheit-04.mp3');
  });
});

describe('tags when reprocessing', () => {
  const old = { title: 'Predigt', artist: 'Alt', album: '', year: 2026, comment: 'Mt 5 · 2026-10-18', cover: { data: new ArrayBuffer(1), mime: 'image/png' } };

  it('"auto" applies the export rules; the file keeps what the overview does not know', () => {
    const t = reprocessTags(old, s, '2026-10-18', zeit, 'auto');
    expect(t).toMatchObject({
      title: 'Zeit - 04', artist: 'Pfr. Vier', album: 'Zeit', albumArtist: 'Predigt eAg', genre: 'Predigt', track: 4,
      date: '2026-10-18', year: 2026, comment: 'Mt 5 · 2026-10-18', cover: old.cover,
    });
    // no entry: a real title of the file stays, the bare "Predigt" does not
    expect(reprocessTags({ ...old, title: 'Gott sieht dich' }, s, '2026-10-18', null, 'auto').title).toBe('Gott sieht dich');
    expect(reprocessTags(old, s, '2026-10-18', null, 'auto')).toMatchObject({ title: 'Predigt vom 18.10.2026', artist: 'Alt', album: 'Predigt eAg' });
  });

  it('"auto" gives untagged old files everything, with the date from the file name', () => {
    expect(reprocessTags({}, s, '2026-06-28', { date: '2026-06-28', series: 'Nehemia', index: 1, preacher: 'Pfr. N' }, 'auto')).toEqual({
      title: 'Nehemia - 01', artist: 'Pfr. N', album: 'Nehemia', albumArtist: 'Predigt eAg', genre: 'Predigt', track: 1,
      date: '2026-06-28', year: 2026, comment: '28.06.2026',
    });
  });

  it('"keep" leaves the file\'s tags and only fills gaps', () => {
    const t = reprocessTags(old, s, '2026-10-18', zeit, 'keep');
    expect(t).toMatchObject({ title: 'Predigt', artist: 'Alt', album: 'Zeit', albumArtist: 'Predigt eAg', genre: 'Predigt', track: 4, year: 2026 });
    expect(t.date).toBeUndefined(); // the file has a year already
  });
});
