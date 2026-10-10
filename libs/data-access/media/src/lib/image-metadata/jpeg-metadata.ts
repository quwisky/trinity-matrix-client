import {
  MALFORMED,
  PartsBuilder,
  asciiBytes,
  hasAscii,
  joinParts,
  u16be,
  type Bytes,
  type FormatStrip,
} from './byte-parts';
import {
  isRotatedOrMirrored,
  orientationTiff,
  readTiffOrientation,
} from './exif-orientation';

const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

export function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

/**
 * Remove metadata from a baseline or progressive JPEG without touching its image data.
 *
 * Header segments are kept by allow-list: JFIF (APP0), ICC profiles (APP2 `ICC_PROFILE`),
 * Adobe colour transform (APP14) and every non-APP segment a decoder needs (tables, frame,
 * restart interval, scans). Everything else goes: Exif and XMP (APP1), MPF and FlashPix
 * (APP2), IPTC/Photoshop (APP13), other APPn and comments. A non-default Exif orientation
 * survives as a new APP1 holding only that tag, written where the Exif was.
 *
 * The entropy-coded data is walked to the first image's EOI and anything after it is
 * dropped: MPF secondary images (HDR gain maps, depth maps), Motion Photo videos and
 * vendor trailers can carry their own metadata, and the XMP and MPF segments that point
 * at them are gone. The primary image displays exactly as before.
 */
export function stripJpeg(bytes: Bytes): FormatStrip {
  const out = new PartsBuilder(bytes);
  const n = bytes.length;
  out.keep(0, 2);
  let pos = 2;
  let seenExif = false;
  let seenScan = false;

  for (;;) {
    if (pos >= n || bytes[pos] !== 0xff) return MALFORMED;
    let at = pos + 1;
    while (at < n && bytes[at] === 0xff) at++; // fill bytes before a marker
    if (at >= n) return MALFORMED;
    const marker = bytes[at] ?? 0;

    if (marker === EOI) {
      if (!seenScan) return MALFORMED;
      out.keep(pos, at + 1);
      if (at + 1 < n) out.drop(); // trailing images, videos and vendor data
      return out.result();
    }
    if (marker === 0x01) {
      // TEM: a standalone marker with no length.
      out.keep(pos, at + 1);
      pos = at + 1;
      continue;
    }
    if (
      marker === 0x00 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return MALFORMED;
    }

    if (at + 3 > n) return MALFORMED;
    const length = u16be(bytes, at + 1);
    const end = at + 1 + length;
    if (length < 2 || end > n) return MALFORMED;
    const payload = bytes.subarray(at + 3, end);

    switch (classify(marker, payload)) {
      case 'keep':
        out.keep(pos, end);
        break;
      case 'drop':
        out.drop();
        break;
      case 'exif': {
        out.drop();
        if (seenExif) break;
        seenExif = true;
        const orientation = readTiffOrientation(payload.subarray(6));
        if (orientation === null) return MALFORMED;
        if (isRotatedOrMirrored(orientation))
          out.insert(orientationSegment(orientation));
        break;
      }
    }
    pos = end;

    if (marker === SOS) {
      seenScan = true;
      const next = nextMarkerAfterScan(bytes, pos);
      if (next < 0) return MALFORMED;
      out.keep(pos, next);
      pos = next;
    }
  }
}

function classify(
  marker: number,
  payload: Uint8Array,
): 'keep' | 'drop' | 'exif' {
  if (
    marker === APP1 &&
    hasAscii(payload, 0, 'Exif\0') &&
    payload.length >= 6
  ) {
    return 'exif';
  }
  if (marker === APP0) return hasAscii(payload, 0, 'JFIF\0') ? 'keep' : 'drop';
  if (marker === APP2)
    return hasAscii(payload, 0, 'ICC_PROFILE\0') ? 'keep' : 'drop';
  if (marker === APP14) return hasAscii(payload, 0, 'Adobe') ? 'keep' : 'drop';
  if ((marker >= APP0 && marker <= 0xef) || marker === COM) return 'drop';
  return 'keep';
}

/**
 * The offset of the first marker after entropy-coded data starting at `from`, or -1 when the
 * data runs off the end. Inside a scan 0xFF is followed by 0x00 (a stuffed byte), a restart
 * marker, or another 0xFF (fill); anything else ends the scan.
 */
function nextMarkerAfterScan(bytes: Uint8Array, from: number): number {
  let i = from;
  for (;;) {
    const ff = bytes.indexOf(0xff, i);
    if (ff < 0 || ff + 1 >= bytes.length) return -1;
    const next = bytes[ff + 1] ?? 0;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      i = ff + 2;
    } else if (next === 0xff) {
      i = ff + 1;
    } else {
      return ff;
    }
  }
}

function orientationSegment(orientation: number): Bytes {
  const payload = joinParts([
    asciiBytes('Exif\0\0'),
    orientationTiff(orientation),
  ]);
  const length = payload.length + 2;
  return joinParts([
    Uint8Array.of(0xff, APP1, length >> 8, length & 0xff),
    payload,
  ]);
}
