import { describe, expect, it } from 'vitest';
import {
  ascii,
  box,
  concat,
  containsAscii,
  containsBytes,
  fullBox,
  repeated,
  u32be,
} from './image-metadata.fixture';
import {
  APPLE_KEYS,
  ISO6709,
  LOCI,
  MOVIE_MVHD,
  MOVIE_SAMPLES,
  MOVIE_TKHD,
  VIDEO_IDENTIFYING_MARKERS,
  VIDEO_KEPT_VALUES,
  XMP_ATOM,
  dataBox,
  iTunesMeta,
  identifyingMovie,
  identifyingUdta,
  keyedMeta,
  metadataHandler,
  quickTimeText,
  topLevelBox,
  topLevelBoxes,
} from './video-metadata.fixture';
import type { Bytes } from './byte-parts';
import {
  MAX_MOVIE_BYTES,
  isIsoMovie,
  stripVideoMetadata,
  type ReadRange,
} from './video-metadata';

interface Reads {
  readonly read: ReadRange;
  /** Every `[start, end)` the stripper asked for, in order. */
  readonly ranges: [number, number][];
}

/** A reader over `bytes` that hands out copies, as `Blob.slice().arrayBuffer()` does. */
function reader(bytes: Uint8Array): Reads {
  const ranges: [number, number][] = [];
  return {
    ranges,
    read: (start, end) => {
      ranges.push([start, end]);
      return Promise.resolve(bytes.slice(start, end));
    },
  };
}

/** Strip `input` and return the whole output, failing unless it stripped. */
async function stripped(input: Bytes): Promise<Uint8Array> {
  const result = await stripVideoMetadata(reader(input).read, input.length);
  if (result.kind !== 'stripped') {
    throw new Error(`expected a strip, got ${result.kind}/${result.reason}`);
  }
  expect(result.movie.length).toBe(result.end - result.start);
  return concat(
    input.subarray(0, result.start),
    result.movie,
    input.subarray(result.end),
  );
}

async function verdict(input: Bytes): Promise<unknown> {
  return stripVideoMetadata(reader(input).read, input.length);
}

function expectNoIdentifyingMetadata(bytes: Uint8Array): void {
  for (const marker of VIDEO_IDENTIFYING_MARKERS) {
    expect(containsAscii(bytes, marker), marker).toBe(false);
  }
}

