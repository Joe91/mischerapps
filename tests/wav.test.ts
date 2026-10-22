import { describe, expect, it } from 'vitest';
import { parseWav, wavToFloat } from '../packages/audio-core/wav';
import { decodeRange, type ByteSource } from '../packages/audio-core/decode';
import { analyzeSource, measure, sourceReader } from '../packages/audio-core/pipeline';

interface WavOpts { bits?: number; float?: boolean; extensible?: boolean; rf64?: boolean; dataSize?: number; channels?: number; }

/** A WAV file as a desk might write it: a LIST chunk of odd length before the data. */
function writeWav(chs: Float32Array[], sr: number, o: WavOpts = {}): Uint8Array {
  const bits = o.bits ?? 16, nch = o.channels ?? chs.length, bytes = bits / 8, n = chs[0].length;
  const fmtLen = o.extensible ? 40 : 16, dataLen = n * nch * bytes;
  const list = new TextEncoder().encode('LIST\x05\0\0\0INFOx\0'); // 5 bytes + pad byte
  const ds64 = o.rf64 ? 8 + 28 : 0;
  const buf = new Uint8Array(12 + ds64 + 8 + fmtLen + list.length + 8 + dataLen);
  const v = new DataView(buf.buffer), str = (p: number, t: string) => [...t].forEach((c, i) => { buf[p + i] = c.charCodeAt(0); });
  let p = 0;
  str(0, o.rf64 ? 'RF64' : 'RIFF'); v.setUint32(4, o.rf64 ? 0xffffffff : buf.length - 8, true); str(8, 'WAVE'); p = 12;
  if (o.rf64) { str(p, 'ds64'); v.setUint32(p + 4, 28, true); v.setUint32(p + 16, dataLen, true); p += 36; }
  str(p, 'fmt '); v.setUint32(p + 4, fmtLen, true);
  const code = o.float ? 3 : 1;
  v.setUint16(p + 8, o.extensible ? 0xfffe : code, true); v.setUint16(p + 10, nch, true); v.setUint32(p + 12, sr, true);
  v.setUint32(p + 16, sr * nch * bytes, true); v.setUint16(p + 20, nch * bytes, true); v.setUint16(p + 22, bits, true);
  if (o.extensible) { v.setUint16(p + 24, 22, true); v.setUint16(p + 32, code, true); }
  p += 8 + fmtLen;
  buf.set(list, p); p += list.length;
  str(p, 'data'); v.setUint32(p + 4, o.rf64 ? 0xffffffff : o.dataSize ?? dataLen, true); p += 8;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const x = chs[Math.min(c, chs.length - 1)][i];
    if (o.float && bits === 32) v.setFloat32(p, x, true);
    else if (o.float) v.setFloat64(p, x, true);
    else if (bits === 8) v.setUint8(p, Math.round(x * 127) + 128);
    else if (bits === 16) v.setInt16(p, Math.round(x * 32767), true);
    else if (bits === 24) { const s = Math.round(x * 8388607); buf[p] = s & 255; buf[p + 1] = (s >> 8) & 255; buf[p + 2] = (s >> 16) & 255; }
    else v.setInt32(p, Math.round(x * 2147483647), true);
    p += bytes;
  }
  return buf;
}

const source = (b: Uint8Array): ByteSource => ({ size: b.length, read: async (off, len) => b.subarray(off, off + len) });
const ramp = (n: number, f = 1) => new Float32Array(n).map((_, i) => 0.8 * Math.sin(i * 0.01 * f));

describe('parseWav', () => {
  it('finds the data after other chunks of odd length', async () => {
    const b = writeWav([ramp(1000), ramp(1000, 2)], 48000);
    const info = await parseWav(source(b));
    expect(info).toMatchObject({ kind: 'wav', sampleRate: 48000, channels: 2, bits: 16, samples: 1000, dataOffset: b.length - 4000 });
  });

  it.each([
    ['8 bit', { bits: 8 }, 0.02], ['16 bit', { bits: 16 }, 1e-4], ['24 bit', { bits: 24 }, 1e-6], ['32 bit', { bits: 32 }, 1e-8],
    ['float 32', { bits: 32, float: true }, 1e-7], ['float 64', { bits: 64, float: true }, 1e-12],
    ['extensible 24 bit', { bits: 24, extensible: true }, 1e-6], ['RF64', { rf64: true }, 1e-4],
  ])('reads %s', async (_, o, tol) => {
    const x = ramp(500);
    const b = writeWav([x], 44100, o as WavOpts), info = await parseWav(source(b));
    expect(info.samples).toBe(500);
    const y = wavToFloat(info, b.subarray(info.dataOffset))[0];
    expect(Math.max(...y.map((v, i) => Math.abs(v - x[i])))).toBeLessThan(tol);
  });

  it('reads recordings that were not finalised up to the end of the file', async () => {
    expect((await parseWav(source(writeWav([ramp(800)], 48000, { dataSize: 0 })))).samples).toBe(800);
    expect((await parseWav(source(writeWav([ramp(800)], 48000, { dataSize: 1e9 })))).samples).toBe(800);
  });

  it('explains what it cannot read', async () => {
    await expect(parseWav(source(writeWav([ramp(10)], 48000, { channels: 8 })))).rejects.toThrow(/8 Kanäle/);
    await expect(parseWav(source(new Uint8Array(100)))).rejects.toThrow(/Keine WAV-Datei/);
  });
});

describe('WAV input', () => {
  const sr = 48000, l = ramp(sr * 12), r = ramp(sr * 12, 3);
  const b = writeWav([l, r], sr, { bits: 24 }), src = source(b);

  it('decodes any range sample-exactly, across read chunks', async () => {
    const info = await parseWav(src);
    const got: number[] = [];
    await decodeRange(src, info, 2.5, 9.25, chs => { expect(chs.length).toBe(2); got.push(...chs[1]); });
    expect(got.length).toBe(Math.round(9.25 * sr) - Math.round(2.5 * sr));
    expect(Math.abs(got[12345] - r[Math.round(2.5 * sr) + 12345])).toBeLessThan(1e-6);
  });

  it('is analysed and measured like an MP3', async () => {
    const a = await analyzeSource(src);
    expect(a.info.kind).toBe('wav');
    expect(a.info.duration).toBe(12);
    expect(a.peaks.length).toBeGreaterThan(590);
    const o = { start: 1, end: 11, channels: 1 as const, targetLufs: -19, truePeakDb: -1.5, highpass: true, compressor: false, denoise: false, fadeIn: 0.5, fadeOut: 0.5, maxGainDb: 20 };
    const m = await measure(sourceReader(src, a.info, 1, 11), o, { kbps: 96 }, { loudness: a.loudness });
    expect(Math.abs(m.predictedLufs + 19)).toBeLessThan(0.3);
  });
});
