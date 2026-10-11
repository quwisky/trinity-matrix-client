import {
  MALFORMED,
  MalformedImage,
  PartsBuilder,
  hasAscii,
  type Bytes,
  type FormatStrip,
} from './byte-parts';

const EXTENSION = 0x21;
const IMAGE = 0x2c;
const TRAILER = 0x3b;
const COMMENT = 0xfe;
const APPLICATION = 0xff;

/** Logical screen descriptor: 6-byte signature, then 7 bytes ending with the aspect ratio. */
const SCREEN_END = 13;
/** Image descriptor: separator, position, size and flags. */
const IMAGE_DESCRIPTOR = 10;

/**
 * Application extensions a decoder uses: loop control (Netscape and its AnimExts alias) and
 * an ICC colour profile, which JPEG, PNG and WebP keep too. Every other application
 * extension goes, among them XMP ("XMP DataXMP") and editor-private data.
 */
const KEPT_APPLICATIONS = new Set([
  'NETSCAPE2.0',
  'ANIMEXTS1.0',
  'ICCRGBG1012',
]);

/**
 * Upper bound on sub-blocks across the file. Encoders write 255-byte sub-blocks, so this is
 * a 2 GB GIF; each one is a single bounds-checked jump, so even the cap costs only a few
 * milliseconds. Only a file split into tiny sub-blocks on purpose gets near it.
 */
const MAX_SUB_BLOCKS = 1 << 23;

export function isGif(bytes: Uint8Array): boolean {
  return hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a');
}

/**
 * Remove comment extensions and application extensions other than loop control and ICC
 * from a GIF, XMP included. The logical screen, colour tables, Graphic Control and Plain
 * Text extensions and every frame's image data are kept byte for byte, so an animation
 * plays exactly as before. Bytes after the trailer are dropped.
 */
export function stripGif(bytes: Bytes): FormatStrip {
  const n = bytes.length;
  if (n < SCREEN_END) return MALFORMED;
  const out = new PartsBuilder(bytes);
  let pos = SCREEN_END + colourTableLength(bytes[10] ?? 0);
  if (pos > n) return MALFORMED;
  out.keep(0, pos);
  let subBlocks = 0;

  /** The offset after the sub-block chain starting at `from`, or -1 when it runs off the end. */
  const skipSubBlocks = (from: number): number => {
    let at = from;
    while (at < n) {
      if (++subBlocks > MAX_SUB_BLOCKS) throw new MalformedImage();
      const size = bytes[at] ?? 0;
      at += 1 + size;
      if (size === 0) return at;
    }
    return -1;
  };

  for (;;) {
    out.step();
    if (pos >= n) return MALFORMED;
    const introducer = bytes[pos];

    if (introducer === TRAILER) {
      out.keep(pos, pos + 1);
      if (pos + 1 < n) out.drop(); // bytes after the trailer
      return out.result();
    }

    if (introducer === IMAGE) {
      if (pos + IMAGE_DESCRIPTOR > n) return MALFORMED;
      // The local colour table, then the LZW minimum code size, then the data sub-blocks.
      const data =
        pos +
        IMAGE_DESCRIPTOR +
        colourTableLength(bytes[pos + IMAGE_DESCRIPTOR - 1] ?? 0) +
        1;
      if (data > n) return MALFORMED;
      const end = skipSubBlocks(data);
      if (end < 0) return MALFORMED;
      out.keep(pos, end);
      pos = end;
      continue;
    }

    if (introducer === EXTENSION) {
      if (pos + 2 > n) return MALFORMED;
      // Every extension is its label then a sub-block chain; an application extension's
      // first sub-block is its 11-byte identifier and authentication code.
      const end = skipSubBlocks(pos + 2);
      if (end < 0) return MALFORMED;
      if (keepsExtension(bytes, pos)) {
        out.keep(pos, end);
      } else {
        out.drop();
      }
      pos = end;
      continue;
    }

    return MALFORMED;
  }
}

/** Bytes of the colour table a logical screen or image descriptor's flags announce. */
function colourTableLength(flags: number): number {
  return flags & 0x80 ? 3 << ((flags & 0x07) + 1) : 0;
}

function keepsExtension(bytes: Bytes, at: number): boolean {
  const label = bytes[at + 1];
  if (label === COMMENT) return false;
  if (label !== APPLICATION) return true;
  if (bytes[at + 2] !== 11 || at + 14 > bytes.length) return false;
  return KEPT_APPLICATIONS.has(
    String.fromCharCode(...bytes.subarray(at + 3, at + 14)),
  );
}
