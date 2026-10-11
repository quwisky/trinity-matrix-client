import {
  MAX_WALK_STEPS,
  MalformedImage,
  asciiBytes,
  fourCC,
  hasAscii,
  u32be,
  type Bytes,
} from './byte-parts';

/**
 * Reads `[start, end)` of the file being stripped. A `Blob.slice().arrayBuffer()` for a
 * picked file, so only the requested range is ever loaded; a view for bytes already in
 * memory.
 */
export type ReadRange = (start: number, end: number) => Promise<Bytes>;

/**
 * The outcome of {@link stripVideoMetadata}.
 *
 * - `stripped`: the file is the bytes before `start`, then `movie` (the patched `moov`
 *   box, exactly `end - start` bytes), then the bytes from `end`, all unchanged.
 * - `unchanged`: send the file as it is: `unsupported` (a fragmented movie or a `moov`
 *   over {@link MAX_MOVIE_BYTES}), `clean` (nothing to remove) or `malformed` (the
 *   structure could not be followed with certainty, or the file could not be read).
 */
export type VideoMetadataStrip =
  | {
      readonly kind: 'stripped';
      readonly start: number;
      readonly end: number;
      readonly movie: Bytes;
    }
  | {
      readonly kind: 'unchanged';
      readonly reason: 'unsupported' | 'clean' | 'malformed';
    };

/**
 * Upper bound on the `moov` box read into memory. A phone clip's is tens to hundreds of
 * KiB (its sample tables grow about 1 MB per hour of video); past this the file is sent
 * unchanged rather than holding a hostile or exotic sample table in memory.
 */
export const MAX_MOVIE_BYTES = 64 * 1024 * 1024;

/**
 * Upper bound on top-level boxes. A camera writes a handful (`ftyp`, `wide`, `mdat`,
 * `moov`, perhaps `free`/`uuid`); each costs one small read, so the cap bounds the reads.
 */
const MAX_TOP_LEVEL_BOXES = 1024;

/**
 * Upper bound on sibling boxes inside one `moov` container (tracks, user-data atoms,
 * metadata items, keys). Real movies have tens.
 */
const MAX_SIBLING_BOXES = 1024;

/**
 * Upper bound on one `keys` entry's name. Real keys are reverse-DNS names well under 100
 * bytes (`com.apple.quicktime.location.accuracy.horizontal` is 48).
 */
const MAX_KEY_BYTES = 1024;

/** Brands of movies (MP4, QuickTime, 3GPP and their relatives) in `ftyp`. */
const MOVIE_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'iso9',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'qt  ',
  'M4V ',
  'M4VH',
  'M4VP',
  'MSNV',
  'XAVC',
  'f4v ',
  'kddi',
]);

/** MIME types under which a file is taken for a movie even with an unknown brand. */
const MOVIE_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
  'video/x-m4v',
]);

/** Top-level boxes a QuickTime file without `ftyp` may start with. */
const QUICKTIME_FIRST_BOXES = new Set([
  'ftyp',
  'moov',
  'mdat',
  'wide',
  'free',
  'skip',
  'pnot',
]);

/** User-data atoms removed whole: location, device and software, Adobe XMP. */
const REMOVED_ATOMS = new Set([
  '\xa9xyz',
  'loci',
  '\xa9mak',
  '\xa9mod',
  '\xa9swr',
  'XMP_',
]);

/** `ilst` items (iTunes style, a 4CC per item) whose values are blanked. */
const BLANKED_ITEMS = new Set(['\xa9xyz', '\xa9mak', '\xa9mod', '\xa9swr']);

const FREE = asciiBytes('free');

interface Box {
  readonly type: string;
  readonly start: number;
  /** Offset of the payload, after the (large)size and type. */
  readonly body: number;
  readonly end: number;
}

/** One in-place edit: retype the box at `retype` to `free`, then zero `[from, to)`. */
interface Edit {
  readonly retype: number | null;
  readonly from: number;
  readonly to: number;
}

/** Structural doubt; never escapes {@link stripVideoMetadata}. */
const Malformed = MalformedImage;

/** A fragmented movie or an oversized `moov`: valid, but not handled. */
class Unsupported extends Error {}

/**
 * Whether a file starting with `head` is an ISO base media movie (MP4, MOV, 3GP, M4V):
 * an `ftyp` with a movie brand, or any ISO/QuickTime box layout under a movie MIME type.
 * HEIF stills share the container but are matched by the image strippers first.
 */
