// ID3 tags for the finished MP3. Separate from the pipeline so the page can tag a file the worker
// encoded in advance, without loading the encoder.
import { ID3Writer } from 'browser-id3-writer';

export interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  /** "Album-Interpret" (TPE2): groups all sermons in players */
  albumArtist?: string;
  genre?: string;
  year?: number;
  /** YYYY-MM-DD, written as year (TYER) and day (TDAT) */
  date?: string;
  comment?: string;
  /** number within the album (the sermon series) */
  track?: number;
  cover?: { data: ArrayBuffer; mime: string };
}

export function tagMp3(mp3: Uint8Array, t: Tags): Uint8Array {
  const w = new ID3Writer(mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength));
  if (t.title) w.setFrame('TIT2', t.title);
  if (t.artist) w.setFrame('TPE1', [t.artist]);
  if (t.album) w.setFrame('TALB', t.album);
  if (t.albumArtist) w.setFrame('TPE2', t.albumArtist);
  if (t.genre) w.setFrame('TCON', [t.genre]);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date ?? '');
  if (day) {
    w.setFrame('TYER', Number(day[1]));
    w.setFrame('TDAT', day[3] + day[2]); // DDMM
  } else if (t.year) w.setFrame('TYER', t.year);
  if (t.comment) w.setFrame('COMM', { description: '', text: t.comment, language: 'deu' });
  if (t.track) w.setFrame('TRCK', String(t.track));
  if (t.cover) w.setFrame('APIC', { type: 3, data: t.cover.data, description: 'Cover' });
  return new Uint8Array(w.addTag());
}

const ENCODINGS = ['latin1', 'utf-16', 'utf-16be', 'utf-8'];

/** Text of an ID3 frame in encoding `enc` (0 Latin-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8), up to the first terminator. */
function decodeText(enc: number, b: Uint8Array): string {
  let label = ENCODINGS[enc] ?? 'latin1';
  if (enc === 1 && b[0] === 0xfe && b[1] === 0xff) label = 'utf-16be';
  if (enc === 1 && b[0] === 0xff && b[1] === 0xfe) label = 'utf-16le';
  return new TextDecoder(label).decode(b).replace(/^﻿/, '').split('\0')[0];
}

/** Index just behind the terminator (one zero byte, two for UTF-16) starting at `from`. */
function skipTerminated(enc: number, b: Uint8Array, from: number): number {
  const wide = enc === 1 || enc === 2;
  for (let i = from; i < b.length; i += wide ? 2 : 1) {
    if (b[i] === 0 && (!wide || b[i + 1] === 0)) return i + (wide ? 2 : 1);
  }
  return b.length;
}

/** Length of the ID3v2 tag at the start of `head` (at least its first 10 bytes) including the header; 0 without a tag. */
export function id3Length(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  return 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f)) + (head[5] & 0x10 ? 10 : 0);
}

/**
 * Reads the tags tagMp3 writes (title, artist, album, album artist, genre, year/date, comment, track, cover) from an ID3v2.3/2.4 tag at
 * the start of an MP3. Other frames, ID3v1 and unusual tags (unsynchronised, compressed) are ignored.
 */
export function readTags(file: Uint8Array): Tags {
  const t: Tags = {};
  if (!id3Length(file)) return t;
  const version = file[3], flags = file[5];
  if ((version !== 3 && version !== 4) || flags & 0x80) return t;
  const synchsafe = (i: number) => (file[i] & 0x7f) << 21 | (file[i + 1] & 0x7f) << 14 | (file[i + 2] & 0x7f) << 7 | (file[i + 3] & 0x7f);
  const u32 = (i: number) => (file[i] << 24 | file[i + 1] << 16 | file[i + 2] << 8 | file[i + 3]) >>> 0;
  const end = Math.min(file.length, 10 + synchsafe(6));
  let pos = 10;
  if (flags & 0x40) pos += version === 4 ? synchsafe(10) : 4 + u32(10); // extended header

  let comment: string | undefined, cover: Tags['cover'] | undefined, ddmm = '';
  while (pos + 10 <= end) {
    const id = String.fromCharCode(...file.subarray(pos, pos + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    const size = version === 4 ? synchsafe(pos + 4) : u32(pos + 4);
    const format = file[pos + 9];
    const b = file.subarray(pos + 10, Math.min(end, pos + 10 + size));
    pos += 10 + size;
    if (!b.length || format & (version === 4 ? 0x0f : 0xe0)) continue; // compressed, encrypted, …
    const enc = b[0];
    if (id === 'TIT2') t.title = decodeText(enc, b.subarray(1));
    else if (id === 'TPE1') t.artist = decodeText(enc, b.subarray(1));
    else if (id === 'TALB') t.album = decodeText(enc, b.subarray(1));
    else if (id === 'TPE2') t.albumArtist = decodeText(enc, b.subarray(1));
    else if (id === 'TCON') t.genre = decodeText(enc, b.subarray(1)).replace(/^\(\d+\)/, '') || undefined; // "(101)Speech"
    else if (id === 'TDAT') ddmm = decodeText(enc, b.subarray(1));
    else if (id === 'TYER' || id === 'TDRC') {
      const v = decodeText(enc, b.subarray(1));
      t.year = Number(v.slice(0, 4)) || undefined;
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) t.date = v.slice(0, 10); // ID3v2.4: full date in TDRC
    }
    else if (id === 'TRCK') t.track = parseInt(decodeText(enc, b.subarray(1)), 10) || undefined; // "4" or "4/8"
    else if (id === 'COMM') {
      // language (3 bytes), description, text; prefer the comment without description (the one tagMp3 writes)
      const textAt = skipTerminated(enc, b, 4);
      const text = decodeText(enc, b.subarray(textAt));
      if (comment === undefined || textAt === 4 + (enc === 1 || enc === 2 ? 2 : 1)) comment = text;
    } else if (id === 'APIC') {
      // MIME type (Latin-1), picture type, description, image; prefer the front cover (type 3)
      const typeAt = skipTerminated(0, b, 1);
      const mime = decodeText(0, b.subarray(1, typeAt)) || 'image/jpeg';
      const data = new Uint8Array(b.subarray(skipTerminated(enc, b, typeAt + 1))).buffer; // a copy (Buffer.slice would share)
      if (!cover || b[typeAt] === 3) cover = { data, mime: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` };
    }
  }
  if (comment) t.comment = comment;
  if (t.year && /^\d{4}$/.test(ddmm)) t.date = `${t.year}-${ddmm.slice(2)}-${ddmm.slice(0, 2)}`;
  if (cover) t.cover = cover;
  for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre'] as const) if (!t[k]) delete t[k];
  return t;
}
