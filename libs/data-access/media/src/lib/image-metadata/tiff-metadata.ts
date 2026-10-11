import {
  type FileHints,
  CLEAN,
  MALFORMED,
  MAX_WALK_STEPS,
  MalformedImage,
  type Bytes,
  type FormatStrip,
} from './byte-parts';

/** Bytes per value of each TIFF 6.0 field type (1-12) and the Exif IFD type (13). */
const TYPE_SIZES: readonly number[] = [
  0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4,
];
const LONG = 4;
const SHORT = 3;
const IFD_TYPE = 13;

const SUB_IFDS = 330;
const EXIF_IFD = 34665;
const GPS_IFD = 34853;
const INTEROPERABILITY_IFD = 40965;
const DNG_VERSION = 50706;

/**
 * Camera raw formats built on TIFF, by file extension or the last part of a MIME subtype
 * (`image/x-nikon-nef`, `image/x-adobe-dng`). Some (ORF, RW2, RAF, X3F, MRW) use their own
 * magic and never reach this parser; they are listed so the rule reads as one set.
 */
const RAW_FORMATS = new Set([
  'dng',
  'cr2',
  'nef',
  'nrw',
  'arw',
  'srf',
  'sr2',
  'pef',
  'orf',
  'rw2',
  'raf',
  '3fr',
  'iiq',
  'erf',
  'srw',
  'mos',
  'kdc',
  'dcr',
  'mrw',
  'x3f',
]);

/**
 * Identifying tags of an image IFD: ImageDescription, Make, Model, Software, DateTime,
 * Artist, HostComputer, XMP, Copyright, IPTC and Photoshop image resources.
 */
const IMAGE_TARGETS = new Set([
  270, 271, 272, 305, 306, 315, 316, 700, 33432, 33723, 34377,
]);

/**
 * Identifying tags of an Exif IFD: capture times, MakerNote, UserComment, owner name, body
 * and lens serial numbers, lens make and model.
 */
const EXIF_TARGETS = new Set([
  36867, 36868, 37500, 37510, 42032, 42033, 42035, 42036, 42037,
]);

/** Offset/length tag pairs that locate image data: strips, tiles, a JPEG thumbnail. */
const IMAGE_DATA_TAGS: readonly (readonly [number, number])[] = [
  [273, 279],
  [324, 325],
  [513, 514],
];

/**
 * Upper bound on IFDs visited: pages, SubIFDs, Exif, GPS and Interoperability IFDs. A
 * multi-page scan has one per page and a camera page three; the cap stops a crafted chain
 * of millions of tiny IFDs.
 */
const MAX_IFDS = 4096;

/** Upper bound on IFD entries across the file, shared with the other formats' walks. */
const MAX_ENTRIES = MAX_WALK_STEPS;

/** Upper bound on strips and tiles across the file; each is one range check. */
const MAX_IMAGE_RANGES = 1 << 20;

type IfdKind = 'image' | 'exif' | 'gps' | 'other';

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Offset of the 4-byte value field. */
  readonly field: number;
  /** Bytes of value data, or -1 for a type this reader does not know. */
  readonly size: number;
}

interface Ifd {
  readonly kind: IfdKind;
  readonly start: number;
  readonly end: number;
  readonly entries: readonly Entry[];
}

interface Range {
  readonly start: number;
  readonly end: number;
}

/** Classic TIFF only: "II*\0" or "MM\0*". BigTIFF (43) is left to the caller as unsupported. */
export function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    (bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 42 &&
      bytes[3] === 0) ||
    (bytes[0] === 0x4d &&
      bytes[1] === 0x4d &&
      bytes[2] === 0 &&
      bytes[3] === 42)
  );
}

/**
 * Zero identifying values in a classic TIFF in place, so no offset anywhere moves.
 *
 * A camera raw (any IFD carries DNGVersion, or `hints` name a raw format) only has its GPS
 * IFD emptied. Raw converters read Make, Model, MakerNote and the rest to decode the
 * sensor data, so those stay; GPS plays no part in decoding.
 *
 * In every image IFD (the page chain and SubIFDs) the values of ImageDescription, Make,
 * Model, Software, DateTime, Artist, HostComputer, XMP, Copyright, IPTC and Photoshop
 * resources are zeroed; in each Exif IFD, capture times, MakerNote, UserComment, owner
 * name, lens make/model and serial numbers. A GPS IFD is emptied: its table (count, entries
 * with their inline values, next pointer) and its external values are zeroed. Entries keep
 * their tag, type and count, so the structure stays valid; Orientation, colour, strip and
 * tile tags and all image data are untouched.
 *
 * A value is only zeroed when it lies inside the file and away from every IFD table, every
 * value that is kept and all image data; anything else leaves the file unchanged. TIFFs are
 * rare uploads, so the output is one modified copy rather than views into the input.
 */
