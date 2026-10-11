/**
 * Byte-level TIFF builders for the metadata-stripping specs. {@link tiffLayout} writes a
 * classic TIFF from labelled IFDs and reports where every IFD table and every entry value
 * landed, so a spec can predict the exact bytes a strip must zero and patch offsets to
 * craft malformed files.
 */
import { XMP_PACKET, ascii, concat } from './image-metadata.fixture';

export type TiffOrder = 'II' | 'MM';

export const BYTE = 1;
export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;

export interface FixtureEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Raw value bytes in the file's byte order. */
  readonly value: Uint8Array;
}

export interface FixtureIfd {
  readonly label: string;
  readonly entries: readonly FixtureEntry[];
  /** Written as an Exif IFD pointer (34665). */
  readonly exif?: FixtureIfd;
  /** Written as a GPS IFD pointer (34853). */
  readonly gps?: FixtureIfd;
  /** One strip of image data, written with StripOffsets, RowsPerStrip, StripByteCounts. */
  readonly strip?: Uint8Array;
}

export interface TiffLayout {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Each IFD table's `[start, end)`, from its entry count to its next-IFD pointer. */
  readonly ifds: ReadonlyMap<string, readonly [number, number]>;
  /**
   * Each entry's value bytes, keyed `label:tag`: the 4-byte field for an inline value,
   * the external data otherwise. `label:strip` is the strip's image data.
   */
  readonly values: ReadonlyMap<string, readonly [number, number]>;
}

/** Value encoders for one byte order. */
export function tiffValues(order: TiffOrder) {
  const le = order === 'II';
  const short = (v: number) =>
    le ? Uint8Array.of(v & 0xff, v >> 8) : Uint8Array.of(v >> 8, v & 0xff);
  const long = (v: number) => {
    const be = Uint8Array.of(
      v >>> 24,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    );
    return le ? be.reverse() : be;
  };
  return {
    short,
    long,
    entry: (tag: number, type: number, count: number, value: Uint8Array) =>
      ({ tag, type, count, value }) satisfies FixtureEntry,
    text: (tag: number, text: string): FixtureEntry => ({
      tag,
      type: ASCII,
      count: text.length + 1,
      value: ascii(`${text}\0`),
    }),
    shortEntry: (tag: number, v: number): FixtureEntry => ({
      tag,
      type: SHORT,
      count: 1,
      value: short(v),
    }),
    rational: (tag: number, n: number, d: number): FixtureEntry => ({
      tag,
      type: RATIONAL,
      count: 1,
      value: concat(long(n), long(d)),
    }),
  };
}

export function writeTiffU16(
  bytes: Uint8Array,
  at: number,
  value: number,
  order: TiffOrder,
): void {
  bytes.set(tiffValues(order).short(value), at);
}

export function writeTiffU32(
  bytes: Uint8Array,
  at: number,
  value: number,
  order: TiffOrder,
): void {
  bytes.set(tiffValues(order).long(value), at);
}

