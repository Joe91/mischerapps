import { describe, expect, it } from 'vitest';
import writeExcelFile from 'write-excel-file/universal';
import { readSheet } from 'read-excel-file/universal';
import { readTermineXlsx, writeTermineXlsx } from '../apps/termine/src/xlsx';
import type { TermineData } from '../apps/termine/src/model';

const sample = (): TermineData => ({
  dates: {
    '2026-10-25': { title: 'Abendmahl', time: '10:00', assigned: 'JD, MK', note: 'Zeile 1\nZeile 2', votes: { JD: 'yes', MK: 'maybe' } },
    '2026-12-24': { title: '', time: '', assigned: '', note: '', votes: { MK: 'no' } },
    '2027-01-03': { title: 'Neujahr', time: '', assigned: '', note: '', votes: {} },
  },
});

describe('termine xlsx', () => {
  it('round-trips the data', async () => {
    const { data, skipped } = await readTermineXlsx(await writeTermineXlsx(sample()));
    expect(data).toEqual(sample());
    expect(skipped).toBe(0);
  });

  it('is laid out for humans: one row per date, one column per Kürzel', async () => {
    const rows = await readSheet(await writeTermineXlsx(sample()));
    expect(rows[0]).toEqual(['Datum', 'Wochentag', 'Uhrzeit', 'Anlass', 'Eingeteilt', 'Hinweis', 'JD', 'MK']);
    expect(rows[1].slice(1)).toEqual(['Sonntag', '10:00', 'Abendmahl', 'JD, MK', 'Zeile 1\nZeile 2', 'Ja', 'Vielleicht']);
    expect(rows[2].slice(1)).toEqual(['Donnerstag', null, null, null, null, null, 'Nein']);
  });

  it('writes an empty list as a header-only sheet', async () => {
    const { data } = await readTermineXlsx(await writeTermineXlsx({ dates: {} }));
    expect(data).toEqual({ dates: {} });
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

  it('rejects files that are not spreadsheets', async () => {
    await expect(readTermineXlsx(new Blob(['<html>login</html>']))).rejects.toThrow();
  });
});
