// Incremental MPEG audio frame indexer.
// Builds a byte-offset table of all audio frames so later passes can seek
// sample-accurately: with gapless decoding disabled, mpg123 outputs exactly
// `spf` samples per audio frame and none for a Xing/Info/VBRI frame, so audio
// frame i starts at decoder sample i * spf.

const BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** mp3 decoder delay that mpg123 removes in addition to the encoder delay from the LAME tag. */
const DECODER_DELAY = 529;

export interface FrameHeader {
  version: number; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  layer: number; // 1, 2, 3
  sampleRate: number;
  channels: number;
  spf: number;
  length: number;
  crc: boolean;
}

export function parseHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3;
  const layerBits = (b[i + 1] >> 1) & 3;
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (version === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits;
  const pad = (b[i + 2] >> 1) & 1;
  const mode = b[i + 3] >> 6;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const v1 = version === 3;
  const table = v1 ? (layer === 1 ? BITRATES.v1l1 : layer === 2 ? BITRATES.v1l2 : BITRATES.v1l3)
    : (layer === 1 ? BITRATES.v2l1 : BITRATES.v2l23);
  const bitrate = table[brIdx] * 1000;
  let length: number, spf: number;
  if (layer === 1) { spf = 384; length = (Math.floor((12 * bitrate) / sampleRate) + pad) * 4; }
  else if (layer === 2 || v1) { spf = 1152; length = Math.floor((144 * bitrate) / sampleRate) + pad; }
  else { spf = 576; length = Math.floor((72 * bitrate) / sampleRate) + pad; }
  return { version, layer, sampleRate, channels: mode === 3 ? 1 : 2, spf, length, crc: (b[i + 1] & 1) === 0 };
}

export interface Mp3Info {
  kind: 'mp3';
  sampleRate: number;
  channels: number;
  spf: number;
  /** number of audio frames (info frame excluded) */
  frames: number;
  /** samples to drop at the start (encoder + decoder delay) so time 0 matches gapless playback */
  delay: number;
  /** trailing padding samples from the LAME tag */
  padding: number;
  /** byte offset of each audio frame, plus the end offset of the last frame (length frames + 1) */
  offsets: Uint32Array;
  /** decodable samples after the delay (incl. padding): the end of the timeline decodeRange can read */
  samples: number;
  duration: number;
}

export class Mp3Indexer {
  private pending = new Uint8Array(0);
  private pendingStart = 0;
  private skipUntil = 0;
  private synced = false;
  private first: FrameHeader | null = null;
  private offsets = new Uint32Array(1 << 16);
  private count = 0;
  private lastEnd = 0;
  private sawFrame = false;
  delay = 0;
  padding = 0;

  push(chunk: Uint8Array, final = false): void {
    let buf: Uint8Array;
    if (this.pending.length) {
      buf = new Uint8Array(this.pending.length + chunk.length);
      buf.set(this.pending);
      buf.set(chunk, this.pending.length);
    } else buf = chunk;
    const start = this.pendingStart;
    let i = 0;
    while (i + 4 <= buf.length) {
      const abs = start + i;
      if (abs < this.skipUntil) { i = Math.min(buf.length, this.skipUntil - start); continue; }
      if (!this.sawFrame && buf[i] === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33) {
        if (i + 10 > buf.length) break;
        const size = ((buf[i + 6] & 0x7f) << 21) | ((buf[i + 7] & 0x7f) << 14) | ((buf[i + 8] & 0x7f) << 7) | (buf[i + 9] & 0x7f);
        this.skipUntil = abs + 10 + size + (buf[i + 5] & 0x10 ? 10 : 0);
        continue;
      }
      const h = parseHeader(buf, i);
      if (h && h.length > 4 && (!this.first || (h.sampleRate === this.first.sampleRate && h.layer === this.first.layer))) {
        const nextPos = i + h.length;
        let ok = this.synced;
        if (!ok) {
          if (nextPos + 4 > buf.length) {
            if (!final) break; // need more data to validate the following header
            ok = nextPos <= buf.length;
          } else {
            const n = parseHeader(buf, nextPos);
            ok = !!n && n.sampleRate === h.sampleRate && n.layer === h.layer;
          }
        }
        if (ok && nextPos > buf.length) {
          if (!final) break; // frame continues in the next chunk
          ok = false; // truncated last frame
        }
        if (ok) {
          this.addFrame(buf, i, abs, h);
          i = nextPos;
          this.synced = true;
          continue;
        }
      }
      this.synced = false;
      i++;
    }
    this.pending = buf.slice(i);
    this.pendingStart = start + i;
  }

  private addFrame(buf: Uint8Array, i: number, abs: number, h: FrameHeader) {
    this.sawFrame = true;
    if (!this.first) {
      this.first = h;
      if (this.isInfoFrame(buf, i, h)) { this.lastEnd = abs + h.length; return; }
    }
    if (this.count + 1 >= this.offsets.length) {
      const n = new Uint32Array(this.offsets.length * 2);
      n.set(this.offsets);
      this.offsets = n;
    }
    this.offsets[this.count++] = abs;
    this.lastEnd = abs + h.length;
  }

  /** Detects Xing/Info/VBRI frames and reads encoder delay/padding from a LAME tag. */
  private isInfoFrame(b: Uint8Array, i: number, h: FrameHeader): boolean {
    const str = (p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));
    const side = h.version === 3 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
    const x = i + 4 + (h.crc ? 2 : 0) + side;
    const tag = str(x, 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = (b[x + 4] << 24) | (b[x + 5] << 16) | (b[x + 6] << 8) | b[x + 7];
      let p = x + 8 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
      if (p + 24 <= i + h.length && /^[A-Za-z]{4}/.test(str(p, 4)) && h.layer === 3) {
        const encDelay = (b[p + 21] << 4) | (b[p + 22] >> 4);
        this.padding = ((b[p + 22] & 0x0f) << 8) | b[p + 23];
        this.delay = encDelay + DECODER_DELAY;
      }
      return true;
    }
    return str(i + 36, 4) === 'VBRI';
  }

  finish(): Mp3Info {
    this.push(new Uint8Array(0), true);
    if (!this.first || this.count === 0) throw new Error('Keine MP3-Frames gefunden – ist das wirklich eine MP3-Datei?');
    const offsets = new Uint32Array(this.count + 1);
    offsets.set(this.offsets.subarray(0, this.count));
    offsets[this.count] = this.lastEnd;
    const { sampleRate, channels, spf } = this.first;
    const total = this.count * spf - this.delay - this.padding;
    return {
      kind: 'mp3', sampleRate, channels, spf, frames: this.count, delay: this.delay, padding: this.padding, offsets,
      samples: Math.max(0, this.count * spf - this.delay), duration: Math.max(0, total) / sampleRate,
    };
  }
}