/** A classic TIFF whose IFD chain holds `pages`, in order. */
export function tiffLayout(
  order: TiffOrder,
  pages: readonly FixtureIfd[],
): TiffLayout {
  const v = tiffValues(order);
  let buf = new Uint8Array(1024);
  let end = 0;
  const ifds = new Map<string, readonly [number, number]>();
  const values = new Map<string, readonly [number, number]>();

  const alloc = (length: number): number => {
    end += end % 2; // values start on a word boundary
    const at = end;
    end += length;
    if (end > buf.length) {
      const grown = new Uint8Array(Math.max(end, buf.length * 2));
      grown.set(buf);
      buf = grown;
    }
    return at;
  };
  const put = (at: number, bytes: Uint8Array) => buf.set(bytes, at);

  const writeIfd = (ifd: FixtureIfd): readonly [number, number] => {
    const entries: FixtureEntry[] = [...ifd.entries];
    if (ifd.strip) {
      entries.push(
        v.entry(273, LONG, 1, v.long(0)),
        v.shortEntry(278, 1),
        v.entry(279, LONG, 1, v.long(ifd.strip.length)),
      );
    }
    if (ifd.exif) entries.push(v.entry(34665, LONG, 1, v.long(0)));
    if (ifd.gps) entries.push(v.entry(34853, LONG, 1, v.long(0)));
    entries.sort((a, b) => a.tag - b.tag);

    const table = alloc(2 + entries.length * 12 + 4);
    const tableEnd = table + 2 + entries.length * 12 + 4;
    ifds.set(ifd.label, [table, tableEnd]);
    put(table, v.short(entries.length));
    entries.forEach((entry, i) => {
      const at = table + 2 + i * 12;
      let value = entry.value;
      if (entry.tag === 273 && ifd.strip) {
        const strip = alloc(ifd.strip.length);
        put(strip, ifd.strip);
        values.set(`${ifd.label}:strip`, [strip, strip + ifd.strip.length]);
        value = v.long(strip);
      } else if (entry.tag === 34665 && ifd.exif) {
        value = v.long(writeIfd(ifd.exif)[0]);
      } else if (entry.tag === 34853 && ifd.gps) {
        value = v.long(writeIfd(ifd.gps)[0]);
      }
      put(at, v.short(entry.tag));
      put(at + 2, v.short(entry.type));
      put(at + 4, v.long(entry.count));
      if (value.length > 4) {
        const data = alloc(value.length);
        put(data, value);
        put(at + 8, v.long(data));
        values.set(`${ifd.label}:${entry.tag}`, [data, data + value.length]);
      } else {
        put(at + 8, value);
        values.set(`${ifd.label}:${entry.tag}`, [at + 8, at + 12]);
      }
    });
    return [table, tableEnd];
  };

  alloc(8);
  put(0, ascii(order));
  put(2, v.short(42));
  let nextAt = 4;
  for (const page of pages) {
    const [table, tableEnd] = writeIfd(page);
    put(nextAt, v.long(table));
    nextAt = tableEnd - 4;
  }
  return { bytes: buf.slice(0, end), ifds, values };
}

export const TIFF_PIXELS = ascii('uncompressed-pixel-strip');
export const TIFF_ICC = ascii('fake-icc-profile');

/** Tags whose values a strip must zero in an image IFD. */
export const IMAGE_IFD_TARGETS = [
  270, 271, 272, 305, 306, 315, 316, 700, 33432, 33723, 34377,
] as const;
/** Tags whose values a strip must zero in an Exif IFD. */
export const EXIF_IFD_TARGETS = [
  36867, 36868, 37500, 37510, 42032, 42033, 42035, 42036, 42037,
] as const;

/** A camera-style page: every identifying IFD0 tag, an Exif IFD and a GPS IFD. */
export function identifyingPage(
  order: TiffOrder,
  label = 'page0',
  orientation = 6,
): FixtureIfd {
  const v = tiffValues(order);
  return {
    label,
    strip: TIFF_PIXELS,
    entries: [
      v.shortEntry(256, 24),
      v.shortEntry(257, 1),
      v.shortEntry(258, 8),
      v.shortEntry(259, 1),
      v.shortEntry(262, 1),
      v.text(270, 'Shot at home'),
      v.text(271, 'Canon'),
      v.text(272, 'EOS R6'),
      v.shortEntry(274, orientation),
      v.shortEntry(277, 1),
      v.text(305, 'Photoshop 2026'),
      v.text(306, '2026:10:01 12:34:56'),
      v.text(315, 'Alice Example'),
      v.text(316, 'alice-macbook'),
      v.entry(700, BYTE, XMP_PACKET.length, ascii(XMP_PACKET)),
      v.text(33432, 'Copyright Alice Example'),
      v.entry(33723, UNDEFINED, 12, ascii('City: Berlin')),
      v.entry(34377, BYTE, 18, ascii('8BIM\x04\x04City Berlin')),
      v.entry(34675, UNDEFINED, TIFF_ICC.length, TIFF_ICC),
    ],
    exif: {
      label: `${label}-exif`,
      entries: [
        v.rational(33434, 1, 125),
        v.text(36867, '2026:10:01 12:34:56'),
        v.text(36868, '2026:10:01 12:34:56'),
        v.entry(37500, UNDEFINED, 24, ascii('Canon makernote lens1234')),
        v.entry(37510, UNDEFINED, 20, ascii('ASCII\0\0\0Shot at home')),
        v.shortEntry(40961, 1),
        v.text(42032, 'Alice Example'),
        v.text(42033, 'SN-0123456789'),
        v.text(42035, 'Canon'),
        v.text(42036, 'RF 24-105mm'),
        v.text(42037, 'LSN-9876543'),
      ],
    },
    gps: {
      label: `${label}-gps`,
      entries: [
        v.entry(0x0000, BYTE, 4, Uint8Array.of(2, 3, 0, 0)),
        v.text(0x0001, 'N'),
        v.entry(
          0x0002,
          RATIONAL,
          3,
          concat(
            v.long(52),
            v.long(1),
            v.long(31),
            v.long(1),
            v.long(12),
            v.long(1),
          ),
        ),
        v.entry(0x001b, UNDEFINED, 8, ascii('52.5200N')),
      ],
    },
  };
}

