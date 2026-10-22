import { describe, expect, it } from 'vitest';
import { applyOp, isValidDate, normalizeSign, OpError, sundays, type TermineData } from '../apps/termine/src/model';

describe('termine model', () => {
  it('lists Sundays starting today or with the next Sunday', () => {
    expect(sundays(new Date(2026, 9, 21), 3)).toEqual(['2026-10-25', '2026-11-01', '2026-11-08']); // Wednesday
    expect(sundays(new Date(2026, 9, 25), 2)).toEqual(['2026-10-25', '2026-11-01']);                // Sunday itself
    expect(sundays(new Date(2026, 9, 21), 2, -2)).toEqual(['2026-10-11', '2026-10-18']);
    expect(sundays(new Date(2026, 2, 25), 2)).toEqual(['2026-03-29', '2026-04-05']);               // across DST change
  });

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

  it('records, changes and withdraws votes', () => {
    const data: TermineData = { dates: {} };
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'jd', answer: 'yes' });
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'MK', answer: 'maybe' });
    expect(data.dates['2026-10-25'].votes).toEqual({ JD: 'yes', MK: 'maybe' });
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'no' });
    expect(data.dates['2026-10-25'].votes.JD).toBe('no');
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: null });
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'MK', answer: null });
    expect(data.dates).toEqual({}); // blank entries are removed
  });

  it('updates details without touching votes', () => {
    const data: TermineData = { dates: {} };
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' });
    applyOp(data, { action: 'update', date: '2026-10-25', title: ' Abendmahl ', time: '10:00', assigned: 'JD', note: 'x'.repeat(2000) });
    const e = data.dates['2026-10-25'];
    expect(e.title).toBe('Abendmahl');
    expect(e.note).toHaveLength(1000);
    expect(e.votes).toEqual({ JD: 'yes' });
  });

  it('deletes a date with all its answers', () => {
    const data: TermineData = { dates: {} };
    applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' });
    applyOp(data, { action: 'delete', date: '2026-10-25' });
    applyOp(data, { action: 'delete', date: '2026-11-01' }); // nothing there: fine
    expect(data.dates).toEqual({});
  });

  it('rejects invalid input', () => {
    const data: TermineData = { dates: {} };
    expect(() => applyOp(data, { action: 'vote', date: '2026-13-01', sign: 'JD', answer: 'yes' })).toThrow(OpError);
    expect(() => applyOp(data, { action: 'vote', date: '2026-10-25', sign: '', answer: 'yes' })).toThrow('bad sign');
    expect(() => applyOp(data, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'ok' as never })).toThrow('bad answer');
    expect(() => applyOp(data, { action: 'frobnicate', date: '2026-10-25' } as never)).toThrow('bad action');
  });
});