export function isIsoMovie(head: Uint8Array, mimeType: string): boolean {
  if (head.length < 8) return false;
  if (hasAscii(head, 4, 'ftyp')) {
    const size = Math.min(u32be(head, 0), head.length);
    for (let at = 8; at + 4 <= size; at += 4) {
      if (at === 12) continue; // minor_version
      const brand = fourCC(head, at);
      if (MOVIE_BRANDS.has(brand) || brand.startsWith('3g')) return true;
    }
  }
  const movieType = MOVIE_TYPES.has(
    (mimeType.split(';')[0] ?? '').trim().toLowerCase(),
  );
  return movieType && QUICKTIME_FIRST_BOXES.has(fourCC(head, 4));
}

/**
 * Remove the capture location and device identity from an MP4, MOV or 3GP movie in
 * place, without re-encoding and without moving a single byte: only the `moov` box is
 * read and edited, so every chunk offset (`stco`/`co64`) stays valid and `mdat` is never
 * loaded.
 *
 * In `moov`, `moov/udta`, `moov/meta`, `trak/udta` and their `meta` boxes:
 * - location (`©xyz`, `loci`), device (`©mak`, `©mod`), software (`©swr`) and XMP atoms
 *   become `free` boxes of the same size with zeroed payloads;
 * - `keys`/`ilst` items whose key names a location, make, model, software, serial or
 *   device, and iTunes-style `©xyz`/`©mak`/`©mod`/`©swr` items, keep their structure
 *   with zeroed values.
 * The capture date, encoder, frame rate and Live Photo identifier are kept.
 *
 * Never rejects. Whenever the structure is in doubt the verdict is `unchanged`, and no
 * byte is edited until the whole `moov` has been read and checked, so a read that
 * returns views into memory is patched in place only on success.
 */
export async function stripVideoMetadata(
  read: ReadRange,
  size: number,
): Promise<VideoMetadataStrip> {
  try {
    const movie = await findMovie(read, size);
    const bytes = await read(movie.start, movie.end);
    if (bytes.length !== movie.end - movie.start) throw new Malformed();
    const edits = planEdits(bytes, movie.body - movie.start);
    if (edits.length === 0) return { kind: 'unchanged', reason: 'clean' };
    for (const edit of edits) {
      if (edit.retype !== null) bytes.set(FREE, edit.retype + 4);
      bytes.fill(0, edit.from, edit.to);
    }
    return {
      kind: 'stripped',
      start: movie.start,
      end: movie.end,
      movie: bytes,
    };
  } catch (error: unknown) {
    const reason = error instanceof Unsupported ? 'unsupported' : 'malformed';
    return { kind: 'unchanged', reason };
  }
}

/** Walk the top-level boxes by their headers alone and return the single `moov`. */
async function findMovie(read: ReadRange, size: number): Promise<Box> {
  let movie: Box | null = null;
  let pos = 0;
  for (let count = 0; pos < size; count++) {
    if (count >= MAX_TOP_LEVEL_BOXES) throw new Malformed();
    const header = await read(pos, Math.min(pos + 16, size));
    const box = boxAt(header, 0, size - pos);
    if (box.type === 'moof' || box.type === 'mfra') throw new Unsupported();
    if (box.type === 'moov') {
      if (movie) throw new Malformed();
      movie = {
        type: box.type,
        start: pos,
        body: pos + box.body,
        end: pos + box.end,
      };
    }
    pos += box.end;
  }
  if (!movie) throw new Malformed();
  if (movie.end - movie.start > MAX_MOVIE_BYTES) throw new Unsupported();
  return movie;
}

/**
 * The box whose header starts at `pos` of `bytes`, within `[pos, limit)`. A size of 0
 * runs to `limit`, which only the top level allows.
 */
function boxAt(
  bytes: Uint8Array,
  pos: number,
  limit: number,
  openEnded = true,
): Box {
  if (pos + 8 > limit || pos + 8 > bytes.length) throw new Malformed();
  let size = u32be(bytes, pos);
  const type = fourCC(bytes, pos + 4);
  let body = pos + 8;
  if (size === 1) {
    if (pos + 16 > limit || pos + 16 > bytes.length) throw new Malformed();
    size = u32be(bytes, pos + 8) * 2 ** 32 + u32be(bytes, pos + 12);
    if (!Number.isSafeInteger(size)) throw new Malformed();
    body = pos + 16;
  } else if (size === 0) {
    if (!openEnded) throw new Malformed();
    size = limit - pos;
  }
  const end = pos + size;
  if (end < body || end > limit) throw new Malformed();
  return { type, start: pos, body, end };
}

/** The edits that remove identifying metadata from `moov` (header included in `bytes`). */
function planEdits(bytes: Bytes, headerLength: number): Edit[] {
  const edits: Edit[] = [];
  const walk = new Walk(bytes);
  for (const child of walk.children(headerLength, bytes.length)) {
    if (child.type === 'mvex') throw new Unsupported();
    if (child.type === 'trak') {
      for (const part of walk.children(child.body, child.end)) {
        if (part.type === 'udta') edits.push(...userData(walk, part));
        if (part.type === 'meta') edits.push(...metadata(walk, part));
      }
    }
    if (child.type === 'udta') edits.push(...userData(walk, child));
    if (child.type === 'meta') edits.push(...metadata(walk, child));
  }
  return edits;
}

