import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';
import writeExcelFile from 'write-excel-file/universal';
import { colIndex, colName, Xlsx, XlsxError } from '../server/xlsx';
import { PlanDateMissing, PlanFormatError, setAvailability, setMischer } from '../server/plan-store';
import { readOverview } from '../server/overview-store';
import { readPlanXlsx } from '../packages/plan/plan';
import { planSheet } from './plan.test';

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** An .xlsx as Excel writes it: shared strings, styles, "spans" hints, a formula, optionally the 1904 date system. */
function excelLike(sheetData: string, { date1904 = false, strings = [] as string[] } = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets><sheet name="Plan &amp; Co" sheetId="1" r:id="rId3"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(t => `<si><t>${t}</t></si>`).join('')}</sst>`),
    'xl/styles.xml': strToU8('<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`),
  });
}

describe('xlsx cells', () => {
  it('converts column letters', () => {
    expect([colIndex('A'), colIndex('K'), colIndex('AA')]).toEqual([0, 10, 26]);
    expect([colName(0), colName(10), colName(26), colName(701)]).toEqual(['A', 'K', 'AA', 'ZZ']);
  });

  it('reads shared and inline strings, numbers, cached formula values and rich text', () => {
    const x = new Xlsx(excelLike(
      '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inline &amp; more</t></is></c></row>' +
      '<row r="3"><c r="A3" s="2"><v>46327</v></c><c r="B3"><f>A3+7</f><v>46334</v></c><c r="C3" t="s"><v>1</v></c></row>',
      { strings: ['Datum', '</t>ignored<t>'] }));
    expect(x.sheets).toEqual([{ name: 'Plan & Co', path: 'xl/worksheets/sheet1.xml' }]);
    const rows = x.rows();
    expect([...rows.keys()]).toEqual([1, 3]);
    expect(rows.get(1)).toEqual(new Map<number, string | number>([[0, 'Datum'], [2, 'inline & more']]));
    expect(rows.get(3)?.get(1)).toBe(46334);
    expect(x.serialToIso(46327)).toBe('2026-11-01');
  });

  it('knows the 1904 date system', () => {
    expect(new Xlsx(excelLike('', { date1904: true })).serialToIso(44865)).toBe('2026-11-01');
  });

  it('changes one cell, keeping its style, and leaves every other part untouched', () => {
    const before = excelLike(
      '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="B1" s="5" t="s"><v>1</v></c></row>' +
      '<row r="2" spans="1:3" ht="20" customHeight="1"><c r="A2"><v>1</v></c><c r="C2" s="7"><v>3</v></c></row>',
      { strings: ['Datum', 'alt'] });
    const x = new Xlsx(before);
    x.setText(0, 1, 1, 'Neu <& "Wert">');
    x.setText(0, 2, 1, 'eingefügt'); // B2 does not exist yet: goes between A2 and C2
    x.setText(0, 2, 2, '');          // C2 emptied, style kept
    const after = unzipSync(x.toBuffer());
    const original = unzipSync(before);
    for (const name of Object.keys(original)) {
      if (name !== 'xl/worksheets/sheet1.xml') expect(strFromU8(after[name])).toBe(strFromU8(original[name]));
    }
    expect(strFromU8(after['xl/worksheets/sheet1.xml'])).toContain(
      '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="B1" s="5" t="inlineStr"><is><t xml:space="preserve">Neu &lt;&amp; "Wert"&gt;</t></is></c></row>' +
      '<row r="2" ht="20" customHeight="1"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t xml:space="preserve">eingefügt</t></is></c><c r="C2" s="7"/></row>');
    const again = new Xlsx(x.toBuffer()).rows();
    expect(again.get(1)?.get(1)).toBe('Neu <& "Wert">');
    expect(again.get(2)?.has(2)).toBe(false);
  });

  it('refuses formulas, missing rows and files that are no xlsx', () => {
    const x = new Xlsx(excelLike('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>'));
    expect(() => x.setText(0, 1, 0, 'x')).toThrow(XlsxError);
    expect(() => x.setText(0, 9, 0, 'x')).toThrow(/row 9 missing/);
    expect(() => new Xlsx(strToU8('hello'))).toThrow(XlsxError);
  });
});

