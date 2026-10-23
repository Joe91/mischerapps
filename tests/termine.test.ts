import { describe, expect, it } from 'vitest';
import { applyOp, emptyEntry, isValidDate, normalizeSign, OpError, type TermineData } from '../apps/termine/src/model';

describe('termine model', () => {
  it('validates dates and Kürzel', () => {
    expect(isValidDate('2026-10-25')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('0100-01-01')).toBe(false);   // outside 2000–2100: does not survive the spreadsheet
    expect(isValidDate('2101-01-01')).toBe(false);
    expect(isValidDate('25.10.2026')).toBe(false);
    expect(normalizeSign(' jd ')).toBe('JD');
    expect(normalizeSign('Jö')).toBe('JÖ');
    expect(normalizeSign('J D')).toBe('');
    expect(normalizeSign('<b>')).toBe('');
    expect(normalizeSign('ABCDEFG')).toBe('');
  });

  it('records, changes and withdraws votes; the first one gives the date its row', () => {
    const data: TermineData = { dates: {} };
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'jd', answer: 'yes' });
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'MK', answer: 'maybe' });
    expect(data.dates['2026-10-25'].votes).toEqual({ JD: 'yes', MK: 'maybe' });
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'no' });
    expect(data.dates['2026-10-25'].votes.JD).toBe('no');
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: null });
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'MK', answer: null });
    expect(data.dates).toEqual({ '2026-10-25': emptyEntry() });
  });

  it('updates notes without touching votes or the old assignment', () => {
    const data: TermineData = { dates: { '2026-10-25': { ...emptyEntry(), assigned: 'JD' } } };
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' });
    applyOp(data, { action: 'update', date: '2026-10-25', title: ' Abendmahl ', time: '10:00', note: 'x'.repeat(2000) });
    const e = data.dates['2026-10-25'];
    expect(e.title).toBe('Abendmahl');
    expect(e.note).toHaveLength(1000);
    expect(e.votes).toEqual({ JD: 'yes' });
    expect(e.assigned).toBe('JD'); // kept in the spreadsheet, no longer shown
  });

  it('rejects invalid input, also adding or deleting dates (they come from the Einsatzplan)', () => {
    const data: TermineData = { dates: {} };
    expect(() => applyOp(data, { action: 'vote', date: '2026-13-01', sign: 'JD', answer: 'yes' })).toThrow(OpError);
    expect(() => applyOp(data, { action: 'vote', date: '2026-10-25', sign: '', answer: 'yes' })).toThrow('bad sign');
    expect(() => applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'ok' as never })).toThrow('bad answer');
    expect(() => applyOp(data, { action: 'add', date: '2026-10-25' } as never)).toThrow('bad action');
    expect(() => applyOp(data, { action: 'delete', date: '2026-10-25' } as never)).toThrow('bad action');
    expect(data.dates).toEqual({});
  });
});
