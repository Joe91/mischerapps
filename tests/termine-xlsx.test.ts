import { afterEach, describe, expect, it, vi } from 'vitest';
import writeExcelFile from 'write-excel-file/universal';
import { readSheet } from 'read-excel-file/universal';
import { readTermineXlsx, writeTermineXlsx } from '../apps/termine/src/xlsx';
import { ApiError, fetchData, sendOp } from '../apps/termine/src/api';
import type { Settings } from '../apps/termine/src/settings';
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

// ---- cloud storage: a tiny in-memory WebDAV file with ETag / If-Match like OpenCloud and Nextcloud ----

const settings: Settings = { kind: 'opencloud', shareUrl: 'https://cloud.test/s/AbC', password: 'pw', file: 'termine.xlsx', sign: 'JD', weeks: 12 };

function fakeCloud(opts: { exposeEtag?: boolean; ignorePreconditions?: boolean; beforePut?: () => Promise<void>; afterPut?: () => Promise<void> } = {}) {
  let file: { body: Blob; etag: string } | null = null;
  let version = 0;
  const log: string[] = [];
  const put = async (body: Blob) => { file = { body, etag: `"v${++version}"` }; };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    expect(url).toBe('https://cloud.test/dav/public-files/AbC/termine.xlsx');
    expect(h.get('Authorization')).toMatch(/^Basic /);
    if (!init.method || init.method === 'GET') {
      log.push('GET');
      if (!file) return new Response('', { status: 404 });
      return new Response(await file.body.arrayBuffer(), { headers: opts.exposeEtag === false ? {} : { ETag: file.etag } });
    }
    log.push(`PUT ${h.get('If-Match') ?? (h.get('If-None-Match') ? 'new' : 'unconditional')}`);
    await opts.beforePut?.();
    opts.beforePut = undefined;
    if (!opts.ignorePreconditions && ((h.get('If-Match') && h.get('If-Match') !== file?.etag) || (h.get('If-None-Match') === '*' && file))) return new Response('', { status: 412 });
    await put(init.body as Blob);
    await opts.afterPut?.();
    opts.afterPut = undefined;
    return new Response('', { status: 201 });
  }));
  return { log, put, current: async () => (await readTermineXlsx(file!.body)).data };
}

describe('termine cloud storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts empty and creates the file with the first change', async () => {
    const cloud = fakeCloud();
    expect((await fetchData(settings)).data).toEqual({ dates: {} });
    await sendOp(settings, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' });
    expect(cloud.log).toEqual(['GET', 'GET', 'PUT new', 'GET']); // the last GET checks that the change arrived
    expect((await cloud.current()).dates['2026-10-25'].votes).toEqual({ JD: 'yes' });
    expect((await fetchData(settings)).data.dates['2026-10-25'].votes.JD).toBe('yes');
  });

  it('re-applies the change when somebody else wrote in between', async () => {
    const cloud = fakeCloud({
      beforePut: async () => { await cloud.put(await writeTermineXlsx({ dates: { '2026-11-01': { title: 'Konzert', time: '', assigned: '', note: '', votes: { MK: 'yes' } } } })); },
    });
    await sendOp(settings, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' });
    expect(cloud.log).toEqual(['GET', 'PUT new', 'GET', 'PUT "v1"', 'GET']);
    const data = await cloud.current();
    expect(data.dates['2026-11-01'].votes).toEqual({ MK: 'yes' }); // their change survived
    expect(data.dates['2026-10-25'].votes).toEqual({ JD: 'yes' }); // ours was applied on top
  });

  it('notices when a cloud without If-Match support lost the change to a slower writer', async () => {
    const before = await writeTermineXlsx({ dates: { '2026-11-01': { title: '', time: '', assigned: '', note: '', votes: { MK: 'yes' } } } });
    const cloud = fakeCloud({ ignorePreconditions: true, afterPut: async () => { await cloud.put(before); } }); // their stale write lands right after ours
    await cloud.put(before);
    await sendOp(settings, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' });
    expect(cloud.log.filter(l => l.startsWith('PUT'))).toHaveLength(2); // written, found missing, written again
    const data = await cloud.current();
    expect(data.dates['2026-10-25'].votes).toEqual({ JD: 'yes' });
    expect(data.dates['2026-11-01'].votes).toEqual({ MK: 'yes' });
  });

  it('still works if the cloud does not expose the ETag', async () => {
    const cloud = fakeCloud({ exposeEtag: false });
    await cloud.put(await writeTermineXlsx(sample()));
    await sendOp(settings, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'no' });
    expect(cloud.log.filter(l => l.startsWith('PUT'))).toEqual(['PUT unconditional']);
    expect((await cloud.current()).dates['2026-10-25'].votes.JD).toBe('no');
  });

  it('does not overwrite a file it cannot read', async () => {
    const cloud = fakeCloud();
    await cloud.put(new Blob(['not a spreadsheet']));
    await expect(sendOp(settings, { action: 'vote', date: '2026-10-25', sign: 'JD', answer: 'yes' })).rejects.toThrow(/keine gültige xlsx/);
    expect(cloud.log).toEqual(['GET']);
  });

  it('explains network and permission errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchData(settings)).rejects.toThrow(/CORS/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(fetchData(settings)).rejects.toThrow(/Bearbeiten/);
    expect(new ApiError(401, '').message).toMatch(/Passwort/);
  });
});
