// Untrusted image validation and derivative generation (ME-02, ME-03, ME-04).
//  - real type sniffed from bytes (file-type); only JPEG/PNG; must match the declared type
//  - polyglot trailers (ZIP/HTML/script/PDF/PE appended after the image end marker) rejected
//  - decoded with sharp under a pixel limit (decompression-bomb guard); any decode failure rejects
//  - derivatives are re-encoded from decoded pixels: auto-oriented, sRGB, all metadata stripped
import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata, type Sharp } from 'sharp';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_SIDE = 12_000;
export const MIN_SIDE = 16;
export const TRANSFORM_VERSION = 1;
export const ALLOWED_MIME = ['image/jpeg', 'image/png'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export type DerivativeVariant = 'thumb' | 'preview' | 'jpeg_publish';

export interface Derivative {
  variant: DerivativeVariant;
  mime: string;
  ext: string;
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export type ProcessResult =
  | { ok: true; mime: AllowedMime; width: number; height: number; bytes: number; sha256: string; derivatives: Derivative[] }
  | { ok: false; reason: string; code: string };

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const POLYGLOT_SIGNATURES: Array<{ re: RegExp; label: string }> = [
  { re: /PK\x03\x04/, label: 'ZIP archive' },
  { re: /<\s*(script|html|svg|iframe|body|\?php)/i, label: 'markup or script' },
  { re: /%PDF-/, label: 'PDF document' },
  { re: /^MZ/, label: 'executable' },
  { re: /\x7fELF/, label: 'executable' },
];

/** Offset just past the PNG IEND chunk, walking the chunk structure; null if malformed. */
function pngEnd(buf: Buffer): number | null {
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const next = pos + 12 + len;
    if (len > 0x7fffffff || next > buf.length) return null;
    if (type === 'IEND') return next;
    pos = next;
  }
  return null;
}

/** Offset just past the JPEG EOI marker, walking segments and entropy-coded data; null if malformed. */
function jpegEnd(buf: Buffer): number | null {
  let pos = 2; // after SOI
  while (pos + 1 < buf.length) {
    if (buf[pos] !== 0xff) return null;
    while (buf[pos] === 0xff && pos + 1 < buf.length && buf[pos + 1] === 0xff) pos++; // fill bytes
    const m = buf[pos + 1]!;
    if (m === 0xd9) return pos + 2;
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { pos += 2; continue; }
    if (pos + 3 >= buf.length) return null;
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) return null;
    pos += 2 + len;
    if (pos > buf.length) return null;
    if (m === 0xda) {
      // Entropy-coded data: runs until a marker that is not a stuffed 0xFF00 or a restart marker.
      while (pos + 1 < buf.length) {
        if (buf[pos] === 0xff) {
          const n = buf[pos + 1]!;
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        pos++;
      }
    }
  }
  return null;
}

/** Bytes after the image's real end (PNG IEND chunk / JPEG EOI), or null when not locatable. */
function trailer(buf: Buffer, mime: AllowedMime): Buffer | null {
  const end = mime === 'image/png' ? pngEnd(buf) : jpegEnd(buf);
  return end === null ? null : buf.subarray(end);
}

function reject(code: string, reason: string): ProcessResult {
  return { ok: false, code, reason };
}

export async function processImage(input: Buffer, declaredMime: string | null): Promise<ProcessResult> {
  if (input.length === 0) return reject('empty', 'The file is empty.');
  if (input.length > MAX_UPLOAD_BYTES) return reject('too_large', 'The file is larger than 20 MB.');

  const sniffed = await fileTypeFromBuffer(input).catch(() => undefined);
  if (!sniffed || !(ALLOWED_MIME as readonly string[]).includes(sniffed.mime)) {
    const what = sniffed ? sniffed.ext.toUpperCase() : 'not a recognised image';
    return reject('unsupported_type', `Only JPEG and PNG images are supported (this file is ${what}).`);
  }
  const mime = sniffed.mime as AllowedMime;
  if (declaredMime && declaredMime !== mime) {
    return reject('type_mismatch', `The file content (${mime}) does not match its declared type (${declaredMime}).`);
  }

  const tail = trailer(input, mime);
  if (tail === null) return reject('malformed', 'The image is incomplete or malformed.');
  if (tail.length > 0) {
    const text = tail.subarray(0, 64 * 1024).toString('latin1');
    const hit = POLYGLOT_SIGNATURES.find((s) => s.re.test(text));
    if (hit) return reject('polyglot', `The image contains hidden extra content (${hit.label}) and was rejected.`);
    if (mime === 'image/png' && tail.length > 1024) return reject('polyglot', 'The image contains unexpected data after its end and was rejected.');
  }

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false, failOn: 'error' }).metadata();
  } catch {
    return reject('malformed', 'The image could not be read. It may be corrupted.');
  }
  const expectedFormat = mime === 'image/png' ? 'png' : 'jpeg';
  if (meta.format !== expectedFormat || !meta.width || !meta.height) {
    return reject('malformed', 'The image could not be read. It may be corrupted.');
  }
  if (meta.width * meta.height > MAX_INPUT_PIXELS || meta.width > MAX_SIDE || meta.height > MAX_SIDE) {
    return reject('dimensions_too_large', `The image is too large (${meta.width}×${meta.height}). The maximum is ${MAX_INPUT_PIXELS / 1e6} megapixels and ${MAX_SIDE}px per side.`);
  }
  if (meta.width < MIN_SIDE || meta.height < MIN_SIDE) {
    return reject('dimensions_too_small', `The image is too small (${meta.width}×${meta.height}). The minimum is ${MIN_SIDE}px per side.`);
  }
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', autoOrient: true, sequentialRead: true });
  const specs: Array<{ variant: DerivativeVariant; size: number; mime: string; ext: string; encode: (s: Sharp) => Sharp }> = [
    { variant: 'thumb', size: 400, mime: 'image/webp', ext: 'webp', encode: (s) => s.webp({ quality: 78 }) },
    { variant: 'preview', size: 1600, mime: 'image/webp', ext: 'webp', encode: (s) => s.webp({ quality: 82 }) },
    { variant: 'jpeg_publish', size: 4096, mime: 'image/jpeg', ext: 'jpg',
      encode: (s) => s.flatten({ background: '#ffffff' }).jpeg({ quality: 90, chromaSubsampling: '4:2:0', mozjpeg: false }) },
  ];

  const derivatives: Derivative[] = [];
  try {
    for (const spec of specs) {
      // No withMetadata()/keepMetadata(): sharp strips EXIF/XMP/IPTC/ICC and converts to sRGB by default.
      const pipeline = spec.encode(base().resize({ width: spec.size, height: spec.size, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb'));
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      derivatives.push({ variant: spec.variant, mime: spec.mime, ext: spec.ext, data, width: info.width, height: info.height, bytes: data.length, sha256: sha256Hex(data) });
    }
  } catch {
    return reject('malformed', 'The image could not be decoded. It may be corrupted or not a real image.');
  }

  return { ok: true, mime, width, height, bytes: input.length, sha256: sha256Hex(input), derivatives };
}