/** Every byte outside `moov` is identical, and the box layout has not moved. */
function expectOnlyMoovEdited(input: Uint8Array, output: Uint8Array): void {
  expect(output.length).toBe(input.length);
  expect(topLevelBoxes(output)).toEqual(topLevelBoxes(input));
  const moov = topLevelBox(input, 'moov');
  expect(output.subarray(0, moov.start)).toEqual(input.subarray(0, moov.start));
  expect(output.subarray(moov.end)).toEqual(input.subarray(moov.end));
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const MALFORMED = { kind: 'unchanged', reason: 'malformed' };
const UNSUPPORTED = { kind: 'unchanged', reason: 'unsupported' };

describe('isIsoMovie', () => {
  const ftyp = (brand: string, ...compatible: string[]) =>
    box('ftyp', ascii(brand), u32be(0), ...compatible.map(ascii));

  it.each(['isom', 'mp42', 'qt  ', '3gp5', '3g2a', 'M4V ', 'avc1'])(
    'recognises the %s brand from the bytes alone',
    (brand) => {
      expect(isIsoMovie(ftyp(brand), '')).toBe(true);
    },
  );

  it('recognises a compatible movie brand behind an unknown major brand', () => {
    expect(isIsoMovie(ftyp('XAVC', 'XAVC', 'mp42'), '')).toBe(true);
  });

  it('leaves HEIF stills and other ISO files without a movie brand alone', () => {
    expect(isIsoMovie(ftyp('heic', 'mif1', 'heic'), '')).toBe(false);
    expect(isIsoMovie(ftyp('crx ', 'crx '), '')).toBe(false);
  });

  it('trusts a video MIME type for an unknown brand or an ftyp-less QuickTime file', () => {
    expect(isIsoMovie(ftyp('abcd'), 'video/mp4')).toBe(true);
    expect(isIsoMovie(box('wide', new Uint8Array(0)), 'video/quicktime')).toBe(
      true,
    );
    expect(isIsoMovie(box('mdat', MOVIE_SAMPLES), 'video/3gpp')).toBe(true);
    expect(isIsoMovie(box('mdat', MOVIE_SAMPLES), '')).toBe(false);
  });

  it('does not take a MIME type for proof when the bytes are no ISO file', () => {
    expect(isIsoMovie(ascii('not a movie at all'), 'video/mp4')).toBe(false);
    expect(isIsoMovie(new Uint8Array(0), 'video/mp4')).toBe(false);
  });
});

describe('stripVideoMetadata', () => {
  describe('MP4 and MOV', () => {
    it('removes location and device, keeping every offset, size and sample byte', async () => {
      const input = identifyingMovie();

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
      expectOnlyMoovEdited(input, out);
      expect(containsBytes(out, MOVIE_SAMPLES)).toBe(true);
      // Playback structure is byte-identical: header, track, chunk offsets.
      expect(containsBytes(out, MOVIE_MVHD)).toBe(true);
      expect(containsBytes(out, MOVIE_TKHD)).toBe(true);
      const mdat = topLevelBox(input, 'mdat');
      expect(
        containsBytes(out, fullBox('stco', 0, u32be(1), u32be(mdat.start + 8))),
      ).toBe(true);
    });

    it('keeps the capture date, the encoder, the frame rate and the content identifier', async () => {
      const out = await stripped(identifyingMovie());

      for (const value of Object.values(VIDEO_KEPT_VALUES)) {
        expect(containsAscii(out, value), value).toBe(true);
      }
      expect(containsBytes(out, quickTimeText('\xa9too', 'Lavf61.7.100'))).toBe(
        true,
      );
    });

    it('turns location and device atoms into free boxes of the same size', async () => {
      const input = identifyingMovie();
      const location = quickTimeText('\xa9xyz', '+52.5200+013.4050/');
      const at = indexOf(input, location);

      const out = await stripped(input);

      expect(out.subarray(at, at + 8)).toEqual(
        concat(u32be(location.length), ascii('free')),
      );
      expect(out.subarray(at + 8, at + location.length)).toEqual(
        new Uint8Array(location.length - 8),
      );
      for (const removed of [LOCI, XMP_ATOM]) {
        const start = indexOf(input, removed);
        expect(out.subarray(start + 4, start + 8)).toEqual(ascii('free'));
      }
    });

    it('blanks the values of Apple location and device keys, keeping keys and items', async () => {
      const input = identifyingMovie();
      const locationData = dataBox(ISO6709);
      const at = indexOf(input, locationData);

      const out = await stripped(input);

      // The item and its data box keep their size, type and locale; only the value is zero.
      expect(out.subarray(at, at + 16)).toEqual(locationData.subarray(0, 16));
      expect(out.subarray(at + 16, at + locationData.length)).toEqual(
        new Uint8Array(ISO6709.length),
      );
      for (const [key] of APPLE_KEYS) {
        expect(containsAscii(out, key), key).toBe(true);
      }
    });

    it('strips a MOV whose moov follows mdat, as iPhones record', async () => {
      const input = identifyingMovie({ brand: 'qt  ', layout: 'moov-last' });

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
      expectOnlyMoovEdited(input, out);
    });

    it.each(['largesize', 'to-end'] as const)(
      'strips around an mdat whose size is written as %s',
      async (mdatSize) => {
        const input = identifyingMovie({ mdatSize });

        const out = await stripped(input);

        expectNoIdentifyingMetadata(out);
        expectOnlyMoovEdited(input, out);
      },
    );

    it('strips an mdat with a 64-bit size before a trailing moov', async () => {
      const input = identifyingMovie({
        layout: 'moov-last',
        mdatSize: 'largesize',
      });

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
      expectOnlyMoovEdited(input, out);
    });

    it('strips a location written into the track user data', async () => {
      const input = identifyingMovie({
        moovMetadata: [],
        trackUdta: identifyingUdta(),
      });

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
      expectOnlyMoovEdited(input, out);
    });

    it('strips keys in an ISO meta box and iTunes items in udta/meta', async () => {
      const input = identifyingMovie({
        moovMetadata: [keyedMeta(APPLE_KEYS, 'iso'), box('udta', iTunesMeta())],
      });

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
      expect(containsAscii(out, VIDEO_KEPT_VALUES.encoder)).toBe(true);
      expectOnlyMoovEdited(input, out);
    });

    it('accepts the zero terminator QuickTime allows at the end of udta', async () => {
      const udta = identifyingUdta();
      const terminated = concat(
        u32be(udta.length + 4),
        udta.subarray(4),
        u32be(0),
      );
      const input = identifyingMovie({ moovMetadata: [terminated] });

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
    });

    it('strips a 3GP location (loci)', async () => {
      const input = identifyingMovie({
        brand: '3gp5',
        moovMetadata: [box('udta', LOCI)],
      });

      const out = await stripped(input);

      expect(containsAscii(out, 'Berlin')).toBe(false);
      expectOnlyMoovEdited(input, out);
    });

    it('strips an old QuickTime file that has no ftyp', async () => {
      const input = identifyingMovie({ brand: null, layout: 'moov-last' });

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
    });

    it('reports a movie with nothing to remove as clean', async () => {
      const input = identifyingMovie({
        moovMetadata: [
          box('udta', quickTimeText('\xa9too', VIDEO_KEPT_VALUES.encoder)),
        ],
      });

      expect(await verdict(input)).toEqual({
        kind: 'unchanged',
        reason: 'clean',
      });
    });
  });

  describe('memory', () => {
    it('reads only top-level box headers and the moov box, never the samples', async () => {
      const input = identifyingMovie({ layout: 'moov-last' });
      const moov = topLevelBox(input, 'moov');
      const mdat = topLevelBox(input, 'mdat');
      const { read, ranges } = reader(input);

      const result = await stripVideoMetadata(read, input.length);

      expect(result.kind).toBe('stripped');
      for (const [start, end] of ranges) {
        const isMoov = start === moov.start && end === moov.end;
        expect(isMoov || end - start <= 16, `${start}-${end}`).toBe(true);
        // No read reaches past an mdat header into its samples.
        expect(start < mdat.end && end > mdat.start + 16).toBe(false);
      }
    });

    it('leaves a moov larger than the cap unchanged without reading it', async () => {
      const ftyp = box('ftyp', ascii('isom'), u32be(0), ascii('isom'));
      const moovSize = MAX_MOVIE_BYTES + 1;
      const header = concat(u32be(moovSize), ascii('moov'));
      const size = ftyp.length + moovSize;
      const ranges: [number, number][] = [];
      const read: ReadRange = (start, end) => {
        ranges.push([start, end]);
        const window = new Uint8Array(end - start);
        if (start === 0) window.set(ftyp.subarray(0, window.length));
        if (start === ftyp.length)
          window.set(header.subarray(0, window.length));
        return Promise.resolve(window);
      };

      expect(await stripVideoMetadata(read, size)).toEqual(UNSUPPORTED);
      expect(Math.max(...ranges.map(([s, e]) => e - s))).toBeLessThanOrEqual(
        16,
      );
    });
  });

  describe('fail-open', () => {
    const ftyp = box('ftyp', ascii('isom'), u32be(0), ascii('isom'));
    const moovWith = (...children: Uint8Array[]) =>
      box('moov', MOVIE_MVHD, ...children);

    it.each([
      ['a file cut short inside mdat', () => identifyingMovie().slice(0, -4)],
      [
        'a file cut short inside moov',
        () => identifyingMovie({ layout: 'moov-last' }).slice(0, -4),
      ],
      ['no moov at all', () => concat(ftyp, box('mdat', MOVIE_SAMPLES))],
      [
        'two moov boxes',
        () => concat(ftyp, moovWith(), moovWith(), box('mdat', MOVIE_SAMPLES)),
      ],
      [
        'trailing bytes too short for a box header',
        () => identifyingMovie({ trailer: [Uint8Array.of(1, 2, 3)] }),
      ],
      [
        'a 64-bit size beyond the file',
        () =>
          concat(
            ftyp,
            moovWith(identifyingUdta()),
            u32be(1),
            ascii('mdat'),
            u32be(0),
            u32be(0xffff),
          ),
      ],
      [
        'a 64-bit size beyond what a number can hold',
        () =>
          concat(
            ftyp,
            moovWith(identifyingUdta()),
            u32be(1),
            ascii('mdat'),
            u32be(0xffffffff),
            u32be(0xffffffff),
          ),
      ],
      [
        'a box smaller than its own header',
        () =>
          concat(ftyp, moovWith(identifyingUdta()), u32be(4), ascii('free')),
      ],
      [
        'a moov child running past moov',
        () =>
          identifyingMovie({
            moovTrailer: concat(u32be(4096), ascii('udta')),
          }),
      ],
      [
        'a nested box of size 0',
        () =>
          identifyingMovie({
            moovMetadata: [identifyingUdta([concat(u32be(0), ascii('free'))])],
          }),
      ],
      [
        'a keys count beyond its box',
        () =>
          identifyingMovie({
            moovMetadata: [
              box(
                'meta',
                metadataHandler('mdta'),
                fullBox('keys', 0, u32be(1_000_000)),
                box('ilst'),
              ),
            ],
          }),
      ],
      [
        'a key entry running past its box',
        () =>
          identifyingMovie({
            moovMetadata: [
              box(
                'meta',
                metadataHandler('mdta'),
                fullBox('keys', 0, u32be(1), u32be(4096), ascii('mdta')),
              ),
            ],
          }),
      ],
      [
        'a key name over 1 KiB',
        () =>
          identifyingMovie({
            moovMetadata: [
              keyedMeta([
                [`com.apple.quicktime.location.${'x'.repeat(2048)}`, ISO6709],
              ]),
            ],
          }),
      ],
      [
        'a meta box without a handler',
        () =>
          identifyingMovie({
            moovMetadata: [box('meta', box('ilst', box('\xa9xyz')))],
          }),
      ],
      [
        'two keys boxes in one meta',
        () => {
          const keys = fullBox('keys', 0, u32be(0));
          return identifyingMovie({
            moovMetadata: [box('meta', metadataHandler('mdta'), keys, keys)],
          });
        },
      ],
      [
        'a data box too short for its type and locale',
        () =>
          identifyingMovie({
            moovMetadata: [
              fullBox(
                'meta',
                0,
                metadataHandler('mdir'),
                box('ilst', box('\xa9xyz', box('data', u32be(1)))),
              ),
            ],
          }),
      ],
    ])('leaves %s unchanged', async (_label, build) => {
      expect(await verdict(build())).toEqual(MALFORMED);
    });

    it('leaves a fragmented movie unchanged', async () => {
      const withMvex = identifyingMovie({
        moovMetadata: [identifyingUdta(), box('mvex', fullBox('trex', 0))],
      });
      const withMoof = identifyingMovie({
        trailer: [box('moof', fullBox('mfhd', 0, u32be(1))), box('mdat')],
      });

      expect(await verdict(withMvex)).toEqual(UNSUPPORTED);
      expect(await verdict(withMoof)).toEqual(UNSUPPORTED);
    });

    it('never patches anything when it gives up part way through moov', async () => {
      // The location comes first and is valid; the box after it is broken.
      const input = identifyingMovie({
        moovTrailer: concat(u32be(4096), ascii('udta')),
      });
      const movie = topLevelBox(input, 'moov');
      const view: ReadRange = (start, end) =>
        Promise.resolve(input.subarray(start, end));
      const before = input.slice();

      expect(await stripVideoMetadata(view, input.length)).toEqual(MALFORMED);
      expect(input.subarray(movie.start, movie.end)).toEqual(
        before.subarray(movie.start, movie.end),
      );
    });

    it('leaves a movie whose reads fail unchanged', async () => {
      const read: ReadRange = () => Promise.reject(new Error('NotReadable'));

      expect(await stripVideoMetadata(read, 4096)).toEqual(MALFORMED);
    });
  });

  describe('hostile structure counts', () => {
    async function expectQuick(input: Bytes, expected: unknown): Promise<void> {
      const started = performance.now();
      const result = await verdict(input);
      const elapsed = performance.now() - started;

      expect(result).toEqual(expected);
      expect(elapsed).toBeLessThan(250);
    }

    it('gives up on a file made of thousands of tiny top-level boxes', async () => {
      const input = concat(identifyingMovie(), repeated(box('free'), 5_000));

      await expectQuick(input, MALFORMED);
    });

    it.each([
      ['udta children', () => box('udta', repeated(box('\xa9too'), 200_000))],
      [
        'ilst items',
        () =>
          box(
            'meta',
            metadataHandler('mdir'),
            box('ilst', repeated(box('\xa9too'), 200_000)),
          ),
      ],
      [
        'tracks',
        () => repeated(box('trak', box('udta', box('\xa9too'))), 200_000),
      ],
    ])(
      'gives up on a moov with hundreds of thousands of %s',
      async (_label, build) => {
        const input = identifyingMovie({ moovMetadata: [build()] });

        await expectQuick(input, MALFORMED);
      },
    );

    it('still strips movies with many structures under the caps', async () => {
      const input = concat(
        identifyingMovie({
          moovMetadata: [
            identifyingUdta([repeated(box('\xa9too'), 500)]),
            ...Array.from({ length: 50 }, () => box('trak', MOVIE_TKHD)),
          ],
        }),
        repeated(box('free'), 500),
      );

      const out = await stripped(input);

      expectNoIdentifyingMetadata(out);
    });
  });
});
