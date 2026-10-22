// WAV input (recordings straight from the mixing desk): header parsing and sample conversion.
// The samples are read from the file range by range, so even recordings of several GB never sit in memory.
import type { ByteSource } from './decode';

export interface WavInfo {
  kind: 'wav';
  sampleRate: number;
  channels: number;
  bits: number;
  float: boolean;
  /** bytes per sample frame (all channels) */
  blockAlign: number;
  /** byte offset of the first sample */
  dataOffset: number;
  samples: number;
  duration: number;
}

const ascii = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** Is this a RIFF/RF64/BW64 WAVE file? (first 12 bytes) */
export function isWav(head: Uint8Array): boolean {
  return head.length >= 12 && ['RIFF', 'RF64', 'BW64'].includes(ascii(head, 0)) && ascii(head, 8) === 'WAVE';
}

/**
 * Reads the chunk list up to the sample data. Supports PCM 8/16/24/32 bit, float 32/64 bit, the
 * extensible format and RF64/BW64 (> 4 GB). A data size of 0 or beyond the end of the file (recording
 * not finalised, e.g. power cut on the desk) is taken as "until the end of the file".
 */
export async function parseWav(src: ByteSource): Promise<WavInfo> {
  const head = await src.read(0, 12);
  if (!isWav(head)) throw new Error('Keine WAV-Datei.');
  let pos = 12, fmt: DataView | null = null, ds64Data = -1;
  for (;;) {
    if (pos + 8 > src.size) throw new Error('Die WAV-Datei enthält keine Audiodaten.');
    const ch = await src.read(pos, 8);
    const id = ascii(ch, 0), size = new DataView(ch.buffer, ch.byteOffset, 8).getUint32(4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      const b = await src.read(body, Math.min(size, 40));
      fmt = new DataView(b.buffer, b.byteOffset, b.length);
    } else if (id === 'ds64') {
      const b = await src.read(body, 16), v = new DataView(b.buffer, b.byteOffset, 16);
      ds64Data = v.getUint32(8, true) + v.getUint32(12, true) * 2 ** 32;
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV-Datei ohne Formatangabe (fmt).');
      let bytes = size === 0xffffffff && ds64Data >= 0 ? ds64Data : size;
      if (bytes === 0 || body + bytes > src.size) bytes = src.size - body;
      return describe(fmt, body, bytes);
    }
    pos = body + size + (size & 1); // chunks are padded to even length
  }
}

function describe(fmt: DataView, dataOffset: number, bytes: number): WavInfo {
  let format = fmt.getUint16(0, true);
  const channels = fmt.getUint16(2, true), sampleRate = fmt.getUint32(4, true);
  const blockAlign = fmt.getUint16(12, true), bits = fmt.getUint16(14, true);
  if (format === 0xfffe && fmt.byteLength >= 26) format = fmt.getUint16(24, true); // sub-format GUID starts with the format code
  const float = format === 3;
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(float && (bits === 32 || bits === 64))) {
    throw new Error(`Dieses WAV-Format wird nicht unterstützt (Format ${format}, ${bits} Bit). Möglich sind PCM 8–32 Bit und Float 32/64 Bit.`);
  }
  if (channels < 1 || channels > 2) {
    throw new Error(`Die WAV-Datei hat ${channels} Kanäle – bitte eine Mono- oder Stereo-Aufnahme (Summe) verwenden.`);
  }
  if (!sampleRate || blockAlign !== channels * (bits / 8)) throw new Error('Die WAV-Datei hat einen ungültigen Kopf.');
  const samples = Math.floor(bytes / blockAlign);
  return { kind: 'wav', sampleRate, channels, bits, float, blockAlign, dataOffset, samples, duration: samples / sampleRate };
}

/** Converts whole sample frames (interleaved, little endian) into one Float32Array per channel. */
export function wavToFloat(info: WavInfo, b: Uint8Array): Float32Array[] {
  const n = Math.floor(b.length / info.blockAlign), nch = info.channels, bytes = info.bits / 8;
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  const out = Array.from({ length: nch }, () => new Float32Array(n));
  for (let ch = 0; ch < nch; ch++) {
    const o = out[ch];
    let p = ch * bytes;
    const step = info.blockAlign;
    if (info.float) {
      if (info.bits === 32) for (let i = 0; i < n; i++, p += step) o[i] = v.getFloat32(p, true);
      else for (let i = 0; i < n; i++, p += step) o[i] = v.getFloat64(p, true);
    } else if (info.bits === 16) for (let i = 0; i < n; i++, p += step) o[i] = v.getInt16(p, true) / 32768;
    else if (info.bits === 24) {
      for (let i = 0; i < n; i++, p += step) o[i] = ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) / 8388608;
    } else if (info.bits === 32) for (let i = 0; i < n; i++, p += step) o[i] = v.getInt32(p, true) / 2147483648;
    else for (let i = 0; i < n; i++, p += step) o[i] = (b[p] - 128) / 128;
  }
  return out;
}