function userData(walk: Walk, udta: Box): Edit[] {
  const edits: Edit[] = [];
  for (const atom of walk.children(udta.body, udta.end)) {
    if (REMOVED_ATOMS.has(atom.type)) {
      edits.push({ retype: atom.start, from: atom.body, to: atom.end });
    } else if (atom.type === 'meta') {
      edits.push(...metadata(walk, atom));
    }
  }
  return edits;
}

/**
 * Blank identifying values in a `meta` box: a QuickTime `meta` is a plain container, an
 * ISO one a FullBox; either way its first child is `hdlr`.
 */
function metadata(walk: Walk, meta: Box): Edit[] {
  const { bytes } = walk;
  if (meta.end === meta.body) return [];
  let first: number;
  if (hasAscii(bytes, meta.body + 4, 'hdlr')) first = meta.body;
  else if (hasAscii(bytes, meta.body + 8, 'hdlr')) first = meta.body + 4;
  else throw new Malformed();
  const children = walk.children(first, meta.end);
  const one = (type: string): Box | null => {
    const found = children.filter((b) => b.type === type);
    if (found.length > 1) throw new Malformed();
    return found[0] ?? null;
  };
  const keys = one('keys');
  const ilst = one('ilst');
  const names = keys ? keyNames(walk, keys) : [];
  if (!ilst) return [];

  const edits: Edit[] = [];
  for (const item of walk.children(ilst.body, ilst.end)) {
    const index = u32be(bytes, item.start + 4);
    const name = keys ? names[index - 1] : undefined;
    const sensitive =
      name !== undefined ? isSensitiveKey(name) : BLANKED_ITEMS.has(item.type);
    if (!sensitive) continue;
    for (const data of walk.children(item.body, item.end)) {
      if (data.type !== 'data') continue;
      // type indicator and locale stay; the value after them is zeroed.
      if (data.body + 8 > data.end) throw new Malformed();
      edits.push({ retype: null, from: data.body + 8, to: data.end });
    }
  }
  return edits;
}

/** The names in a `keys` box, by index from 0 (key index 1). */
function keyNames(walk: Walk, keys: Box): string[] {
  const { bytes } = walk;
  let at = keys.body + 4; // FullBox header
  if (at + 4 > keys.end) throw new Malformed();
  const count = u32be(bytes, at);
  at += 4;
  if (count > MAX_SIBLING_BOXES || count * 8 > keys.end - at) {
    throw new Malformed();
  }
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const entry = boxAt(bytes, at, keys.end, false);
    walk.step();
    if (entry.end - entry.body > MAX_KEY_BYTES) throw new Malformed();
    let name = '';
    for (let c = entry.body; c < entry.end; c++) {
      name += String.fromCharCode(bytes[c] ?? 0);
    }
    names.push(name);
    at = entry.end;
  }
  return names;
}

/**
 * Whether a QuickTime metadata key names a location (`…location.ISO6709`, `…location.name`),
 * the device (`…make`, `…model`, `…lens_model`, `…manufacturer`, a serial number, a device
 * id) or its software. The capture date, frame rate and content identifier are kept.
 */
function isSensitiveKey(name: string): boolean {
  const key = name.toLowerCase();
  if (['location', 'serial', 'device'].some((part) => key.includes(part))) {
    return true;
  }
  const last = key.slice(key.lastIndexOf('.') + 1);
  return ['make', 'model', 'software', 'manufacturer'].some((ending) =>
    last.endsWith(ending),
  );
}

/** Box walking inside the in-memory `moov`, counted against the walk caps. */
class Walk {
  private steps = 0;

  constructor(readonly bytes: Bytes) {}

  step(): void {
    if (++this.steps > MAX_WALK_STEPS) throw new Malformed();
  }

  /**
   * The boxes laid end to end in `[from, to)`. Four zero bytes at the end are the
   * terminator QuickTime allows after a list of atoms; anything else is malformed.
   */
  children(from: number, to: number): Box[] {
    const boxes: Box[] = [];
    let pos = from;
    while (pos < to) {
      if (to - pos === 4 && u32be(this.bytes, pos) === 0) break;
      if (boxes.length >= MAX_SIBLING_BOXES) throw new Malformed();
      this.step();
      const box = boxAt(this.bytes, pos, to, false);
      boxes.push(box);
      pos = box.end;
    }
    return boxes;
  }
}
