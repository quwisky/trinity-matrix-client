import type { Bytes } from './byte-parts';

const ORIENTATION_TAG = 0x0112;
const SHORT = 3;

/**
 * The Exif orientation (1-8) a TIFF block declares, 1 when it declares none, or null when
 * the block is not a well-formed TIFF header and IFD0. Only the structure is checked: an
 * orientation that is not a single SHORT in 1-8 is ignored by decoders, so it reads as 1
 * here too and the image looks the same once the tag is gone.
 */
export function readTiffOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49; // "II"
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d; // "MM"
  if (!little && !big) return null;
  const u16 = (at: number): number =>
    little
      ? (tiff[at] ?? 0) | ((tiff[at + 1] ?? 0) << 8)
      : ((tiff[at] ?? 0) << 8) | (tiff[at + 1] ?? 0);
  const u32 = (at: number): number =>
    little
      ? (u16(at) | (u16(at + 2) << 16)) >>> 0
      : ((u16(at) << 16) | u16(at + 2)) >>> 0;
  if (u16(2) !== 42) return null;

  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
  const count = u16(ifd0);
  if (ifd0 + 2 + count * 12 > tiff.length) return null;

  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) !== ORIENTATION_TAG) continue;
    const value = u16(entry + 8);
    const usable =
      u16(entry + 2) === SHORT &&
      u32(entry + 4) === 1 &&
      value >= 1 &&
      value <= 8;
    return usable ? value : 1;
  }
  return 1;
}

/** A big-endian TIFF whose IFD0 holds nothing but `orientation` (26 bytes). */
export function orientationTiff(orientation: number): Bytes {
  // prettier-ignore
  return Uint8Array.of(
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, SHORT, 0x00, 0x00, 0x00, 0x01,
    0x00, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  );
}

/**
 * Whether an orientation needs keeping: anything but the default "top-left". An unreadable
 * block (null) has none a decoder could apply either.
 */
export function isRotatedOrMirrored(
  orientation: number | null,
): orientation is number {
  return orientation !== null && orientation >= 2 && orientation <= 8;
}
