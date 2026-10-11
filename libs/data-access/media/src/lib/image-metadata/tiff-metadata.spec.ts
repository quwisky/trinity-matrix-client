import { describe, expect, it } from 'vitest';
import { readTiffOrientation } from './exif-orientation';
import {
  IDENTIFYING_MARKERS,
  ascii,
  concat,
  containsAscii,
  containsBytes,
} from './image-metadata.fixture';
import {
  joinParts,
  strippableFormat,
  stripImageMetadata,
} from './image-metadata';
import {
  TIFF_ICC,
  TIFF_PIXELS,
  cleanPage,
  expectedStrip,
  identifyingPage,
  longChainTiff,
  manyEntriesTiff,
  manyStripsTiff,
  tiffLayout,
  tiffValues,
  writeTiffU16,
  writeTiffU32,
  type TiffLayout,
  type TiffOrder,
} from './tiff-metadata.fixture';

function stripped(input: Uint8Array<ArrayBuffer>): Uint8Array {
  const result = stripImageMetadata(input);
  if (result.kind !== 'stripped') {
    throw new Error(`expected a strip, got ${result.kind}/${result.reason}`);
  }
  expect(result.format).toBe('tiff');
  const bytes = joinParts(result.parts);
  expect(bytes.byteLength).toBe(result.byteLength);
  return bytes;
}

function expectMalformed(input: Uint8Array<ArrayBuffer>): void {
  expect(stripImageMetadata(input)).toEqual({
    kind: 'unchanged',
    reason: 'malformed',
  });
}

function expectQuickMalformed(input: Uint8Array<ArrayBuffer>): void {
  const started = performance.now();
  const result = stripImageMetadata(input);
  const elapsed = performance.now() - started;

  expect(result).toEqual({ kind: 'unchanged', reason: 'malformed' });
  expect(elapsed).toBeLessThan(100);
}

function at(layout: TiffLayout, key: string): number {
  const range = layout.values.get(key) ?? layout.ifds.get(key);
  if (!range) throw new Error(`no ${key} in the fixture`);
  return range[0];
}

/** Point the IFD entry whose value field starts at `field` somewhere else. */
function pointAt(
  layout: TiffLayout,
  order: TiffOrder,
  field: number,
  target: number,
): Uint8Array<ArrayBuffer> {
  const bytes = layout.bytes.slice();
  writeTiffU32(bytes, field, target, order);
  return bytes;
}

/** The value-field offset of `tag`'s entry in the IFD at `ifd`. */
function entryField(
  layout: TiffLayout,
  order: TiffOrder,
  ifd: string,
  tag: number,
): number {
  const [start, end] = layout.ifds.get(ifd) ?? [0, 0];
  const tagBytes = tiffValues(order).short(tag);
  for (let entry = start + 2; entry + 12 <= end; entry += 12) {
    if (
      layout.bytes[entry] === tagBytes[0] &&
      layout.bytes[entry + 1] === tagBytes[1]
    ) {
      return entry + 8;
    }
  }
  throw new Error(`no tag ${tag} in ${ifd}`);
}

