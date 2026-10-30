/**
 * Image size gate for the OpenRouter decisions API (Jev). Live probe 2026-10-30: each side must
 * be 280–1568 px, otherwise the whole decision answers 400 "Invalid image dimensions."
 * (210x126 / 279x600 / 1569x600 / 1920x1080 rejected; 280x1568 / 1568x1568 accepted).
 *
 * In-range or unreadable images pass through unchanged. Out-of-range PNGs (pasted screenshots)
 * are rescaled here without native dependencies; other out-of-range formats are dropped so the
 * decision still runs on the text state instead of failing.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export const DECISION_IMAGE_MIN_SIDE = 280;
export const DECISION_IMAGE_MAX_SIDE = 1568;
/** Decoding guard: larger screenshots than ~6K are dropped instead of decoded. */
const MAX_DECODE_PIXELS = 40_000_000;

export type DecisionImageFit = { images: string[]; resized: number; dropped: number };

type Parsed = { mime: string; bytes: Buffer };

function parseDataUrl(url: string): Parsed | null {
  const m = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,(.*)$/is.exec(url);
  if (!m) return null;
  try {
    return { mime: m[1].toLowerCase(), bytes: Buffer.from(m[2], 'base64') };
  } catch {
    return null;
  }
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Width/height from the file header (PNG, JPEG, GIF, WebP). null = unknown. */
export function readImageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIG)) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString('latin1', 0, 4) === 'GIF8') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const kind = bytes.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = bytes.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = bytes.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export function fitsDecisionImage(size: { width: number; height: number }): boolean {
  const lo = Math.min(size.width, size.height);
  const hi = Math.max(size.width, size.height);
  return lo >= DECISION_IMAGE_MIN_SIDE && hi <= DECISION_IMAGE_MAX_SIDE;
}

/** Target canvas: scale into 280–1568, pad the short side when the aspect ratio is extreme. */
export function decisionImageTarget(width: number, height: number): { width: number; height: number; canvasWidth: number; canvasHeight: number } {
  let scale = 1;
  const lo = Math.min(width, height);
  const hi = Math.max(width, height);
  if (lo < DECISION_IMAGE_MIN_SIDE) scale = DECISION_IMAGE_MIN_SIDE / lo;
  if (hi * scale > DECISION_IMAGE_MAX_SIDE) scale = DECISION_IMAGE_MAX_SIDE / hi;
  const clamp = (n: number) => Math.max(1, Math.min(DECISION_IMAGE_MAX_SIDE, Math.round(n)));
  const w = clamp(width * scale);
  const h = clamp(height * scale);
  return { width: w, height: h, canvasWidth: Math.max(w, DECISION_IMAGE_MIN_SIDE), canvasHeight: Math.max(h, DECISION_IMAGE_MIN_SIDE) };
}

type Rgba = { width: number; height: number; data: Uint8Array };

/** Non-interlaced 8/16-bit PNG (and 1–8-bit palette) → RGBA. null = unsupported. */
export function decodePng(bytes: Buffer): Rgba | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIG)) return null;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('latin1', off + 4, off + 8);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height || interlace !== 0 || width * height > MAX_DECODE_PIXELS) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels) return null;
  if (color === 3 ? ![1, 2, 4, 8].includes(depth) || !palette : depth !== 8 && depth !== 16) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < (stride + 1) * height) return null;
  const lines = Buffer.alloc(stride * height);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = lines.subarray(y * stride, (y + 1) * stride);
    const up = y ? lines.subarray((y - 1) * stride, y * stride) : prev;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = up[x];
      const c = x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      line[x] = v & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  const step = depth === 16 ? 2 : 1;
  for (let y = 0; y < height; y += 1) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const per = 8 / depth;
        const byte = line[Math.floor(x / per)];
        const idx = (byte >> ((per - 1 - (x % per)) * depth)) & ((1 << depth) - 1);
        out[o] = palette![idx * 3] ?? 0; out[o + 1] = palette![idx * 3 + 1] ?? 0; out[o + 2] = palette![idx * 3 + 2] ?? 0;
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        continue;
      }
      const s = x * channels * step;
      const ch = (k: number) => line[s + k * step];
      if (color === 0 || color === 4) {
        out[o] = out[o + 1] = out[o + 2] = ch(0);
        out[o + 3] = color === 4 ? ch(1) : 255;
      } else {
        out[o] = ch(0); out[o + 1] = ch(1); out[o + 2] = ch(2);
        out[o + 3] = color === 6 ? ch(3) : 255;
      }
    }
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rowLen = img.width * 4;
  const raw = Buffer.alloc((rowLen + 1) * img.height);
  for (let y = 0; y < img.height; y += 1) {
    Buffer.from(img.data.buffer, img.data.byteOffset + y * rowLen, rowLen).copy(raw, y * (rowLen + 1) + 1);
  }
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Box average when shrinking, nearest when enlarging; centred on a white canvas. */
export function resizeForDecision(src: Rgba): Rgba {
  const t = decisionImageTarget(src.width, src.height);
  const out = new Uint8Array(t.canvasWidth * t.canvasHeight * 4).fill(255);
  const ox = (t.canvasWidth - t.width) >> 1;
  const oy = (t.canvasHeight - t.height) >> 1;
  const sx = src.width / t.width;
  const sy = src.height / t.height;
  for (let y = 0; y < t.height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < t.width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3]; n += 1;
        }
      }
      const o = ((y + oy) * t.canvasWidth + (x + ox)) * 4;
      const alpha = a / n / 255;
      // Flatten transparency onto the white canvas so padded and transparent areas match.
      out[o] = Math.round((r / n) * alpha + 255 * (1 - alpha));
      out[o + 1] = Math.round((g / n) * alpha + 255 * (1 - alpha));
      out[o + 2] = Math.round((b / n) * alpha + 255 * (1 - alpha));
      out[o + 3] = 255;
    }
  }
  return { width: t.canvasWidth, height: t.canvasHeight, data: out };
}

export function fitDecisionImages(urls: readonly string[]): DecisionImageFit {
  const images: string[] = [];
  let resized = 0;
  let dropped = 0;
  for (const url of urls) {
    const parsed = parseDataUrl(url);
    const size = parsed ? readImageSize(parsed.bytes) : null;
    if (!parsed || !size || fitsDecisionImage(size)) {
      images.push(url);
      continue;
    }
    const decoded = parsed.mime === 'image/png' || parsed.bytes.subarray(0, 8).equals(PNG_SIG) ? decodePng(parsed.bytes) : null;
    if (!decoded) {
      dropped += 1;
      continue;
    }
    images.push(`data:image/png;base64,${encodePng(resizeForDecision(decoded)).toString('base64')}`);
    resized += 1;
  }
  return { images, resized, dropped };
}
