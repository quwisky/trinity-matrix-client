import { describe, expect, it } from 'vitest';
import {
  HEIF_EXIF_PAYLOAD,
  HEIF_PIXELS,
  HEIF_XMP_PAYLOAD,
  IDENTIFYING_MARKERS,
  JPEG_ADOBE,
  JPEG_COMMENT,
  JPEG_DQT,
  JPEG_EOI,
  JPEG_ICC,
  JPEG_IMAGE_DATA,
  JPEG_JFIF,
  JPEG_SCAN,
  JPEG_SOF0,
  JPEG_SOI,
  JPEG_SOS,
  PNG_CHRM,
  PNG_GAMA,
  PNG_ICCP,
  PNG_IDAT,
  PNG_IEND,
  PNG_IHDR,
  PNG_PHYS,
  PNG_SIGNATURE,
  PNG_SRGB,
  VP8X_ALPHA,
  VP8X_EXIF,
  VP8X_ICC,
  WEBP_ALPH,
  WEBP_ICCP,
  WEBP_VP8L,
  ascii,
  concat,
  containsAscii,
  containsBytes,
  fixtureCrc32,
  identifyingHeic,
  identifyingJpeg,
  identifyingPng,
  identifyingTiff,
  identifyingWebp,
  jpegExif,
  orientationOnlyTiff,
  manyExtentsHeic,
  pathologicalIlocHeic,
  pngChunk,
  riffChunk,
  u32le,
  vp8x,
  webpFile,
} from './image-metadata.fixture';
import { joinParts, stripImageMetadata } from './image-metadata';

/** Exif TIFF blocks a decoder cannot read, inside otherwise well-formed containers. */
const UNREADABLE_TIFFS: readonly [string, Uint8Array<ArrayBuffer>][] = [
  [
    'an IFD0 pointing past its end',
    concat(ascii('MM'), Uint8Array.of(0, 42, 0x7f, 0, 0, 0), ascii('52.5200N')),
  ],
  ['a truncated IFD0', identifyingTiff(6).slice(0, 20)],
  [
    'an unknown byte order',
    concat(ascii('XX'), identifyingTiff(6).subarray(2)),
  ],
];

/** Run the stripper and return the joined output, failing unless it stripped. */
function stripped(input: Uint8Array<ArrayBuffer>): Uint8Array {
  const result = stripImageMetadata(input);
  if (result.kind !== 'stripped') {
    throw new Error(`expected a strip, got ${result.kind}/${result.reason}`);
  }
  const bytes = joinParts(result.parts);
  expect(bytes.byteLength).toBe(result.byteLength);
  return bytes;
}

function expectNoIdentifyingMetadata(bytes: Uint8Array): void {
  for (const marker of IDENTIFYING_MARKERS) {
    expect(containsAscii(bytes, marker), marker).toBe(false);
  }
}

