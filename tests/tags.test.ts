import { describe, expect, it } from 'vitest';
import { id3Length, readTags, tagMp3 } from '../packages/audio-core/tags';

const FRAME = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);

/** An ID3v2.4 tag by hand (synchsafe sizes, UTF-8 text) with the given frames. */
function id3v24(frames: [string, number[]][]): Uint8Array {
  const body = frames.flatMap(([id, data]) => {
    const n = data.length;
    return [...id].map(c => c.charCodeAt(0)).concat([n >> 21 & 0x7f, n >> 14 & 0x7f, n >> 7 & 0x7f, n & 0x7f, 0, 0], data);
  });
  const n = body.length + 16; // and some padding
  return new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, n >> 21 & 0x7f, n >> 14 & 0x7f, n >> 7 & 0x7f, n & 0x7f, ...body, ...new Array(16).fill(0), ...FRAME]);
}
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

describe('readTags', () => {
  it('reads back what tagMp3 wrote', () => {
    const cover = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    const tags = { title: 'Predigt über Lukas 18 – „Glaube“', artist: 'Jörg Müller', album: 'EAG', year: 2026, comment: 'Lk 18,1-8 · 2026-10-18' };
    const t = readTags(tagMp3(FRAME, { ...tags, cover: { data: cover.buffer, mime: 'image/png' } }));
    expect({ ...t, cover: undefined }).toEqual({ ...tags, cover: undefined });
    expect(t.cover?.mime).toBe('image/png');
    expect(new Uint8Array(t.cover!.data)).toEqual(cover);
  });

  it('reads ID3v2.4 with UTF-8 and the recording date', () => {
    const t = readTags(id3v24([
      ['TIT2', [3, ...utf8('Größer')]],
      ['TDRC', [3, ...utf8('2019-05-12')]],
      ['COMM', [3, ...utf8('deu'), ...utf8('iTunNORM'), 0, ...utf8('x')]],
      ['COMM', [3, ...utf8('deu'), 0, ...utf8('Mt 5')]],
    ]));
    expect(t).toEqual({ title: 'Größer', year: 2019, comment: 'Mt 5' });
  });

  it('ignores files without an ID3v2 tag', () => {
    expect(readTags(FRAME)).toEqual({});
    expect(readTags(new Uint8Array([0x49, 0x44, 0x33, 2, 0, 0, 0, 0, 0, 0]))).toEqual({});
  });
});

describe('id3Length', () => {
  it('measures the tag including its header, from the first 10 bytes', () => {
    const cover = new Uint8Array(3000);
    cover.set([0x89, 0x50, 0x4e, 0x47]); // PNG signature
    const tagged = tagMp3(FRAME, { title: 'x', cover: { data: cover.buffer, mime: 'image/png' } });
    expect(id3Length(tagged.subarray(0, 10))).toBe(tagged.length - FRAME.length);
    expect(readTags(tagged.subarray(0, id3Length(tagged))).title).toBe('x');
    expect(id3Length(FRAME)).toBe(0);
  });
});
