import { describe, expect, it } from 'vitest';
import writeExcelFile from 'write-excel-file/universal';
import { publicPlan, readPlanXlsx, PlanFormatError } from '../packages/plan/plan';

const day = (iso: string) => ({ value: new Date(`${iso}T00:00:00Z`), format: 'dd.mm.yyyy' });

/** Laid out like the church's Musik_Mischer_Beamer.xlsx (with made-up names). */
export const planSheet = () => writeExcelFile([
  ['Einsatzplan 2026', null, null, null, null, null, null, null, null, null, null],
  ['Datum', 'Besonderheiten', 'Musikteam', 'Teamleitung', 'Mischer', 'Mischer möglich', 'nicht möglich', 'Beamer', 'Beamer möglich', 'nicht möglich', 'Bemerkungen'],
  [day('2026-11-15'), null, 'J-Team', 'Anna', 'KL', 'KL', 'JS,AS', 'MS', 'MS, RR', 'GK', 'kein eAg am 22.'],
  [day('2026-11-01'), 'Abendmahl', 'H-Team', 'Berta', 'AS, JD', 'JS,AS', 'KL', 'RR', 'GK, RR', 'MS', null],
  [day('2026-11-08'), null, 'Kein eAg, Sonntag at home', null, null, null, 'JS,AS, KL', 'Kein eAg, Sonntag at home?', 'MS', 'GK', null],
  [day('2026-11-22'), null, 'kein eAg', 'Sporttag', null, null, null, 'JSO', 'RR', 'GK', null],
  ['29.11.2026', null, '??', '??', null, null, null, 'GK', null, null, null],
  [null, null, null, null, null, null, null, null, null, null, null],
  [null, null, null, null, 'KL', 'Karl Lang', null, 'MS', 'Maria Stein', null, null],
  [null, null, null, null, 'AS', 'Alex Sommer', null, 'RR', 'Rita Rot', null, null],
  [null, null, null, null, 'JD', 'Jo Dorn', null, 'GK', 'Gisela', null, null],
] as never).toBlob();

describe('Einsatzplan xlsx', () => {
  it('reads the dates by their column headers, sorted, without the "kein eAg" ones', async () => {
    const { entries, hidden } = await readPlanXlsx(await planSheet());
    expect(hidden).toBe(2);
    expect(entries).toEqual([
      { date: '2026-11-01', team: 'H-Team', lead: 'Berta', mischer: 'AS, JD', beamer: 'RR', special: 'Abendmahl', note: '', votes: { JS: 'yes', AS: 'yes', KL: 'no' } },
      // a remark mentioning "kein eAg" does not hide the date
      { date: '2026-11-15', team: 'J-Team', lead: 'Anna', mischer: 'KL', beamer: 'MS', special: '', note: 'kein eAg am 22.', votes: { KL: 'yes', JS: 'no', AS: 'no' } },
      { date: '2026-11-29', team: '??', lead: '??', mischer: '', beamer: 'GK', special: '', note: '', votes: {} },
    ]);
  });

  it('reads the key of Kürzel and full names below the dates (a first name alone is no key)', async () => {
    const { names } = await readPlanXlsx(await planSheet());
    expect(names).toEqual({ KL: 'Karl Lang', AS: 'Alex Sommer', JD: 'Jo Dorn', MS: 'Maria Stein', RR: 'Rita Rot' });
  });

  it('rejects files without a "Datum" and "Mischer" header, and files that are no xlsx', async () => {
    const other = await writeExcelFile([['Datum', 'Anlass'], ['01.11.2026', 'x']] as never).toBlob();
    await expect(readPlanXlsx(other)).rejects.toBeInstanceOf(PlanFormatError);
    await expect(readPlanXlsx(new Blob(['hello']))).rejects.toBeInstanceOf(PlanFormatError);
  });

  it('shows visitors only the next dates, without names and remarks', async () => {
    const plan = await readPlanXlsx(await planSheet());
    const view = publicPlan(plan, '2026-11-02', 1);
    expect(view.names).toEqual({});
    expect(view.entries).toEqual([{ date: '2026-11-15', team: 'J-Team', lead: 'Anna', mischer: 'KL', beamer: 'MS', special: '', note: '', votes: {} }]);
    expect(publicPlan(plan, '2026-11-01').entries.map(e => e.date)).toEqual(['2026-11-01', '2026-11-15', '2026-11-29']);
  });
});