/** A page with only image structure and a few harmless tags. */
export function cleanPage(order: TiffOrder, label = 'page0'): FixtureIfd {
  const v = tiffValues(order);
  return {
    label,
    strip: TIFF_PIXELS,
    entries: [
      v.shortEntry(256, 24),
      v.shortEntry(257, 1),
      v.shortEntry(258, 8),
      v.shortEntry(259, 1),
      v.shortEntry(262, 1),
      v.shortEntry(274, 6),
      v.shortEntry(277, 1),
      v.entry(34675, UNDEFINED, TIFF_ICC.length, TIFF_ICC),
    ],
  };
}

/**
 * The bytes a strip of `layout` must produce: each GPS IFD's table and values zeroed and,
 * unless the file is a camera raw, every other target value zeroed too.
 */
export function expectedStrip(
  layout: TiffLayout,
  { raw = false }: { readonly raw?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  const out = layout.bytes.slice();
  for (const [key, [start, end]] of layout.values) {
    const [label = '', tagText = ''] = key.split(':');
    const tag = Number(tagText);
    const target = label.endsWith('-gps')
      ? true
      : raw
        ? false
        : label.endsWith('-exif')
          ? (EXIF_IFD_TARGETS as readonly number[]).includes(tag)
          : (IMAGE_IFD_TARGETS as readonly number[]).includes(tag);
    if (target) out.fill(0, start, end);
  }
  for (const [label, [start, end]] of layout.ifds) {
    if (label.endsWith('-gps')) out.fill(0, start, end);
  }
  return out;
}

/** {@link identifyingPage} as a DNG writes it: the same tags plus DNGVersion 1.4. */
export function identifyingDngPage(order: TiffOrder): FixtureIfd {
  const page = identifyingPage(order);
  return {
    ...page,
    entries: [
      ...page.entries,
      tiffValues(order).entry(50706, BYTE, 4, Uint8Array.of(1, 4, 0, 0)),
    ],
  };
}

/** `count` empty IFDs chained one after another. */
export function longChainTiff(count: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + count * 6);
  out.set(ascii('MM\0*'));
  writeTiffU32(out, 4, 8, 'MM');
  for (let i = 0; i + 1 < count; i++) {
    const at = 8 + i * 6;
    writeTiffU32(out, at + 2, at + 6, 'MM');
  }
  return out;
}

/** `ifds` chained IFDs of `perIfd` harmless SHORT entries each, then a Make. */
export function manyEntriesTiff(
  perIfd: number,
  ifds: number,
): Uint8Array<ArrayBuffer> {
  const v = tiffValues('MM');
  const filler = Array.from({ length: perIfd }, () => v.shortEntry(0xc000, 1));
  return tiffLayout(
    'MM',
    Array.from({ length: ifds }, (_, i) => ({
      label: `page${i}`,
      entries: i === ifds - 1 ? [...filler, v.text(271, 'Canon')] : filler,
    })),
  ).bytes;
}

/** A page whose image data is `strips` one-byte strips, and a Make to blank. */
export function manyStripsTiff(strips: number): Uint8Array<ArrayBuffer> {
  const v = tiffValues('MM');
  const header = 8;
  const entries = 3;
  const table = 2 + entries * 12 + 4;
  const make = header + table;
  const offsets = make + 6;
  const counts = offsets + strips * 4;
  const data = counts + strips * 4;
  const out = new Uint8Array(data + strips);
  out.set(ascii('MM\0*'));
  writeTiffU32(out, 4, header, 'MM');
  writeTiffU16(out, header, entries, 'MM');
  const entry = (
    i: number,
    tag: number,
    type: number,
    count: number,
    value: number,
  ) => {
    const at = header + 2 + i * 12;
    out.set(
      concat(v.short(tag), v.short(type), v.long(count), v.long(value)),
      at,
    );
  };
  entry(0, 271, ASCII, 6, make);
  entry(1, 273, LONG, strips, offsets);
  entry(2, 279, LONG, strips, counts);
  out.set(ascii('Canon\0'), make);
  for (let i = 0; i < strips; i++) {
    writeTiffU32(out, offsets + i * 4, data + i, 'MM');
    writeTiffU32(out, counts + i * 4, 1, 'MM');
  }
  return out;
}
