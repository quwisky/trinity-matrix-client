/**
 * Byte-level GIF builders for the metadata-stripping specs, in the style of
 * `image-metadata.fixture.ts`: small, structurally valid files assembled from labelled
 * blocks, so a spec can assert exactly which blocks survive.
 */
import { XMP_PACKET, ascii, concat, repeated } from './image-metadata.fixture';

export const GIF_HEADER = ascii('GIF89a');
/** A 1x1 logical screen with a two-colour global colour table. */
export const GIF_SCREEN = Uint8Array.of(1, 0, 1, 0, 0x80, 0, 0);
export const GIF_GLOBAL_COLOURS = Uint8Array.of(0, 0, 0, 0xff, 0xff, 0xff);

/** `data` split into GIF sub-blocks of at most `size` bytes, with the terminator. */
export function gifSubBlocks(
  data: Uint8Array,
  size = 255,
): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += size) {
    const piece = data.subarray(at, at + size);
    blocks.push(Uint8Array.of(piece.length), piece);
  }
  return concat(...blocks, Uint8Array.of(0));
}

/** An application extension: the 11-byte identifier block, then `data` as sub-blocks. */
export function gifApplication(
  identifier: string,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return concat(
    Uint8Array.of(0x21, 0xff, 11),
    ascii(identifier),
    gifSubBlocks(data),
  );
}

export const GIF_LOOP = gifApplication('NETSCAPE2.0', Uint8Array.of(1, 0, 0));
export const GIF_ANIMEXTS_LOOP = gifApplication(
  'ANIMEXTS1.0',
  Uint8Array.of(1, 0, 0),
);
export const GIF_ICC = gifApplication('ICCRGBG1012', ascii('fake-icc-profile'));
/** Graphic Control Extension: no transparency, 10/100 s delay. */
export const GIF_GRAPHIC_CONTROL = Uint8Array.of(0x21, 0xf9, 4, 0, 10, 0, 0, 0);
export const GIF_COMMENT = concat(
  Uint8Array.of(0x21, 0xfe),
  gifSubBlocks(ascii('Shot at home by Alice Example')),
);
export const GIF_PLAIN_TEXT = concat(
  Uint8Array.of(0x21, 0x01, 12),
  new Uint8Array(12),
  gifSubBlocks(ascii('Hello')),
);
/** A private application extension carrying identifying text. */
export const GIF_PRIVATE_APPLICATION = gifApplication(
  'MYAPP001abc',
  ascii('Canon EOS R6 at 52.5200N'),
);

/**
 * XMP the way Adobe writes it into a GIF: the raw packet right after the identifier, then
 * the 258-byte "magic trailer" that makes any walk through the packet's bytes, read as
 * sub-block sizes, land on a terminator.
 */
export const GIF_XMP = concat(
  Uint8Array.of(0x21, 0xff, 11),
  ascii('XMP DataXMP'),
  ascii(XMP_PACKET),
  Uint8Array.of(1),
  Uint8Array.from({ length: 256 }, (_, i) => 0xff - i),
  Uint8Array.of(0),
);

/** One 1x1 frame: descriptor, LZW minimum code size and its compressed data. */
export const GIF_IMAGE = concat(
  Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0),
  Uint8Array.of(2),
  gifSubBlocks(Uint8Array.of(0x4c, 0x01)),
);
/** A frame with its own two-colour local colour table. */
export const GIF_IMAGE_LOCAL_COLOURS = concat(
  Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80),
  Uint8Array.of(0xff, 0, 0, 0, 0xff, 0),
  Uint8Array.of(2),
  gifSubBlocks(Uint8Array.of(0x4c, 0x01)),
);
export const GIF_TRAILER = Uint8Array.of(0x3b);

export function gifFile(
  ...blocks: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  return concat(GIF_HEADER, GIF_SCREEN, GIF_GLOBAL_COLOURS, ...blocks);
}

/** An animated GIF carrying a comment, XMP and private application data. */
export function identifyingGif(): Uint8Array<ArrayBuffer> {
  return gifFile(
    GIF_LOOP,
    GIF_COMMENT,
    GIF_XMP,
    GIF_ICC,
    GIF_GRAPHIC_CONTROL,
    GIF_IMAGE,
    GIF_PRIVATE_APPLICATION,
    GIF_GRAPHIC_CONTROL,
    GIF_IMAGE_LOCAL_COLOURS,
    GIF_PLAIN_TEXT,
    GIF_TRAILER,
  );
}

/** A GIF alternating `pairs` times between a kept Graphic Control and a dropped comment. */
export function alternatingGif(pairs: number): Uint8Array<ArrayBuffer> {
  const pair = concat(
    GIF_GRAPHIC_CONTROL,
    Uint8Array.of(0x21, 0xfe, 1, 0x41, 0),
  );
  return gifFile(repeated(pair, pairs), GIF_IMAGE, GIF_TRAILER);
}

/** An animation of `frames` frames, each with its Graphic Control, plus one comment. */
export function animatedGif(frames: number): Uint8Array<ArrayBuffer> {
  return gifFile(
    GIF_LOOP,
    GIF_COMMENT,
    repeated(concat(GIF_GRAPHIC_CONTROL, GIF_IMAGE), frames),
    GIF_TRAILER,
  );
}

/** A comment whose text is split into `count` one-byte sub-blocks. */
export function tinySubBlocksGif(count: number): Uint8Array<ArrayBuffer> {
  return gifFile(
    Uint8Array.of(0x21, 0xfe),
    repeated(Uint8Array.of(1, 0x41), count),
    Uint8Array.of(0),
    GIF_IMAGE,
    GIF_TRAILER,
  );
}