describe('Mischer in the Einsatzplan', () => {
  it('writes only the Mischer cell of that date; the plan reads it back', async () => {
    const data = await bytes(await planSheet());
    const changed = setMischer(data, '2026-11-15', 'JD');
    const { entries } = await readPlanXlsx(new Blob([changed as Uint8Array<ArrayBuffer>]));
    expect(entries.find(e => e.date === '2026-11-15')).toMatchObject({ mischer: 'JD', beamer: 'MS', team: 'J-Team' });
    // a date written as text, and emptying a cell
    const text = setMischer(setMischer(changed, '2026-11-29', 'KL'), '2026-11-01', '');
    const again = (await readPlanXlsx(new Blob([text as Uint8Array<ArrayBuffer>]))).entries;
    expect(again.map(e => [e.date, e.mischer])).toEqual([['2026-11-01', ''], ['2026-11-15', 'JD'], ['2026-11-29', 'KL']]);
  });

  it('writes answers into "Mischer möglich" / "nicht möglich", leaving the Beamer columns alone', async () => {
    const data = await bytes(await planSheet());
    const read = async (d: Uint8Array) => (await readPlanXlsx(new Blob([d as Uint8Array<ArrayBuffer>]))).entries.find(e => e.date === '2026-11-15')!;
    let d = setAvailability(data, '2026-11-15', 'JD', 'maybe');
    expect((await read(d)).votes).toEqual({ KL: 'yes', JD: 'maybe', JS: 'no', AS: 'no' });
    d = setAvailability(d, '2026-11-15', 'AS', 'yes'); // from "nicht möglich" to "möglich"
    d = setAvailability(d, '2026-11-15', 'KL', null);
    expect((await read(d)).votes).toEqual({ JD: 'maybe', AS: 'yes', JS: 'no' });
    const cells = new Xlsx(d).rows().get(3)!; // row of 15.11. (title, header, then this date)
    expect([cells.get(5), cells.get(6), cells.get(8), cells.get(9)]).toEqual(['JD?, AS', 'JS', 'MS, RR', 'GK']); // F, G changed; I, J as before
  });

  it('reports dates that are not in the plan and files without the columns', async () => {
    const data = await bytes(await planSheet());
    expect(() => setMischer(data, '2027-01-03', 'JD')).toThrow(PlanDateMissing);
    const other = await bytes(await writeExcelFile([['Datum', 'Anlass'], ['01.11.2026', 'x']] as never).toBlob());
    expect(() => setMischer(other, '2026-11-01', 'JD')).toThrow(PlanFormatError);
    const noAnswers = await bytes(await writeExcelFile([['Datum', 'Mischer'], ['01.11.2026', 'JD']] as never).toBlob());
    expect(() => setAvailability(noAnswers, '2026-11-01', 'JD', 'yes')).toThrow(/Mischer möglich/);
  });
});

describe('eAg-Übersicht', () => {
  const day = (iso: string) => ({ value: new Date(`${iso}T00:00:00Z`), format: 'dd.mm.yyyy' });
  const row = (date: unknown, series: string | null, preacher: string | null) =>
    [date, 'x', null, null, null, null, series, null, null, null, preacher];
  const header = ['Datum', 'Anlass', 'C', 'D', 'E', 'F', 'Predigtreihe', 'H', 'I', 'J', 'Prediger'];

  it('reads date (A), series (G) and preacher (K) and numbers the sermons of each series by date', async () => {
    const file = await writeExcelFile([
      { sheet: 'Notizen', data: [['Datum'], [day('2026-01-01')]] },
      { sheet: '2026', data: [
        ['Übersicht', null, null, null, null, null, null, null, null, null, null],
        header,
        row(day('2026-07-12'), 'Zeit', 'Pfr. B'),
        row(day('2026-06-28'), 'Zeit', 'Pfr. A'),
        row('05.07.2026', 'Gebet', 'Pfr. A'),
        row(day('2026-07-19'), 'zeit ', 'Pfr. C'),
        row(day('2026-07-26'), null, 'Gast'),
        row(day('2026-11-29'), 'Zeit', 'Pfr. A'), // months later: a new series of the same name
      ] },
    ] as never).toBlob();
    expect(readOverview(await bytes(file))).toEqual([
      { date: '2026-06-28', series: 'Zeit', index: 1, preacher: 'Pfr. A' },
      { date: '2026-07-05', series: 'Gebet', index: 1, preacher: 'Pfr. A' },
      { date: '2026-07-12', series: 'Zeit', index: 2, preacher: 'Pfr. B' },
      { date: '2026-07-19', series: 'zeit', index: 3, preacher: 'Pfr. C' },
      { date: '2026-07-26', series: '', index: 0, preacher: 'Gast' },
      { date: '2026-11-29', series: 'Zeit', index: 1, preacher: 'Pfr. A' },
    ]);
  });

  it('takes each date from the sheet of its year, counting series across the turn of the year', async () => {
    const file = await writeExcelFile([
      { sheet: '2026', data: [header, row(day('2026-01-04'), 'Advent', 'Neu'), row(day('2026-01-11'), 'Jona', 'X'), row(day('2027-01-03'), 'Jona', 'Y')] },
      { sheet: '2025', data: [header, row(day('2025-12-28'), 'Advent', 'A'), row(day('2026-01-04'), 'Alt', 'Alt')] },
      { sheet: 'Notizen', data: [header, row(day('2025-06-01'), 'Notiz', 'N')] },
    ] as never).toBlob();
    expect(readOverview(await bytes(file)).map(e => `${e.date} ${e.series} ${e.index} ${e.preacher}`)).toEqual([
      '2025-12-28 Advent 1 A',
      '2026-01-04 Advent 2 Neu', // from "2026", not the leftover in "2025"
      '2026-01-11 Jona 1 X',
      '2027-01-03 Jona 1 Y', // no sheet "2027": taken from "2026"; a year later counts anew
    ]);
  });
});
