import { describe, expect, it } from 'vitest';
import { readTiffOrientation } from './exif-orientation';
import {
  HOSTILE_INPUT_BUDGET_MS,
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
  identifyingDngPage,
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
  expect(elapsed).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
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
        '+02:00',
        '0123456789abcdef',
        'Berlin trip',
        'Page by',
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

  describe('camera raw files', () => {
    /** What a raw must keep: everything a raw converter reads, GPS aside. */
    const RAW_KEEPS = [
      'Canon',
      'EOS R6',
      'makernote',
      'SN-0123456789',
      'xpacket',
    ];

    it('blanks only the GPS IFD of a DNG, found by its DNGVersion tag', () => {
      const layout = tiffLayout('II', [identifyingDngPage('II')]);

      const out = stripped(layout.bytes);

      expect(Array.from(out)).toEqual(
        Array.from(expectedStrip(layout, { raw: true })),
      );
      for (const marker of RAW_KEEPS) {
        expect(containsAscii(out, marker), marker).toBe(true);
      }
    });

    it.each([
      ['a raw file name', { name: 'DSC_0001.NEF' }],
      ['a raw file name without a type', { name: 'IMG_0001.cr2', type: '' }],
      ['a raw MIME type', { name: 'download', type: 'image/x-nikon-nef' }],
      ['a DNG MIME type', { type: 'image/x-adobe-dng' }],
      ['a Hasselblad file name', { name: 'B0001234.fff' }],
      ['a Mamiya file name', { name: 'IMG_0001.MEF' }],
      ['a vendor raw MIME type', { type: 'image/x-panasonic-raw' }],
    ])('blanks only the GPS IFD of a TIFF named by %s', (_label, hints) => {
      const layout = tiffLayout('MM', [identifyingPage('MM')]);

      const result = stripImageMetadata(layout.bytes, hints);
      if (result.kind !== 'stripped') throw new Error(result.reason);

      expect(Array.from(joinParts(result.parts))).toEqual(
        Array.from(expectedStrip(layout, { raw: true })),
      );
    });

    it('reports a raw file without GPS as clean', () => {
      const layout = tiffLayout('MM', [
        { ...identifyingPage('MM'), gps: undefined },
      ]);

      expect(
        stripImageMetadata(layout.bytes, { name: 'DSC_0001.nef' }),
      ).toEqual({ kind: 'unchanged', reason: 'clean' });
    });

    it.each([
      ['a .tif name', { name: 'scan.tif', type: 'image/tiff' }],
      ['a .tiff name', { name: 'scan.TIFF' }],
      ['a raw-looking word that is not the extension', { name: 'nef.tif' }],
      ['no name at all', {}],
      ['a nameless blob with an empty type', { type: '' }],
      [
        'a .raw file name, which says nothing of the format',
        { name: 'scan.raw' },
      ],
    ])('still blanks the full list for %s', (_label, hints) => {
      const layout = tiffLayout('MM', [identifyingPage('MM')]);

      const result = stripImageMetadata(layout.bytes, hints);
      if (result.kind !== 'stripped') throw new Error(result.reason);

      expect(Array.from(joinParts(result.parts))).toEqual(
        Array.from(expectedStrip(layout)),
      );
    });
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

  describe('crafted overlaps', () => {
    /** A little-endian TIFF writer over a zeroed buffer of `length` bytes. */
    function craft(length: number) {
      const bytes = new Uint8Array(length);
      const view = new DataView(bytes.buffer);
      bytes.set([0x49, 0x49, 42, 0]);
      return {
        bytes,
        u16: (at: number, value: number) => view.setUint16(at, value, true),
        u32: (at: number, value: number) => view.setUint32(at, value, true),
        entry: (
          at: number,
          tag: number,
          type: number,
          count: number,
          value: number,
        ) => {
          view.setUint16(at, tag, true);
          view.setUint16(at + 2, type, true);
          view.setUint32(at + 4, count, true);
          view.setUint32(at + 8, value, true);
        },
      };
    }

    it('leaves a TIFF whose Make points at the header unchanged', () => {
      const t = craft(16 + 2 + 3 * 12 + 4 + 4);
      t.u32(4, 16);
      t.u16(16, 3);
      t.entry(18, 271, 2, 8, 0); // Make: 8 ASCII bytes at offset 0, the header
      t.entry(30, 273, 4, 1, 58);
      t.entry(42, 279, 4, 1, 4);

      expectMalformed(t.bytes);
    });

    it('leaves a TIFF whose Exif IFD overlaps IFD0 unchanged', () => {
      // IFD0 at 8 holds 4 entries (8..62). Its Exif pointer leads to 36, inside IFD0, where
      // entry 3 reads as "DateTimeOriginal" whose inline value is IFD0's next-IFD pointer.
      const t = craft(150);
      t.u32(4, 8);
      t.u16(8, 4);
      t.entry(10, 273, 4, 1, 140);
      t.entry(22, 279, 4, 1, 4);
      t.entry(34, 34665, 4, 1, 36);
      t.entry(46, 65000, 0, 0x00029003, 4);
      t.u32(58, 100); // page 2
      t.u16(100, 2);
      t.entry(102, 273, 4, 1, 144);
      t.entry(114, 279, 4, 1, 4);
      t.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 140);

      expectMalformed(t.bytes);
    });

    it('leaves a TIFF whose page tables overlap unchanged', () => {
      const layout = tiffLayout('MM', [identifyingPage('MM')]);
      const ifd0 = at(layout, 'page0');
      // Page 2 starts 12 bytes into IFD0: its table shares IFD0's entries.
      expectMalformed(
        pointAt(
          layout,
          'MM',
          (layout.ifds.get('page0')?.[1] ?? 0) - 4,
          ifd0 + 12,
        ),
      );
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
