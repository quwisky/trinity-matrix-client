import {
  CLEAN,
  MALFORMED,
  MalformedImage,
  PartsBuilder,
  asciiBytes,
  fourCC,
  hasAscii,
  joinParts,
  u16be,
  u32be,
  type Bytes,
  type FormatStrip,
} from './byte-parts';

/** Brands of HEIF-family stills (HEIC, AVIF and plain MIAF/HEIF). */
const IMAGE_BRANDS = new Set([
  'mif1',
  'mif2',
  'msf1',
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'avif',
  'avis',
]);

interface Box {
  readonly type: string;
  /** Offset of the box header. */
  readonly start: number;
  /** Offset of the payload, after the (large)size and type. */
  readonly body: number;
  readonly end: number;
}

interface Extent {
  readonly offset: number;
  readonly length: number;
}

/**
 * Upper bound on extents across all items. Real stills (even large grids of tiles) use
 * one extent per item; the cap keeps the metadata-vs-other-items overlap check, which is
 * quadratic, cheap on hostile input.
 */
const MAX_EXTENTS = 4096;

/**
 * Upper bound on sibling boxes in one walk (top level, or inside `meta`). A still has a
 * handful (`ftyp`, `meta`, one `mdat`, perhaps `free`); the cap keeps a file made of
 * millions of tiny boxes a cheap, counted walk instead of a main-thread stall.
 */
const MAX_SIBLING_BOXES = 1024;

/**
 * Upper bound on `infe` entries, matching {@link MAX_EXTENTS}. A tiled 48 MP photo has
 * well under 200 items (tiles, thumbnail, depth, gain map, Exif, XMP).
 */
const MAX_ITEMS = 4096;

/**
 * Upper bound on top-level `mdat` boxes. Writers emit one (rarely a few, when appending);
 * every metadata extent is checked against each of them.
 */
const MAX_MEDIA_DATA_BOXES = 16;

/** Structural doubt; never escapes {@link stripHeif}. */
const Malformed = MalformedImage;

export function isHeif(bytes: Uint8Array): boolean {
  if (!hasAscii(bytes, 4, 'ftyp')) return false;
  const size = u32be(bytes, 0);
  if (size < 16 || size > bytes.length) return false;
  if (IMAGE_BRANDS.has(fourCC(bytes, 8))) return true;
  for (let at = 16; at + 4 <= size; at += 4) {
    if (IMAGE_BRANDS.has(fourCC(bytes, at))) return true;
  }
  return false;
}

/**
 * Blank the Exif and XMP items of a HEIF still (HEIC, AVIF) in place.
 *
 * Their bytes are located through the `meta` box's `iinf` and `iloc` and overwritten with
 * an empty TIFF and an empty XMP packet of the same length, so no offset anywhere in the
 * file changes and the coded image is untouched. Orientation in HEIF is the `irot`/`imir`
 * item properties, not Exif, so it is unaffected. Items stored in `idat` or `mdat` are
 * handled; anything the parser cannot place with certainty leaves the file unchanged.
 */
export function stripHeif(bytes: Bytes): FormatStrip {
  try {
    return blankMetadataItems(bytes);
  } catch (error: unknown) {
    if (error instanceof Malformed || error instanceof RangeError) {
      return MALFORMED;
    }
    throw error;
  }
}

