import { describe, expect, it } from 'vitest';
import { normalizeSign } from '../apps/termine/src/model';
import { answerCells, planColumns, readAvailability, withSign, withoutSign } from '../packages/plan/plan';
import { isValidDate } from '../packages/plan/cells';

describe('Kürzel and dates', () => {
  it('validates them', () => {
    expect(isValidDate('2026-10-25')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('0100-01-01')).toBe(false);
    expect(normalizeSign(' jd ')).toBe('JD');
    expect(normalizeSign('Jö')).toBe('JÖ');
    expect(normalizeSign('J D')).toBe('');
    expect(normalizeSign('ABCDEFG')).toBe('');
  });
});

describe('answers in "Mischer möglich" / "nicht möglich"', () => {
  it('reads Kürzel in capitals, "?" as maybe, "nicht möglich" winning; other text is no answer', () => {
    expect(readAvailability('JS,AS, KL?', 'MS')).toEqual({ JS: 'yes', AS: 'yes', KL: 'maybe', MS: 'no' });
    expect(readAvailability('JD (nur vormittags)', 'JD')).toEqual({ JD: 'no' });
    expect(readAvailability('alle außer Max', '')).toEqual({});
    expect(readAvailability('', '')).toEqual({});
  });

  it('removes a Kürzel without touching the rest', () => {
    expect(withoutSign('JS, JD, AS', 'JD')).toBe('JS, AS');
    expect(withoutSign('JD,AS', 'JD')).toBe('AS');
    expect(withoutSign('JS,JD?', 'JD')).toBe('JS');
    expect(withoutSign('JD', 'JD')).toBe('');
    expect(withoutSign('JDS, JD2', 'JD')).toBe('JDS, JD2'); // other Kürzel that start alike
    expect(withoutSign('JS AS (Probe)', 'JD')).toBe('JS AS (Probe)'); // untouched when absent
    expect(withSign('', 'JD')).toBe('JD');
    expect(withSign('JS,AS', 'JD?')).toBe('JS,AS, JD?');
  });

  it('moves an answer between the two cells', () => {
    expect(answerCells('JS', 'KL', 'JD', 'yes')).toEqual({ possible: 'JS, JD', notPossible: 'KL' });
    expect(answerCells('JS, JD', 'KL', 'JD', 'maybe')).toEqual({ possible: 'JS, JD?', notPossible: 'KL' });
    expect(answerCells('JS, JD?', 'KL', 'JD', 'no')).toEqual({ possible: 'JS', notPossible: 'KL, JD' });
    expect(answerCells('JS', 'KL, JD', 'JD', null)).toEqual({ possible: 'JS', notPossible: 'KL' });
  });

  it('takes the "nicht möglich" right after "Mischer möglich", not the Beamer one', () => {
    const header = ['datum', 'besonderheiten', 'musikteam', 'teamleitung', 'mischer', 'mischer möglich', 'nicht möglich', 'beamer', 'beamer möglich', 'nicht möglich', 'bemerkungen'];
    expect(planColumns(header)).toMatchObject({ date: 0, mischer: 4, possible: 5, notPossible: 6, beamer: 7 });
    expect(planColumns(['datum', 'mischer'])).toMatchObject({ possible: -1, notPossible: -1 });
  });
});
