// ID3 tags for the finished MP3. Separate from the pipeline so the page can tag a file the worker
// encoded in advance, without loading the encoder.
import { ID3Writer } from 'browser-id3-writer';

export interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  comment?: string;
  cover?: { data: ArrayBuffer; mime: string };
}

export function tagMp3(mp3: Uint8Array, t: Tags): Uint8Array {
  const w = new ID3Writer(mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength));
  if (t.title) w.setFrame('TIT2', t.title);
  if (t.artist) w.setFrame('TPE1', [t.artist]);
  if (t.album) w.setFrame('TALB', t.album);
  if (t.year) w.setFrame('TYER', t.year);
  if (t.comment) w.setFrame('COMM', { description: '', text: t.comment, language: 'deu' });
  if (t.cover) w.setFrame('APIC', { type: 3, data: t.cover.data, description: 'Cover' });
  return new Uint8Array(w.addTag());
}