function blankMetadataItems(bytes: Bytes): FormatStrip {
  const top = children(bytes, 0, bytes.length);
  const metas = top.filter((b) => b.type === 'meta');
  if (metas.length !== 1 || top[0]?.type !== 'ftyp') throw new Malformed();
  const meta = metas[0] as Box;
  const metaChildren = children(bytes, meta.body + 4, meta.end); // FullBox header
  const one = (type: string): Box | null => {
    const found = metaChildren.filter((b) => b.type === type);
    if (found.length > 1) throw new Malformed();
    return found[0] ?? null;
  };

  const hdlr = one('hdlr');
  if (!hdlr || !hasAscii(bytes, hdlr.body + 8, 'pict')) throw new Malformed();
  const iinf = one('iinf');
  if (!iinf) return CLEAN;
  const targets = metadataItems(bytes, iinf);
  if (targets.size === 0) return CLEAN;

  const iloc = one('iloc');
  const idat = one('idat');
  if (!iloc) throw new Malformed();
  const locations = itemLocations(bytes, iloc, idat);

  // Each blanked range must sit inside a top-level mdat or the idat payload, so a hostile
  // iloc cannot point the overwrite at a box header.
  const mediaData = top.filter((b) => b.type === 'mdat');
  if (mediaData.length > MAX_MEDIA_DATA_BOXES) throw new Malformed();
  const containers = [...mediaData, ...(idat ? [idat] : [])];
  // Nor may it touch the data of any other item (the coded image, its thumbnail, ...).
  const otherExtents: Extent[] = [];
  for (const [id, extents] of locations) {
    if (targets.has(id)) continue;
    if (!extents) throw new Malformed();
    otherExtents.push(...extents);
  }
  const ranges: { readonly extent: Extent; readonly fill: Bytes }[] = [];
  for (const [id, kind] of targets) {
    const extents = locations.get(id);
    if (!extents) throw new Malformed();
    const total = extents.reduce((sum, e) => sum + e.length, 0);
    const fill = kind === 'exif' ? emptyExif(total) : emptyXmp(total);
    let written = 0;
    for (const extent of extents) {
      const inside = containers.some(
        (c) =>
          extent.offset >= c.body && extent.offset + extent.length <= c.end,
      );
      const overlaps = otherExtents.some(
        (o) =>
          o.offset < extent.offset + extent.length &&
          extent.offset < o.offset + o.length,
      );
      if (!inside || overlaps) throw new Malformed();
      ranges.push({
        extent,
        fill: fill.subarray(written, written + extent.length),
      });
      written += extent.length;
    }
  }

  ranges.sort((a, b) => a.extent.offset - b.extent.offset);
  const out = new PartsBuilder(bytes);
  let pos = 0;
  // Extents that follow each other directly are written as one part, so an item split
  // into many adjacent pieces does not count against the part cap once per piece.
  let pending: Bytes[] = [];
  for (const { extent, fill } of ranges) {
    if (extent.offset < pos) throw new Malformed(); // overlapping items
    if (extent.offset > pos && pending.length > 0) {
      out.insert(joinParts(pending));
      pending = [];
    }
    out.keep(pos, extent.offset);
    pending.push(fill);
    pos = extent.offset + extent.length;
  }
  if (pending.length > 0) out.insert(joinParts(pending));
  out.keep(pos, bytes.length);
  return out.result();
}

/** The boxes laid end to end in `[from, to)`; more than `limit` of them is malformed. */
function children(
  bytes: Bytes,
  from: number,
  to: number,
  limit = MAX_SIBLING_BOXES,
): Box[] {
  const boxes: Box[] = [];
  let pos = from;
  while (pos < to) {
    if (boxes.length >= limit) throw new Malformed();
    if (pos + 8 > to) throw new Malformed();
    let size = u32be(bytes, pos);
    const type = fourCC(bytes, pos + 4);
    let body = pos + 8;
    if (size === 1) {
      if (pos + 16 > to) throw new Malformed();
      size = readUint(bytes, pos + 8, 8);
      body = pos + 16;
    } else if (size === 0) {
      size = to - pos;
    }
    const end = pos + size;
    if (end < body || end > to) throw new Malformed();
    boxes.push({ type, start: pos, body, end });
    pos = end;
  }
  return boxes;
}

/** Item ids of Exif items and XMP (`mime`, application/rdf+xml) items. */
function metadataItems(bytes: Bytes, iinf: Box): Map<number, 'exif' | 'xmp'> {
  const version = bytes[iinf.body] ?? 0;
  const entriesAt = iinf.body + 4 + (version === 0 ? 2 : 4);
  const items = new Map<number, 'exif' | 'xmp'>();
  for (const infe of children(bytes, entriesAt, iinf.end, MAX_ITEMS)) {
    if (infe.type !== 'infe') continue;
    const infeVersion = bytes[infe.body] ?? 0;
    if (infeVersion < 2) continue; // pre-HEIF entries have no item type
    let at = infe.body + 4;
    const id = infeVersion === 2 ? u16be(bytes, at) : u32be(bytes, at);
    at += infeVersion === 2 ? 2 : 4;
    at += 2; // item_protection_index
    if (at + 4 > infe.end) throw new Malformed();
    const type = fourCC(bytes, at);
    at += 4;
    if (type === 'Exif') {
      items.set(id, 'exif');
    } else if (type === 'mime') {
      const nameEnd = bytes.indexOf(0, at);
      if (nameEnd < 0 || nameEnd >= infe.end) throw new Malformed();
      // Compare the media type only: "application/rdf+xml; charset=utf-8" is XMP too.
      const contentType = cString(bytes, nameEnd + 1, infe.end);
      const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
      if (mediaType === 'application/rdf+xml') items.set(id, 'xmp');
    }
  }
  return items;
}

