import {
  MALFORMED,
  PartsBuilder,
  asciiBytes,
  fourCC,
  hasAscii,
  joinParts,
  u32le,
  writeU32le,
  type Bytes,
  type FormatStrip,
} from './byte-parts';
import {
  isRotatedOrMirrored,
  orientationTiff,
  readTiffOrientation,
} from './exif-orientation';

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/** Chunks a decoder uses; EXIF, `XMP ` and unknown chunks are dropped. */
const KEPT_CHUNKS = new Set([
  'VP8X',
  'ICCP',
  'ANIM',
  'ANMF',
  'ALPH',
  'VP8 ',
  'VP8L',
]);

export function isWebp(bytes: Uint8Array): boolean {
  return hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP');
}

/**
 * Remove EXIF, XMP and unknown chunks from a WebP, then rewrite the VP8X feature flags and
 * the RIFF size to match. A non-default EXIF orientation survives as a new EXIF chunk
 * holding only that tag. Image, alpha, animation and ICC chunks are kept byte for byte.
 */
export function stripWebp(bytes: Bytes): FormatStrip {
  if (bytes.length < 20) return MALFORMED;
  const riffEnd = 8 + u32le(bytes, 4);
  if (riffEnd > bytes.length) return MALFORMED;

  // The VP8X chunk and RIFF header are rewritten, so the body is collected on its own.
  const body = new PartsBuilder(bytes);
  let vp8x: { readonly start: number; readonly end: number } | null = null;
  let keptExif = false;
  let seenExif = false;
  let pos = 12;

  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) return MALFORMED;
    const type = fourCC(bytes, pos);
    const size = u32le(bytes, pos + 4);
    const dataEnd = pos + 8 + size;
    const end = dataEnd + (size % 2);
    // The final pad byte may be missing; anything else past the RIFF end is not WebP.
    if (dataEnd > riffEnd || end > riffEnd + 1) return MALFORMED;

    if (type === 'VP8X') {
      if (pos !== 12 || size < 10) return MALFORMED;
      vp8x = { start: pos, end: Math.min(end, riffEnd) };
    } else if (type === 'EXIF') {
      body.drop();
      if (!seenExif && vp8x) {
        seenExif = true;
        const orientation = readTiffOrientation(
          exifTiff(bytes.subarray(pos + 8, dataEnd)),
        );
        // An unreadable Exif block is dropped whole: the container around it is sound.
        if (isRotatedOrMirrored(orientation)) {
          body.insert(chunk('EXIF', orientationTiff(orientation)));
          keptExif = true;
        }
      }
    } else if (KEPT_CHUNKS.has(type)) {
      body.keep(pos, Math.min(end, riffEnd));
    } else {
      body.drop();
    }
    pos = end;
  }
  if (riffEnd < bytes.length) body.drop(); // bytes after the RIFF container

  const stripped = body.result();
  if (stripped.kind !== 'stripped') return stripped;

  const header: Bytes[] = [];
  if (vp8x) {
    const chunkBytes = bytes.slice(vp8x.start, vp8x.end);
    const flags = (chunkBytes[8] ?? 0) & ~(VP8X_EXIF | VP8X_XMP);
    chunkBytes[8] = keptExif ? flags | VP8X_EXIF : flags;
    header.push(chunkBytes);
  }
  const parts = [...header, ...stripped.parts];
  const size = 4 + parts.reduce((sum, part) => sum + part.length, 0);
  return {
    kind: 'stripped',
    parts: [
      joinParts([asciiBytes('RIFF'), writeU32le(size), asciiBytes('WEBP')]),
      ...parts,
    ],
  };
}

/** WebP EXIF payloads are a bare TIFF, though some writers prefix "Exif\0\0". */
function exifTiff(payload: Bytes): Bytes {
  return hasAscii(payload, 0, 'Exif\0\0') ? payload.subarray(6) : payload;
}

function chunk(type: string, data: Bytes): Bytes {
  return joinParts([
    asciiBytes(type),
    writeU32le(data.length),
    data,
    data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0),
  ]);
}
