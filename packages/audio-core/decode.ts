import { MPEGDecoder } from 'mpg123-decoder';
import type { Mp3Info } from './mp3-index';
import { wavToFloat, type WavInfo } from './wav';

/** What the passes need to know about the loaded file: an indexed MP3 or a WAV. */
export type AudioInfo = Mp3Info | WavInfo;

/** Random-access byte source: a File/Blob in the browser, a file handle in Node. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export const CHUNK_BYTES = 1 << 19;

/** Frames decoded before the requested start to refill the layer III bit reservoir. */
const PREROLL_FRAMES = 10;

export async function createDecoder(): Promise<MPEGDecoder> {
  // Gapless off: output is strictly frame-aligned, which makes seeking exact (see mp3-index.ts).
  const dec = new MPEGDecoder({ enableGapless: false });
  await dec.ready;
  return dec;
}

export type BlockFn = (channels: Float32Array[], sampleRate: number) => void | Promise<void>;

/**
 * Decodes the time range [t0, t1) (seconds, gapless timeline) and delivers it block by block.
 * Seeks via the frame index (MP3) or the sample offset (WAV), so only the requested part of the file is read.
 */
export async function decodeRange(src: ByteSource, info: AudioInfo, t0: number, t1: number, onBlock: BlockFn,
  onProgress?: (p: number) => void): Promise<void> {
  if (info.kind === 'wav') return readWavRange(src, info, t0, t1, onBlock, onProgress);
  const { sampleRate: sr, spf, delay, offsets, frames } = info;
  const s0 = Math.max(0, Math.round(t0 * sr) + delay);
  const s1 = Math.min(frames * spf, Math.round(t1 * sr) + delay);
  if (s1 <= s0) return;
  const f0 = Math.max(0, Math.floor(s0 / spf) - PREROLL_FRAMES);
  const f1 = Math.min(frames, Math.ceil(s1 / spf) + 1);
  // From frame 0 feed from the start of the file so mpg123 sees the ID3/info frame like during analysis.
  const b0 = f0 === 0 ? 0 : offsets[f0];
  const b1 = offsets[f1];
  let pos = f0 * spf;
  const dec = await createDecoder();
  try {
    for (let off = b0; off < b1 && pos < s1; off += CHUNK_BYTES) {
      const bytes = await src.read(off, Math.min(CHUNK_BYTES, b1 - off));
      const out = dec.decode(bytes);
      const n = out.samplesDecoded;
      if (n > 0) {
        const a = Math.max(0, s0 - pos), b = Math.min(n, s1 - pos);
        if (b > a) await onBlock(out.channelData.map(c => c.subarray(a, b)), sr);
        pos += n;
      }
      onProgress?.(Math.min(1, (pos - s0) / (s1 - s0)));
    }
  } finally {
    dec.free();
  }
}

async function readWavRange(src: ByteSource, info: WavInfo, t0: number, t1: number, onBlock: BlockFn,
  onProgress?: (p: number) => void): Promise<void> {
  const sr = info.sampleRate;
  const s0 = Math.max(0, Math.round(t0 * sr)), s1 = Math.min(info.samples, Math.round(t1 * sr));
  const per = Math.max(1, Math.floor(CHUNK_BYTES / info.blockAlign));
  for (let s = s0; s < s1; s += per) {
    const n = Math.min(per, s1 - s);
    const chs = wavToFloat(info, await src.read(info.dataOffset + s * info.blockAlign, n * info.blockAlign));
    if (chs[0].length) await onBlock(chs, sr);
    onProgress?.(Math.min(1, (s + n - s0) / (s1 - s0)));
    if (chs[0].length < n) break; // file shorter than its header says
  }
}

export function downmix(ch: Float32Array[]): Float32Array {
  if (ch.length === 1) return ch[0];
  const [l, r] = ch, out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = 0.5 * (l[i] + r[i]);
  return out;
}