describe('stripImageMetadata', () => {
  describe('JPEG', () => {
    it('removes Exif, XMP, extended XMP, IPTC, comments, MPF and trailing images', () => {
      const input = identifyingJpeg(1);
      // The fixture really carries what we claim it does.
      for (const marker of IDENTIFYING_MARKERS) {
        expect(containsAscii(input, marker), marker).toBe(true);
      }

      const out = stripped(input);

      expectNoIdentifyingMetadata(out);
      expect(containsAscii(out, 'Exif')).toBe(false);
      expect(containsAscii(out, 'MPF')).toBe(false);
      expect(containsAscii(out, 'Photoshop')).toBe(false);
    });

    it('keeps JFIF, ICC and Adobe segments and every image byte, in order', () => {
      const out = stripped(identifyingJpeg(1));

      expect(Array.from(out)).toEqual(
        Array.from(
          concat(JPEG_SOI, JPEG_JFIF, JPEG_ICC, JPEG_ADOBE, JPEG_IMAGE_DATA),
        ),
      );
    });

    it('keeps a non-default orientation as an Exif segment holding only that tag', () => {
      const out = stripped(identifyingJpeg(6));

      const orientationApp1 = jpegExif(orientationOnlyTiff(6));
      expect(Array.from(out)).toEqual(
        Array.from(
          concat(
            JPEG_SOI,
            JPEG_JFIF,
            orientationApp1,
            JPEG_ICC,
            JPEG_ADOBE,
            JPEG_IMAGE_DATA,
          ),
        ),
      );
      expectNoIdentifyingMetadata(out);
    });

    it('reads the orientation from big- and little-endian Exif alike', () => {
      for (const order of ['II', 'MM'] as const) {
        const input = concat(
          JPEG_SOI,
          jpegExif(identifyingTiff(8, order)),
          JPEG_IMAGE_DATA,
        );
        expect(Array.from(stripped(input))).toEqual(
          Array.from(
            concat(JPEG_SOI, jpegExif(orientationOnlyTiff(8)), JPEG_IMAGE_DATA),
          ),
        );
      }
    });

    it('drops Exif without an orientation tag entirely', () => {
      const input = concat(
        JPEG_SOI,
        jpegExif(identifyingTiff(null)),
        JPEG_IMAGE_DATA,
      );

      expect(Array.from(stripped(input))).toEqual(
        Array.from(concat(JPEG_SOI, JPEG_IMAGE_DATA)),
      );
    });

    it('keeps tables and scans between progressive scans, dropping comments there', () => {
      const secondScan = concat(
        JPEG_SOS,
        Uint8Array.of(0x01, 0xff, 0x00, 0x02),
      );
      const input = concat(
        JPEG_SOI,
        JPEG_DQT,
        JPEG_SOF0,
        JPEG_SOS,
        JPEG_SCAN,
        JPEG_COMMENT,
        secondScan,
        JPEG_EOI,
      );

      expect(Array.from(stripped(input))).toEqual(
        Array.from(
          concat(
            JPEG_SOI,
            JPEG_DQT,
            JPEG_SOF0,
            JPEG_SOS,
            JPEG_SCAN,
            secondScan,
            JPEG_EOI,
          ),
        ),
      );
    });

    it('reports a JPEG without metadata as clean, without copying it', () => {
      const input = concat(JPEG_SOI, JPEG_JFIF, JPEG_ICC, JPEG_IMAGE_DATA);

      expect(stripImageMetadata(input)).toEqual({
        kind: 'unchanged',
        reason: 'clean',
      });
    });

    it.each([
      [
        'a segment length past the end',
        concat(JPEG_SOI, Uint8Array.of(0xff, 0xe1, 0x40, 0x00), ascii('Exif')),
      ],
      [
        'no end-of-image marker',
        concat(JPEG_SOI, jpegExif(identifyingTiff(6)), JPEG_SOS, JPEG_SCAN),
      ],
      [
        'a byte that is not a marker between segments',
        concat(
          JPEG_SOI,
          jpegExif(identifyingTiff(6)),
          Uint8Array.of(0x00, 0x01),
        ),
      ],
      [
        'an end-of-image marker before any scan',
        concat(JPEG_SOI, jpegExif(identifyingTiff(6)), JPEG_EOI),
      ],
    ])('leaves a malformed JPEG with %s unchanged', (_label, input) => {
      expect(stripImageMetadata(input)).toEqual({
        kind: 'unchanged',
        reason: 'malformed',
      });
    });
    it.each(UNREADABLE_TIFFS)(
      'drops an Exif segment with %s, keeping everything else',
      (_label, tiff) => {
        const input = concat(
          JPEG_SOI,
          JPEG_JFIF,
          jpegExif(tiff),
          JPEG_ICC,
          JPEG_IMAGE_DATA,
        );

        expect(Array.from(stripped(input))).toEqual(
          Array.from(concat(JPEG_SOI, JPEG_JFIF, JPEG_ICC, JPEG_IMAGE_DATA)),
        );
      },
    );
  });

  describe('PNG', () => {
    it('drops eXIf, tEXt, zTXt, iTXt and tIME, keeping colour and pixel chunks', () => {
      const input = identifyingPng(1);
      expect(containsAscii(input, 'Alice Example')).toBe(true);

      const out = stripped(input);

      expectNoIdentifyingMetadata(out);
      expect(Array.from(out)).toEqual(
        Array.from(
          concat(
            PNG_SIGNATURE,
            PNG_IHDR,
            PNG_ICCP,
            PNG_SRGB,
            PNG_GAMA,
            PNG_CHRM,
            PNG_PHYS,
            PNG_IDAT,
            PNG_IEND,
          ),
        ),
      );
    });

    it('replaces eXIf with one holding only a non-default orientation, with a valid CRC', () => {
      const out = stripped(identifyingPng(6));

      expect(containsBytes(out, pngChunk('eXIf', orientationOnlyTiff(6)))).toBe(
        true,
      );
      expectNoIdentifyingMetadata(out);
    });

    it('drops bytes after IEND', () => {
      const clean = concat(PNG_SIGNATURE, PNG_IHDR, PNG_IDAT, PNG_IEND);
      const out = stripped(concat(clean, ascii('Alice Example')));

      expect(Array.from(out)).toEqual(Array.from(clean));
    });

    it('reports a PNG without metadata as clean', () => {
      expect(
        stripImageMetadata(
          concat(PNG_SIGNATURE, PNG_IHDR, PNG_SRGB, PNG_IDAT, PNG_IEND),
        ),
      ).toEqual({ kind: 'unchanged', reason: 'clean' });
    });

    it.each([
      [
        'no IEND',
        concat(
          PNG_SIGNATURE,
          PNG_IHDR,
          pngChunk('tEXt', ascii('a\0b')),
          PNG_IDAT,
        ),
      ],
      [
        'a chunk longer than the file',
        concat(
          PNG_SIGNATURE,
          PNG_IHDR,
          Uint8Array.of(0, 0, 0x10, 0),
          ascii('tEXt'),
        ),
      ],
      [
        'a first chunk other than IHDR',
        concat(
          PNG_SIGNATURE,
          pngChunk('tEXt', ascii('a\0b')),
          PNG_IHDR,
          PNG_IEND,
        ),
      ],
    ])('leaves a malformed PNG with %s unchanged', (_label, input) => {
      expect(stripImageMetadata(input)).toEqual({
        kind: 'unchanged',
        reason: 'malformed',
      });
    });

    it.each(UNREADABLE_TIFFS)(
      'drops an eXIf chunk with %s, keeping everything else',
      (_label, tiff) => {
        const clean = [PNG_IHDR, PNG_SRGB, PNG_IDAT, PNG_IEND] as const;
        const input = concat(
          PNG_SIGNATURE,
          clean[0],
          clean[1],
          pngChunk('eXIf', tiff),
          clean[2],
          clean[3],
        );

        expect(Array.from(stripped(input))).toEqual(
          Array.from(concat(PNG_SIGNATURE, ...clean)),
        );
      },
    );

    it('has a CRC fixture that agrees with the PNG specification', () => {
      expect(fixtureCrc32(ascii('IEND'))).toBe(0xae426082);
    });
  });

  describe('WebP', () => {
    it('drops EXIF, XMP and unknown chunks, fixing the VP8X flags and RIFF size', () => {
      const out = stripped(identifyingWebp(1));

      expectNoIdentifyingMetadata(out);
      expect(Array.from(out)).toEqual(
        Array.from(
          webpFile(
            vp8x(VP8X_ICC | VP8X_ALPHA),
            WEBP_ICCP,
            WEBP_ALPH,
            WEBP_VP8L,
          ),
        ),
      );
    });

    it('keeps a non-default orientation in an EXIF chunk holding only that tag', () => {
      const out = stripped(identifyingWebp(3));

      expect(Array.from(out)).toEqual(
        Array.from(
          webpFile(
            vp8x(VP8X_ICC | VP8X_ALPHA | VP8X_EXIF),
            WEBP_ICCP,
            WEBP_ALPH,
            WEBP_VP8L,
            riffChunk('EXIF', orientationOnlyTiff(3)),
          ),
        ),
      );
    });

    it('reports a simple lossless WebP as clean', () => {
      expect(stripImageMetadata(webpFile(WEBP_VP8L))).toEqual({
        kind: 'unchanged',
        reason: 'clean',
      });
    });

    it.each(UNREADABLE_TIFFS)(
      'drops an EXIF chunk with %s, keeping everything else',
      (_label, tiff) => {
        const input = webpFile(
          vp8x(VP8X_ICC | VP8X_EXIF),
          WEBP_ICCP,
          WEBP_VP8L,
          riffChunk('EXIF', tiff),
        );

        expect(Array.from(stripped(input))).toEqual(
          Array.from(webpFile(vp8x(VP8X_ICC), WEBP_ICCP, WEBP_VP8L)),
        );
      },
    );

    it('leaves a WebP whose RIFF size overruns the file unchanged', () => {
      const input = identifyingWebp();
      input.set(u32le(input.length * 2), 4);

      expect(stripImageMetadata(input)).toEqual({
        kind: 'unchanged',
        reason: 'malformed',
      });
    });
  });

  describe('HEIF', () => {
    it('blanks the Exif and XMP items in place, leaving every other byte as it was', () => {
      const input = identifyingHeic();
      expect(containsAscii(input, 'Canon')).toBe(true);

      const out = stripped(input);

      expect(out.length).toBe(input.length);
      expectNoIdentifyingMetadata(out);
      // The Exif and XMP items sit right after the pixels, at the end of mdat; nothing
      // before them (ftyp, meta, the coded image) may change.
      const metadataStart = findIndex(input, HEIF_PIXELS) + HEIF_PIXELS.length;
      const metadataEnd =
        metadataStart + HEIF_EXIF_PAYLOAD.length + HEIF_XMP_PAYLOAD.length;
      expect(metadataEnd).toBe(input.length);
      expect(Array.from(out.subarray(0, metadataStart))).toEqual(
        Array.from(input.subarray(0, metadataStart)),
      );
      expect(containsAscii(out, 'xpacket')).toBe(true); // a valid, empty XMP packet
    });

    it('writes a valid empty TIFF where the Exif item was', () => {
      const input = identifyingHeic();
      const out = stripped(input);
      const at = findIndex(input, HEIF_PIXELS) + HEIF_PIXELS.length;

      expect(Array.from(out.subarray(at, at + 18))).toEqual([
        0, 0, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0,
      ]);
    });

    it('blanks an Exif item stored in the meta box idat', () => {
      const input = identifyingHeic({ exifInIdat: true });
      expect(containsAscii(input, 'Canon')).toBe(true);

      const out = stripped(input);

      expect(out.length).toBe(input.length);
      expectNoIdentifyingMetadata(out);
      expect(containsBytes(out, HEIF_PIXELS)).toBe(true);
    });

    it('blanks an XMP item whose content type carries parameters', () => {
      const out = stripped(
        identifyingHeic({
          xmpContentType: ' Application/RDF+XML ; charset=utf-8',
        }),
      );

      expectNoIdentifyingMetadata(out);
    });

    it.each(['largesize', 'to-end'] as const)(
      'follows an mdat whose size is given as %s',
      (mdatSize) => {
        const input = identifyingHeic({ mdatSize });
        const out = stripped(input);

        expect(out.length).toBe(input.length);
        expectNoIdentifyingMetadata(out);
        expect(containsBytes(out, HEIF_PIXELS)).toBe(true);
      },
    );

    it('leaves a HEIF whose last box is cut short unchanged', () => {
      const input = identifyingHeic();

      expect(stripImageMetadata(input.slice(0, input.length - 10))).toEqual({
        kind: 'unchanged',
        reason: 'malformed',
      });
    });

    it('rejects an iloc whose items claim far more extents than its bytes hold, quickly', () => {
      const input = pathologicalIlocHeic(2_000);

      const started = performance.now();
      const result = stripImageMetadata(input);
      const elapsed = performance.now() - started;

      expect(result).toEqual({ kind: 'unchanged', reason: 'malformed' });
      expect(elapsed).toBeLessThan(100);
    });

    it('accepts an item split into many extents up to the cap, and no further', () => {
      expect(stripImageMetadata(manyExtentsHeic(4_096)).kind).toBe('stripped');
      expect(stripImageMetadata(manyExtentsHeic(4_097))).toEqual({
        kind: 'unchanged',
        reason: 'malformed',
      });
    });

    it.each([
      ['points outside mdat', 10_000],
      ['overlaps the coded image', -4],
    ])('leaves a HEIF whose Exif item %s unchanged', (_label, delta) => {
      expect(
        stripImageMetadata(identifyingHeic({ exifOffsetDelta: delta })),
      ).toEqual({ kind: 'unchanged', reason: 'malformed' });
    });
  });

  describe('anything else', () => {
    it.each([
      ['GIF', ascii('GIF89a\x01\x00\x01\x00')],
      [
        'an MP4 video',
        concat(Uint8Array.of(0, 0, 0, 0x18), ascii('ftypmp42\0\0\0\0mp42isom')),
      ],
      ['text', ascii('Alice Example')],
      ['an empty file', new Uint8Array(0)],
    ])('leaves %s unchanged as unsupported', (_label, input) => {
      expect(stripImageMetadata(input)).toEqual({
        kind: 'unchanged',
        reason: 'unsupported',
      });
    });
  });
});

function findIndex(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