describe('stripImageMetadata: TIFF', () => {
  it('recognises classic TIFF in both byte orders, but not BigTIFF', () => {
    expect(strippableFormat(ascii('II*\0'))).toBe('tiff');
    expect(strippableFormat(ascii('MM\0*'))).toBe('tiff');
    expect(strippableFormat(ascii('II+\0'))).toBeNull();
    expect(strippableFormat(ascii('MM\0+'))).toBeNull();
  });

  it.each(['II', 'MM'] as const)(
    'zeroes identifying values in place in a %s TIFF, moving no offset',
    (order) => {
      const layout = tiffLayout(order, [identifyingPage(order)]);
      const input = layout.bytes;
      for (const marker of IDENTIFYING_MARKERS) {
        expect(containsAscii(input, marker), marker).toBe(true);
      }

      const out = stripped(input);

      expect(out.length).toBe(input.length);
      for (const marker of [
        ...IDENTIFYING_MARKERS,
        'SN-0123456789',
        'LSN-9876543',
        'alice-macbook',
        'Photoshop 2026',
        'RF 24-105mm',
        '8BIM',
        'makernote',
      ]) {
        expect(containsAscii(out, marker), marker).toBe(false);
      }
      expect(Array.from(out)).toEqual(Array.from(expectedStrip(layout)));
    },
  );

  it('keeps the orientation, colour profile, exposure and image data', () => {
    const layout = tiffLayout('II', [identifyingPage('II')]);

    const out = stripped(layout.bytes);

    expect(readTiffOrientation(out)).toBe(6);
    expect(containsBytes(out, TIFF_PIXELS)).toBe(true);
    expect(containsBytes(out, TIFF_ICC)).toBe(true);
    const [exposure, exposureEnd] = layout.values.get('page0-exif:33434') ?? [
      0, 0,
    ];
    expect(Array.from(out.subarray(exposure, exposureEnd))).toEqual(
      Array.from(layout.bytes.subarray(exposure, exposureEnd)),
    );
  });

  it('empties the GPS IFD: no entries and no next IFD', () => {
    const layout = tiffLayout('MM', [identifyingPage('MM')]);

    const out = stripped(layout.bytes);

    const gps = at(layout, 'page0-gps');
    expect(Array.from(out.subarray(gps, gps + 6))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('blanks every page of a multi-page TIFF', () => {
    const layout = tiffLayout('II', [
      identifyingPage('II', 'page0'),
      cleanPage('II', 'page1'),
      identifyingPage('II', 'page2', 1),
    ]);

    const out = stripped(layout.bytes);

    expect(Array.from(out)).toEqual(Array.from(expectedStrip(layout)));
    expect(containsAscii(out, 'Canon')).toBe(false);
  });

  it('reports a TIFF without identifying tags as clean', () => {
    expect(
      stripImageMetadata(tiffLayout('MM', [cleanPage('MM')]).bytes),
    ).toEqual({ kind: 'unchanged', reason: 'clean' });
  });

  it('reports a TIFF whose identifying values are already zero as clean', () => {
    const out = stripped(tiffLayout('MM', [identifyingPage('MM')]).bytes);

    expect(stripImageMetadata(Uint8Array.from(out))).toEqual({
      kind: 'unchanged',
      reason: 'clean',
    });
  });

  it('strips a 500-page TIFF', () => {
    const pages = Array.from({ length: 500 }, (_, i) =>
      identifyingPage('MM', `page${i}`),
    );

    const out = stripped(tiffLayout('MM', pages).bytes);

    expect(containsAscii(out, 'Canon')).toBe(false);
  });

  describe('fail-open', () => {
    const order = 'MM';
    const layout = tiffLayout(order, [
      identifyingPage(order, 'page0'),
      identifyingPage(order, 'page1'),
    ]);

    it.each([
      [
        'an IFD0 offset past the end',
        () => pointAt(layout, order, 4, 0x7fff_fff0),
      ],
      ['an IFD0 offset inside the header', () => pointAt(layout, order, 4, 2)],
      [
        'a next-IFD pointer past the end',
        () =>
          pointAt(
            layout,
            order,
            (layout.ifds.get('page1')?.[1] ?? 0) - 4,
            0x7fff_fff0,
          ),
      ],
      [
        'an IFD chain that loops back to the first page',
        () =>
          pointAt(
            layout,
            order,
            (layout.ifds.get('page1')?.[1] ?? 0) - 4,
            at(layout, 'page0'),
          ),
      ],
      [
        'an IFD that points to itself',
        () =>
          pointAt(
            layout,
            order,
            (layout.ifds.get('page0')?.[1] ?? 0) - 4,
            at(layout, 'page0'),
          ),
      ],
      [
        'an Exif IFD pointer to an IFD already visited',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 34665),
            at(layout, 'page0'),
          ),
      ],
      [
        'a GPS IFD past the end',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 34853),
            0x7fff_fff0,
          ),
      ],
      [
        'a GPS IFD on top of the image data',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 34853),
            at(layout, 'page0:strip'),
          ),
      ],
      [
        'a Make value past the end',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 271),
            0x7fff_fff0,
          ),
      ],
      [
        'a Make value on top of the image data',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 271),
            at(layout, 'page0:strip'),
          ),
      ],
      [
        'a Make value on top of an IFD table',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 271),
            at(layout, 'page1'),
          ),
      ],
      [
        'a Make value on top of the colour profile',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 271),
            at(layout, 'page0:34675'),
          ),
      ],
      [
        'a MakerNote on top of the image data',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0-exif', 37500),
            at(layout, 'page0:strip'),
          ),
      ],
      [
        'a strip past the end',
        () =>
          pointAt(
            layout,
            order,
            entryField(layout, order, 'page0', 273),
            0x7fff_fff0,
          ),
      ],
      [
        'an IFD whose entry count runs past the end',
        () => {
          const bytes = layout.bytes.slice();
          writeTiffU16(bytes, at(layout, 'page1'), 0xffff, order);
          return bytes;
        },
      ],
      [
        'an identifying entry of an unknown type',
        () => {
          const bytes = layout.bytes.slice();
          writeTiffU16(
            bytes,
            entryField(layout, order, 'page0', 271) - 6,
            99,
            order,
          );
          return bytes;
        },
      ],
      [
        'a truncated file',
        () => layout.bytes.slice(0, at(layout, 'page1') + 20),
      ],
      ['only a header', () => ascii('MM\0*')],
    ])('leaves a TIFF with %s unchanged', (_label, build) => {
      expectMalformed(build());
    });

    it('leaves BigTIFF unchanged as unsupported', () => {
      const bigTiff = concat(
        ascii('II+\0'),
        Uint8Array.of(8, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0),
        ascii('Canon'),
      );

      expect(stripImageMetadata(bigTiff)).toEqual({
        kind: 'unchanged',
        reason: 'unsupported',
      });
    });
  });

  describe('hostile structure counts', () => {
    it.each([
      ['a chain of 100,000 IFDs', () => longChainTiff(100_000)],
      [
        'IFDs with 150,000 entries between them',
        () => manyEntriesTiff(50_000, 3),
      ],
      ['more than a million strips', () => manyStripsTiff((1 << 20) + 1)],
    ])('returns a TIFF with %s unchanged, quickly', (_label, build) => {
      expectQuickMalformed(build());
    });

    it('still strips files under the caps', () => {
      expect(stripImageMetadata(longChainTiff(4_096))).toEqual({
        kind: 'unchanged',
        reason: 'clean',
      });
      expect(stripImageMetadata(longChainTiff(4_097))).toEqual({
        kind: 'unchanged',
        reason: 'malformed',
      });
      expect(stripImageMetadata(manyEntriesTiff(20_000, 3)).kind).toBe(
        'stripped',
      );
      expect(stripImageMetadata(manyStripsTiff(100_000)).kind).toBe('stripped');
    });
  });
});