export function stripTiff(bytes: Bytes, hints: FileHints = {}): FormatStrip {
  try {
    return blankIdentifyingValues(bytes, namesRawFormat(hints));
  } catch (error: unknown) {
    if (error instanceof MalformedImage || error instanceof RangeError) {
      return MALFORMED;
    }
    throw error;
  }
}

function blankIdentifyingValues(bytes: Bytes, namedRaw: boolean): FormatStrip {
  const n = bytes.length;
  const little = bytes[0] === 0x49;
  const u16 = (at: number): number => {
    if (at < 0 || at + 2 > n) throw new MalformedImage();
    return little
      ? (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
      : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  };
  const u32 = (at: number): number =>
    little ? u16(at) + u16(at + 2) * 0x10000 : u16(at) * 0x10000 + u16(at + 2);

  const ifds = readIfds(u16, u32, n);
  const raw =
    namedRaw ||
    ifds.some((ifd) => ifd.entries.some((entry) => entry.tag === DNG_VERSION));
  const isTarget = (kind: IfdKind, tag: number): boolean =>
    kind === 'gps' || (!raw && isIdentifying(kind, tag));

  // Where each entry's value lives: inline in its 4-byte field, or at the offset it holds.
  const valueRange = (entry: Entry): Range => {
    if (entry.size <= 4) return { start: entry.field, end: entry.field + 4 };
    const start = u32(entry.field);
    const end = start + entry.size;
    if (end > n) throw new MalformedImage();
    return { start, end };
  };

  /** Ranges to zero; `external` ones lie outside any IFD table. */
  const targets: Range[] = [];
  const external: Range[] = [];
  for (const ifd of ifds) {
    if (ifd.kind === 'gps') {
      targets.push(ifd);
      external.push(ifd);
    }
    for (const entry of ifd.entries) {
      if (!isTarget(ifd.kind, entry.tag) || entry.count === 0) continue;
      if (entry.size < 0) throw new MalformedImage(); // cannot place it to blank it
      const range = valueRange(entry);
      targets.push(range);
      if (entry.size > 4) external.push(range);
    }
  }
  if (targets.length === 0) return CLEAN;
  const allTargets = union(targets);
  const externalTargets = union(external);

  // Nothing kept may be touched: an inline target sits inside its own table, so tables
  // are checked against external targets only; kept values and image data against all.
  const guard = (range: Range, against: readonly Range[]) => {
    if (range.end > n) throw new MalformedImage();
    if (overlaps(against, range)) throw new MalformedImage();
  };
  for (const ifd of ifds) {
    if (ifd.kind === 'gps') continue;
    guard(ifd, externalTargets);
    for (const entry of ifd.entries) {
      if (isTarget(ifd.kind, entry.tag) || entry.size <= 4) continue;
      guard(valueRange(entry), allTargets);
    }
  }
  let imageRanges = 0;
  for (const ifd of ifds) {
    if (ifd.kind !== 'image') continue;
    for (const [offsetsTag, lengthsTag] of IMAGE_DATA_TAGS) {
      const offsets = ifd.entries.find((e) => e.tag === offsetsTag);
      const lengths = ifd.entries.find((e) => e.tag === lengthsTag);
      if (!offsets && !lengths) continue;
      if (!offsets || !lengths || offsets.count !== lengths.count) {
        throw new MalformedImage();
      }
      imageRanges += offsets.count;
      if (imageRanges > MAX_IMAGE_RANGES) throw new MalformedImage();
      const offsetAt = valueRange(offsets).start;
      const lengthAt = valueRange(lengths).start;
      for (let i = 0; i < offsets.count; i++) {
        const start = readInteger(offsets, offsetAt, i, u16, u32);
        const length = readInteger(lengths, lengthAt, i, u16, u32);
        guard({ start, end: start + length }, allTargets);
      }
    }
  }

  if (!allTargets.some((range) => hasNonZero(bytes, range))) return CLEAN;
  const out = bytes.slice();
  // Zeroed ASCII values keep their count, so libtiff warns that an ASCII value "contains
  // null byte" when reading them back. The warning is harmless: the image decodes the same,
  // and the tag reads as an empty string.
  for (const range of allTargets) out.fill(0, range.start, range.end);
  return { kind: 'stripped', parts: [out] };
}

/** Every IFD reachable from the header, each visited once; a second visit is a loop. */
function readIfds(
  u16: (at: number) => number,
  u32: (at: number) => number,
  n: number,
): Ifd[] {
  const ifds: Ifd[] = [];
  const seen = new Set<number>();
  let entries = 0;

  const readIfd = (start: number, kind: IfdKind): Ifd => {
    if (start < 8 || seen.has(start) || seen.size >= MAX_IFDS) {
      throw new MalformedImage();
    }
    seen.add(start);
    const count = u16(start);
    entries += count;
    if (entries > MAX_ENTRIES) throw new MalformedImage();
    const end = start + 2 + count * 12 + 4;
    if (end > n) throw new MalformedImage();
    const list: Entry[] = [];
    for (let i = 0; i < count; i++) {
      const at = start + 2 + i * 12;
      const type = u16(at + 2);
      const valueCount = u32(at + 4);
      const unit = TYPE_SIZES[type] ?? 0;
      list.push({
        tag: u16(at),
        type,
        count: valueCount,
        field: at + 8,
        size: unit === 0 ? -1 : unit * valueCount,
      });
    }
    const ifd: Ifd = { kind, start, end, entries: list };
    ifds.push(ifd);
    return ifd;
  };

  /** The IFD offsets a pointer entry holds; the pointed-to IFDs are read by the caller. */
  const pointers = (entry: Entry, single: boolean): number[] => {
    if (
      (entry.type !== LONG && entry.type !== IFD_TYPE) ||
      entry.count === 0 ||
      (single && entry.count !== 1) ||
      entry.count > MAX_IFDS
    ) {
      throw new MalformedImage();
    }
    const at = entry.count === 1 ? entry.field : u32(entry.field);
    if (at + entry.count * 4 > n) throw new MalformedImage();
    return Array.from({ length: entry.count }, (_, i) => u32(at + i * 4));
  };

  let next = u32(4);
  do {
    next = u32(readIfd(next, 'image').end - 4);
  } while (next !== 0);
  // Follow the pointers of every page, then of the IFDs they lead to.
  for (let i = 0; i < ifds.length; i++) {
    const ifd = ifds[i] as Ifd;
    for (const entry of ifd.entries) {
      if (ifd.kind === 'image' && entry.tag === SUB_IFDS) {
        for (const at of pointers(entry, false)) readIfd(at, 'image');
      } else if (ifd.kind === 'image' && entry.tag === EXIF_IFD) {
        readIfd(pointers(entry, true)[0] ?? 0, 'exif');
      } else if (ifd.kind === 'image' && entry.tag === GPS_IFD) {
        readIfd(pointers(entry, true)[0] ?? 0, 'gps');
      } else if (ifd.kind === 'exif' && entry.tag === INTEROPERABILITY_IFD) {
        readIfd(pointers(entry, true)[0] ?? 0, 'other');
      }
    }
  }
  return ifds;
}

/** Whether `tag` is on the blanking list of an IFD of `kind` (GPS IFDs are emptied whole). */
function isIdentifying(kind: IfdKind, tag: number): boolean {
  if (kind === 'image') return IMAGE_TARGETS.has(tag);
  if (kind === 'exif') return EXIF_TARGETS.has(tag);
  return false;
}

/** Whether the file name's extension or the MIME subtype names a camera raw format. */
function namesRawFormat(hints: FileHints): boolean {
  const extension = /\.([a-z0-9]+)$/iu.exec(hints.name ?? '')?.[1];
  const subtype = /^image\/(?:[a-z0-9.+]+-)*([a-z0-9]+)$/iu.exec(
    (hints.type ?? '').trim(),
  )?.[1];
  return [extension, subtype].some(
    (name) => name !== undefined && RAW_FORMATS.has(name.toLowerCase()),
  );
}

/** The `index`th SHORT or LONG of an offsets or lengths entry whose values start at `at`. */
function readInteger(
  entry: Entry,
  at: number,
  index: number,
  u16: (at: number) => number,
  u32: (at: number) => number,
): number {
  if (entry.type === SHORT) return u16(at + index * 2);
  if (entry.type === LONG) return u32(at + index * 4);
  throw new MalformedImage();
}

/** `ranges` merged into sorted, disjoint ranges. */
function union(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, range.end),
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Whether `range` shares a byte with any of the sorted, disjoint `ranges`. */
function overlaps(ranges: readonly Range[], range: Range): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((ranges[mid] as Range).end <= range.start) low = mid + 1;
    else high = mid;
  }
  const candidate = ranges[low];
  return (
    candidate !== undefined &&
    candidate.start < range.end &&
    range.start < range.end
  );
}

function hasNonZero(bytes: Bytes, range: Range): boolean {
  for (let i = range.start; i < range.end; i++) if (bytes[i] !== 0) return true;
  return false;
}
