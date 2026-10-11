import {
  MALFORMED,
  PartsBuilder,
  asciiBytes,
  fourCC,
  joinParts,
  u32be,
  writeU32be,
  type Bytes,
  type FormatStrip,
} from './byte-parts';
import {
  isRotatedOrMirrored,
  orientationTiff,
  readTiffOrientation,
} from './exif-orientation';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Ancillary chunks that affect how the image is decoded or displayed. Critical chunks
 * (IHDR, PLTE, IDAT, IEND and any unknown upper-case one) are always kept. Every other
 * ancillary chunk is dropped: text (tEXt/zTXt/iTXt, which also carry XMP), eXIf, tIME,
 * C2PA manifests (caBX) and private chunks. Apple's iDOT is dropped on purpose: its
 * offsets are relative to its own position and would be wrong once chunks before IDAT go.
 */
const KEPT_ANCILLARY = new Set([
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'cICP',
  'mDCV',
  'cLLI',
  'sBIT',
  'bKGD',
  'pHYs',
  'hIST',
  'sPLT',
  'oFFs',
  'sCAL',
  'acTL',
  'fcTL',
  'fdAT',
]);

export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/**
 * Remove text, time and Exif chunks from a PNG (or APNG) without touching its pixels. A
 * non-default eXIf orientation survives as a new eXIf chunk holding only that tag. Bytes
 * after IEND are dropped.
 */
export function stripPng(bytes: Bytes): FormatStrip {
  const out = new PartsBuilder(bytes);
  const n = bytes.length;
  out.keep(0, SIGNATURE.length);
  let pos: number = SIGNATURE.length;
  let seenExif = false;

  for (let index = 0; ; index++) {
    out.step();
    if (pos + 12 > n) return MALFORMED;
    const length = u32be(bytes, pos);
    const type = fourCC(bytes, pos + 4);
    const end = pos + 12 + length;
    if (length > 0x7fffffff || end > n || !/^[A-Za-z]{4}$/u.test(type)) {
      return MALFORMED;
    }
    if (index === 0 && type !== 'IHDR') return MALFORMED;

    if (type === 'IEND') {
      out.keep(pos, end);
      if (end < n) out.drop();
      return out.result();
    }

    if (type === 'eXIf') {
      out.drop();
      if (!seenExif) {
        seenExif = true;
        const orientation = readTiffOrientation(
          bytes.subarray(pos + 8, pos + 8 + length),
        );
        // An unreadable Exif block is dropped whole: the container around it is sound.
        if (isRotatedOrMirrored(orientation)) {
          out.insert(chunk('eXIf', orientationTiff(orientation)));
        }
      }
    } else if (isCritical(type) || KEPT_ANCILLARY.has(type)) {
      out.keep(pos, end);
    } else {
      out.drop();
    }
    pos = end;
  }
}

function isCritical(type: string): boolean {
  const first = type.charCodeAt(0);
  return first >= 0x41 && first <= 0x5a; // upper-case first letter
}

function chunk(type: string, data: Bytes): Bytes {
  const typed = joinParts([asciiBytes(type), data]);
  return joinParts([writeU32be(data.length), typed, writeU32be(crc32(typed))]);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (ISO 3309), as PNG chunks use it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
