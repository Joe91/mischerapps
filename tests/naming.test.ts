import { describe, expect, it } from 'vitest';
import { buildFileName, isValidFileName, lastSunday, sanitizeFileName, slug } from '../apps/predigt-schnitt/src/naming';

describe('naming', () => {
  const meta = { title: 'Predigt über Lukas 18', preacher: 'Jörg Müller', date: '2026-10-25', scripture: 'Lk 18,1-8', album: 'St. Johannis' };

  it('slugifies German text', () => {
    expect(slug('Predigt über Lukas 18')).toBe('Predigt-ueber-Lukas-18');
    expect(slug('Großes Ärgernis!')).toBe('Grosses-Aergernis');
    expect(slug('Lk 18,1-8')).toBe('Lk-18-1-8');
  });

  it('builds names from the pattern', () => {
    expect(buildFileName('predigt_eag_{datum}', meta)).toBe('predigt_eag_2026-10-25.mp3');
    expect(buildFileName('{datum}_{titel}', meta)).toBe('2026-10-25_Predigt-ueber-Lukas-18.mp3');
    expect(buildFileName('{datum}_{prediger}_{bibelstelle}', meta)).toBe('2026-10-25_Joerg-Mueller_Lk-18-1-8.mp3');
    expect(buildFileName('{datum}_{titel}', { ...meta, title: '' })).toBe('2026-10-25.mp3');
  });

  it('always yields names the upload script accepts', () => {
    for (const n of ['a b c', '../../etc/passwd', 'x'.repeat(300), '', 'Ä.mp3', 'test.MP3']) {
      expect(isValidFileName(sanitizeFileName(n))).toBe(true);
    }
  });

  it('defaults the date to the last Sunday', () => {
    expect(lastSunday(new Date(2026, 9, 21))).toBe('2026-10-18'); // Wednesday
    expect(lastSunday(new Date(2026, 9, 25))).toBe('2026-10-25'); // Sunday
  });
});
