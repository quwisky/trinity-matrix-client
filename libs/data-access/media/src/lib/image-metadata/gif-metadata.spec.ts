import { describe, expect, it } from 'vitest';
import {
  GIF_ANIMEXTS_LOOP,
  GIF_COMMENT,
  GIF_GRAPHIC_CONTROL,
  GIF_ICC,
  GIF_IMAGE,
  GIF_IMAGE_LOCAL_COLOURS,
  GIF_LOOP,
  GIF_PLAIN_TEXT,
  GIF_TRAILER,
  alternatingGif,
  animatedGif,
  gifFile,
  identifyingGif,
  tinySubBlocksGif,
} from './gif-metadata.fixture';
import { ascii, concat, containsAscii } from './image-metadata.fixture';
import {
  joinParts,
  strippableFormat,
  stripImageMetadata,
} from './image-metadata';

function stripped(input: Uint8Array<ArrayBuffer>): Uint8Array {
  const result = stripImageMetadata(input);
  if (result.kind !== 'stripped') {
    throw new Error(`expected a strip, got ${result.kind}/${result.reason}`);
  }
  expect(result.format).toBe('gif');
  const bytes = joinParts(result.parts);
  expect(bytes.byteLength).toBe(result.byteLength);
  return bytes;
}

function expectQuickMalformed(input: Uint8Array<ArrayBuffer>): void {
  const started = performance.now();
  const result = stripImageMetadata(input);
  const elapsed = performance.now() - started;

  expect(result).toEqual({ kind: 'unchanged', reason: 'malformed' });
  expect(elapsed).toBeLessThan(100);
}

describe('stripImageMetadata: GIF', () => {
  it('recognises GIF87a and GIF89a by their signature', () => {
    expect(strippableFormat(identifyingGif())).toBe('gif');
    expect(strippableFormat(ascii('GIF87a'))).toBe('gif');
    expect(strippableFormat(ascii('GIF88a'))).toBeNull();
  });

  it('drops comments, XMP and private application data, keeping every other block', () => {
    const input = identifyingGif();
    for (const marker of ['Alice Example', 'rdf:Description', 'Canon']) {
      expect(containsAscii(input, marker), marker).toBe(true);
    }

    const out = stripped(input);

    for (const marker of ['Alice Example', 'rdf:Description', 'Canon']) {
      expect(containsAscii(out, marker), marker).toBe(false);
    }
    expect(containsAscii(out, 'XMP DataXMP')).toBe(false);
    expect(Array.from(out)).toEqual(
      Array.from(
        gifFile(
          GIF_LOOP,
          GIF_ICC,
          GIF_GRAPHIC_CONTROL,
          GIF_IMAGE,
          GIF_GRAPHIC_CONTROL,
          GIF_IMAGE_LOCAL_COLOURS,
          GIF_PLAIN_TEXT,
          GIF_TRAILER,
        ),
      ),
    );
  });

  it('keeps the ANIMEXTS loop extension', () => {
    const out = stripped(
      gifFile(GIF_ANIMEXTS_LOOP, GIF_COMMENT, GIF_IMAGE, GIF_TRAILER),
    );

    expect(Array.from(out)).toEqual(
      Array.from(gifFile(GIF_ANIMEXTS_LOOP, GIF_IMAGE, GIF_TRAILER)),
    );
  });

  it('works on a GIF87a without a global colour table', () => {
    const input = concat(
      ascii('GIF87a'),
      Uint8Array.of(1, 0, 1, 0, 0, 0, 0),
      GIF_COMMENT,
      GIF_IMAGE_LOCAL_COLOURS,
      GIF_TRAILER,
    );

    expect(Array.from(stripped(input))).toEqual(
      Array.from(
        concat(
          ascii('GIF87a'),
          Uint8Array.of(1, 0, 1, 0, 0, 0, 0),
          GIF_IMAGE_LOCAL_COLOURS,
          GIF_TRAILER,
        ),
      ),
    );
  });

  it('drops bytes after the trailer', () => {
    const clean = gifFile(GIF_IMAGE, GIF_TRAILER);

    expect(Array.from(stripped(concat(clean, ascii('Alice Example'))))).toEqual(
      Array.from(clean),
    );
  });

  it('reports a GIF without metadata as clean', () => {
    expect(
      stripImageMetadata(
        gifFile(GIF_LOOP, GIF_GRAPHIC_CONTROL, GIF_IMAGE, GIF_TRAILER),
      ),
    ).toEqual({ kind: 'unchanged', reason: 'clean' });
  });

  it.each([
    ['no trailer', () => gifFile(GIF_COMMENT, GIF_IMAGE)],
    [
      'a sub-block chain cut short',
      () => gifFile(GIF_COMMENT, GIF_IMAGE.subarray(0, GIF_IMAGE.length - 2)),
    ],
    [
      'a sub-block longer than the file',
      () => gifFile(GIF_COMMENT, Uint8Array.of(0x21, 0xfe, 200, 0x41)),
    ],
    [
      'a global colour table past the end',
      () => concat(ascii('GIF89a'), Uint8Array.of(1, 0, 1, 0, 0x87, 0, 0)),
    ],
    [
      'a local colour table past the end',
      () =>
        gifFile(GIF_COMMENT, Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x87)),
    ],
    [
      'an image descriptor cut short',
      () => gifFile(GIF_COMMENT, Uint8Array.of(0x2c, 0, 0, 0)),
    ],
    [
      'an unknown block introducer',
      () => gifFile(GIF_COMMENT, Uint8Array.of(0x00), GIF_IMAGE, GIF_TRAILER),
    ],
    ['a logical screen descriptor cut short', () => ascii('GIF89a\x01\x00')],
  ])('leaves a malformed GIF with %s unchanged', (_label, build) => {
    expect(stripImageMetadata(build())).toEqual({
      kind: 'unchanged',
      reason: 'malformed',
    });
  });

  it.each([
    ['alternating kept and dropped extensions', () => alternatingGif(200_000)],
    ['more blocks than one walk may visit', () => animatedGif(70_000)],
    ['millions of one-byte sub-blocks', () => tinySubBlocksGif(9_000_000)],
  ])('returns a GIF with %s unchanged, quickly', (_label, build) => {
    expectQuickMalformed(build());
  });

  it('still strips long animations and alternations under the caps', () => {
    expect(stripImageMetadata(animatedGif(5_000)).kind).toBe('stripped');
    expect(stripImageMetadata(alternatingGif(500)).kind).toBe('stripped');
    expect(stripImageMetadata(tinySubBlocksGif(1_000_000)).kind).toBe(
      'stripped',
    );
  });
});
