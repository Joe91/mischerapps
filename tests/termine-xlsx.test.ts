import { describe, expect, it } from 'vitest';
import writeExcelFile from 'write-excel-file/universal';
import { readSheet } from 'read-excel-file/universal';
import { readTermineXlsx, writeTermineXlsx } from '../apps/termine/src/xlsx';
import { applyOp, type TermineData } from '../apps/termine/src/model';

const sample = (): TermineData => ({
  dates: {
    '2026-10-25': { title: 'Abendmahl', time: '10:00', assigned: 'JD, MK', note: 'Zeile 1\nZeile 2', votes: { JD: 'yes', MK: 'maybe' } },
    '2026-12-24': { title: '', time: '', assigned: '', note: '', votes: { MK: 'no' } },
    '2027-01-03': { title: 'Neujahr', time: '', assigned: '', note: '', votes: {} },
    '2027-01-10': { title: '', time: '', assigned: '', note: '', votes: {} }, // just a date on the list
  },
});

describe('termine xlsx', () => {
  it('round-trips the data', async () => {
    const { data, skipped } = await readTermineXlsx(await writeTermineXlsx(sample()));
    expect(data).toEqual({ ...sample(), sheet: { columns: ['JD', 'MK'], undated: [] } });
    expect(skipped).toBe(0);
  });

  it('is laid out for humans: one row per date, one column per Kürzel', async () => {
    const rows = await readSheet(await writeTermineXlsx(sample()));
    expect(rows[0]).toEqual(['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis', 'JD', 'MK']);
    expect(rows[1].slice(1)).toEqual(['Sonntag', '10:00', 'Abendmahl', 'JD, MK', 'Zeile 1\nZeile 2', 'Ja', 'Vielleicht']);
    expect(rows[2].slice(1)).toEqual(['Donnerstag', null, null, null, null, null, 'Nein']);
  });

  it('lists a row with nothing but a date (a template with all Sundays)', async () => {
    const rows = await readSheet(await writeTermineXlsx(sample()));
    expect(rows[4].slice(0, 2)).toEqual([new Date(Date.UTC(2027, 0, 10)), 'Sonntag']);
    const blank = await writeExcelFile([
      ['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis'],
      [{ value: new Date(Date.UTC(2026, 10, 1)), format: 'dd.mm.yyyy' }, 'Sonntag', null, null, null, null],
      ['08.11.2026', null, null, null, null, null],
    ] as never).toBlob();
    const { data, skipped } = await readTermineXlsx(blank);
    expect(Object.keys(data.dates)).toEqual(['2026-11-01', '2026-11-08']);
    expect(skipped).toBe(0);
  });

  it('writes an empty list as a header-only sheet', async () => {
    const { data } = await readTermineXlsx(await writeTermineXlsx({ dates: {} }));
    expect(data).toEqual({ dates: {}, sheet: { columns: [], undated: [] } });
  });

  it('reads a file as edited by hand', async () => {
    const blob = await writeExcelFile([
      ['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis', 'jd', 'XY'],
      ['25.10.2026', 'egal', '10:00', ' Abendmahl ', 'JD', null, 'ja', '?'],             // text date, lower case Kürzel
      [{ value: new Date(Date.UTC(2026, 10, 1)), format: 'dd.mm.yyyy' }, null, 0.4375, null, null, null, 'N', 'quatsch'], // date cell, time as fraction (10:30)
      [{ value: 46334, type: Number }, null, null, 'Serial', null, null, null, null],   // Excel serial number (2026-11-08)
      ['2026-11-15', null, null, 'ISO', null, null, null, null],
      ['bald', null, null, 'kaputt', null, null, 'Ja', null],                          // no usable date
      [null, null, null, null, null, null, null, null],                                // blank line
      ['30.02.2026', null, null, null, null, null, null, null],                        // impossible date
    ] as never).toBlob();
    const { data, skipped } = await readTermineXlsx(blob);
    expect(skipped).toBe(2);
    expect(data.dates['2026-10-25']).toEqual({ title: 'Abendmahl', time: '10:00', assigned: 'JD', note: '', votes: { JD: 'yes', XY: 'maybe' } });
    expect(data.dates['2026-11-01']).toMatchObject({ time: '10:30', votes: { JD: 'no' } });
    expect(data.dates['2026-11-08'].title).toBe('Serial');
    expect(data.dates['2026-11-15'].title).toBe('ISO');
    expect(Object.keys(data.dates)).toHaveLength(4);
  });

  it('keeps what was added by hand when the app changes the file', async () => {
    const edited = await writeExcelFile([
      ['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis', 'Bemerkung', 'jd', 'AB', 'MK'],
      ['25.10.2026', null, null, 'Abendmahl', null, null, 'Mikro mitbringen', 'x', null, 'ja'], // own column, "x" in a Kürzel column
      ['01.11.2026', null, null, null, null, null, null, null, null, null],                     // AB: listed, no answers yet
      ['Notizen', null, null, 'Bitte Technik prüfen', null, null, null, null, null, null],     // no date
    ] as never).toBlob();
    const { data } = await readTermineXlsx(edited);
    // a mischer answers in the app, the file is written again
    applyOp(data, { action: 'vote', date: '2026-11-01', sign: 'NEU', answer: 'yes' });
    const rows = await readSheet(await writeTermineXlsx(data));
    expect(rows[0]).toEqual(['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis', 'Bemerkung', 'jd', 'AB', 'MK', 'NEU']);
    expect(rows[1].slice(6)).toEqual(['Mikro mitbringen', 'x', null, 'Ja', null]);
    expect(rows[2].slice(6)).toEqual([null, null, null, null, 'Ja']);
    expect(rows[3].slice(0, 4)).toEqual(['Notizen', null, null, 'Bitte Technik prüfen']);
    // an answer given in the app replaces the "x"
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'no' });
    expect((await readSheet(await writeTermineXlsx(data)))[1][7]).toBe('Nein');
  });

  it('rejects files that are not spreadsheets', async () => {
    await expect(readTermineXlsx(new Blob(['<html>login</html>']))).rejects.toThrow();
  });
});