/**
 * Absolute file extents of every item in `iloc`; null for an item whose data cannot be
 * placed (another file, item-relative construction, a missing idat, an open-ended extent).
 */
function itemLocations(
  bytes: Bytes,
  iloc: Box,
  idat: Box | null,
): Map<number, Extent[] | null> {
  const version = bytes[iloc.body] ?? 0;
  if (version > 2) throw new Malformed();
  let at = iloc.body + 4;
  const sizes = bytes[at] ?? 0;
  const sizes2 = bytes[at + 1] ?? 0;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0x0f;
  const baseOffsetSize = sizes2 >> 4;
  const indexSize = version === 0 ? 0 : sizes2 & 0x0f;
  at += 2;
  const count = version < 2 ? u16be(bytes, at) : u32be(bytes, at);
  at += version < 2 ? 2 : 4;
  if (count > MAX_ITEMS) throw new Malformed();
  // Every count is checked against the bytes that would have to hold it before looping,
  // so a crafted iloc cannot make the parser spin: work stays linear in the box size.
  const idSize = version < 2 ? 2 : 4;
  const itemHeader = idSize + (version > 0 ? 2 : 0) + 2 + baseOffsetSize + 2;
  if (count * itemHeader > iloc.end - at) throw new Malformed();
  const perExtent = indexSize + offsetSize + lengthSize;
  let totalExtents = 0;

  const locations = new Map<number, Extent[] | null>();
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? u16be(bytes, at) : u32be(bytes, at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) {
      method = u16be(bytes, at) & 0x0f;
      at += 2;
    }
    const dataReference = u16be(bytes, at);
    at += 2;
    const base = readUint(bytes, at, baseOffsetSize);
    at += baseOffsetSize;
    const extentCount = u16be(bytes, at);
    at += 2;
    // Zero-sized fields make every extent read nothing; more than one is then meaningless.
    if (
      extentCount > 1 &&
      (perExtent === 0 || extentCount * perExtent > iloc.end - at)
    ) {
      throw new Malformed();
    }
    totalExtents += extentCount;
    if (totalExtents > MAX_EXTENTS) throw new Malformed();
    const extents: Extent[] = [];
    for (let e = 0; e < extentCount; e++) {
      at += indexSize;
      const offset = readUint(bytes, at, offsetSize);
      at += offsetSize;
      const length = readUint(bytes, at, lengthSize);
      at += lengthSize;
      if (at > iloc.end) throw new Malformed();
      if (method === 0) {
        extents.push({ offset: base + offset, length });
      } else if (method === 1 && idat) {
        extents.push({ offset: idat.body + base + offset, length });
      } else {
        extents.push({ offset: -1, length: -1 }); // item-relative or missing idat
      }
    }
    if (at > iloc.end) throw new Malformed();
    if (locations.has(id)) throw new Malformed();
    const placed =
      dataReference === 0 &&
      extents.every((e) => e.offset >= 0 && e.length > 0);
    locations.set(id, placed ? extents : null);
  }
  return locations;
}

/** An unsigned big-endian integer of 0, 4 or 8 bytes. */
function readUint(bytes: Bytes, at: number, size: number): number {
  if (size === 0) return 0;
  if (at + size > bytes.length) throw new Malformed();
  if (size === 4) return u32be(bytes, at);
  if (size === 8) {
    const value = u32be(bytes, at) * 2 ** 32 + u32be(bytes, at + 4);
    if (!Number.isSafeInteger(value)) throw new Malformed();
    return value;
  }
  throw new Malformed();
}

function cString(bytes: Bytes, from: number, to: number): string {
  const nul = bytes.indexOf(0, from);
  const end = nul < 0 || nul > to ? to : nul;
  return String.fromCharCode(...bytes.subarray(from, end));
}

/** An Exif item payload holding an empty TIFF (no IFD entries), zero-padded. */
function emptyExif(length: number): Bytes {
  const out = new Uint8Array(length);
  // exif_tiff_header_offset 0, then "MM", 42, IFD0 at 8, no entries, no next IFD.
  const empty = Uint8Array.of(
    0,
    0,
    0,
    0,
    0x4d,
    0x4d,
    0,
    0x2a,
    0,
    0,
    0,
    8,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  if (length >= empty.length) out.set(empty);
  return out;
}

/** An empty XMP packet padded with whitespace, or plain whitespace when it cannot fit. */
function emptyXmp(length: number): Bytes {
  const head =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
  const tail = '<?xpacket end="w"?>';
  const padding = length - head.length - tail.length;
  return padding >= 0
    ? asciiBytes(head + ' '.repeat(padding) + tail)
    : new Uint8Array(length).fill(0x20);
}
