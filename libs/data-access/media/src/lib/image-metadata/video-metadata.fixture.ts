/**
 * Byte-level MP4/MOV/3GP builders for the video metadata specs, in the style of
 * `image-metadata.fixture.ts`: small, structurally valid movies assembled from labelled
 * boxes, whose metadata values carry markers that must never survive a strip.
 */
import {
  ascii,
  box,
  concat,
  fullBox,
  u16be,
  u32be,
} from './image-metadata.fixture';

/** Values that identify where or with what a clip was recorded. */
export const VIDEO_IDENTIFYING_MARKERS = [
  '52.5200',
  '013.4050',
  '4.712345',
  'Apple',
  'iPhone 15 Pro',
  '17.4.1',
  'SN-0042',
  'DEV-7731',
  'Berlin',
  '52,31.20N',
] as const;

/** Values that are kept: they say nothing about the place or the device. */
export const VIDEO_KEPT_VALUES = {
  creationDate: '2026-10-01T12:34:56+0200',
  encoder: 'Lavf61.7.100',
  fps: '30.000',
  contentId: '5B3C0D2E-LIVE-PHOTO',
} as const;

/** The coded samples: everything `stco` points at, which a strip must never touch. */
export const MOVIE_SAMPLES = ascii(
  'avc1-coded-video-samples:0123456789abcdef0123456789abcdef',
);

/** An ISO 6709 string as QuickTime and Android write it. */
export const ISO6709 = '+52.5200+013.4050+034.000/';

/** A QuickTime `©xxx` user-data atom: 16-bit length, 16-bit language, text. */
export function quickTimeText(
  type: string,
  text: string,
): Uint8Array<ArrayBuffer> {
  return box(type, u16be(text.length), u16be(0x15c7), ascii(text));
}

/** An `ilst` `data` box holding UTF-8 text (well-known type 1). */
export function dataBox(text: string): Uint8Array<ArrayBuffer> {
  return box('data', u32be(1), u32be(0), ascii(text));
}

/** A `keys`/`ilst` pair: `entries` in order, key indexes from 1. */
function keyedMetadata(
  entries: readonly (readonly [string, string])[],
): Uint8Array<ArrayBuffer>[] {
  const keys = fullBox(
    'keys',
    0,
    u32be(entries.length),
    ...entries.map(([key]) =>
      concat(u32be(key.length + 8), ascii('mdta'), ascii(key)),
    ),
  );
  const items = entries.map(([, value], index) =>
    concat(u32be(8 + 8 + 8 + value.length), u32be(index + 1), dataBox(value)),
  );
  return [keys, box('ilst', ...items)];
}

export function metadataHandler(
  type: 'mdta' | 'mdir',
): Uint8Array<ArrayBuffer> {
  return fullBox(
    'hdlr',
    0,
    u32be(0),
    ascii(type),
    new Uint8Array(12),
    ascii('\0'),
  );
}

/** Apple's location, device and kept keys, as an iPhone writes them in `moov/meta`. */
export const APPLE_KEYS: readonly (readonly [string, string])[] = [
  ['com.apple.quicktime.location.ISO6709', ISO6709],
  ['com.apple.quicktime.location.accuracy.horizontal', '4.712345'],
  ['com.apple.quicktime.make', 'Apple'],
  ['com.apple.quicktime.model', 'iPhone 15 Pro'],
  ['com.apple.quicktime.software', '17.4.1'],
  ['com.apple.quicktime.creationdate', VIDEO_KEPT_VALUES.creationDate],
  ['com.apple.quicktime.camera.lens_model', 'iPhone 15 Pro back camera'],
  ['com.example.camera.serial', 'SN-0042'],
  ['com.example.device.id', 'DEV-7731'],
  ['com.android.capture.fps', VIDEO_KEPT_VALUES.fps],
  ['com.apple.quicktime.content.identifier', VIDEO_KEPT_VALUES.contentId],
];

/**
 * A QuickTime `meta` (a plain container, as Apple writes it) with `keys` and `ilst`;
 * `iso` writes it as an ISO FullBox instead.
 */
export function keyedMeta(
  entries: readonly (readonly [string, string])[] = APPLE_KEYS,
  style: 'quicktime' | 'iso' = 'quicktime',
): Uint8Array<ArrayBuffer> {
  const children = [metadataHandler('mdta'), ...keyedMetadata(entries)];
  return style === 'iso'
    ? fullBox('meta', 0, ...children)
    : box('meta', ...children);
}

/** iTunes-style `udta/meta` (ISO FullBox, handler `mdir`) whose `ilst` items are 4CCs. */
export function iTunesMeta(): Uint8Array<ArrayBuffer> {
  return fullBox(
    'meta',
    0,
    metadataHandler('mdir'),
    box(
      'ilst',
      box('\xa9xyz', dataBox(ISO6709)),
      box('\xa9mak', dataBox('Apple')),
      box('\xa9too', dataBox(VIDEO_KEPT_VALUES.encoder)),
    ),
  );
}

/** A 3GPP `loci` box naming Berlin, with fixed-point coordinates. */
export const LOCI = fullBox(
  'loci',
  0,
  u16be(0x15c7),
  ascii('Berlin\0'),
  Uint8Array.of(0),
  u32be(Math.round(13.405 * 65536)),
  u32be(Math.round(52.52 * 65536)),
  u32be(34 * 65536),
  ascii('Earth\0'),
  ascii('\0'),
);

/** Adobe XMP in `udta`, with a GPS latitude in it. */
export const XMP_ATOM = box(
  'XMP_',
  ascii(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="52,31.20N"/></rdf:RDF></x:xmpmeta>',
  ),
);

/** `moov/udta` as a phone camera writes it: location, device, and kept date/encoder. */
export function identifyingUdta(
  extra: readonly Uint8Array[] = [],
): Uint8Array<ArrayBuffer> {
  return box(
    'udta',
    quickTimeText('\xa9xyz', '+52.5200+013.4050/'),
    quickTimeText('\xa9mak', 'Apple'),
    quickTimeText('\xa9mod', 'iPhone 15 Pro'),
    quickTimeText('\xa9swr', '17.4.1'),
    quickTimeText('\xa9too', VIDEO_KEPT_VALUES.encoder),
    quickTimeText('\xa9day', VIDEO_KEPT_VALUES.creationDate),
    ...extra,
  );
}

export const MOVIE_MVHD = fullBox('mvhd', 0, new Uint8Array(96).fill(0x11));
export const MOVIE_TKHD = fullBox('tkhd', 0, new Uint8Array(80).fill(0x22));

/** A track whose chunk offset (`stco`) points at `samplesAt`. */
export function movieTrack(
  samplesAt: number,
  samplesLength: number,
  udta?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return box(
    'trak',
    MOVIE_TKHD,
    box(
      'mdia',
      fullBox('mdhd', 0, new Uint8Array(20).fill(0x33)),
      box(
        'minf',
        box(
          'stbl',
          fullBox('stsz', 0, u32be(samplesLength), u32be(1)),
          fullBox('stco', 0, u32be(1), u32be(samplesAt)),
        ),
      ),
    ),
    ...(udta ? [udta] : []),
  );
}

export interface MovieOptions {
  /** Major brand of `ftyp`; `null` writes no `ftyp` at all (old QuickTime). */
  readonly brand?: string | null;
  /** Where `moov` sits: before `mdat` (fast start) or after it, as cameras write. */
  readonly layout?: 'moov-first' | 'moov-last';
  /** How the mdat header states its size: plain, 64-bit `largesize`, or 0 (to the end). */
  readonly mdatSize?: 'plain' | 'largesize' | 'to-end';
  /** `moov` children after `mvhd` and the track; defaults to a full identifying set. */
  readonly moovMetadata?: readonly Uint8Array[];
  /** `udta` of the track itself. */
  readonly trackUdta?: Uint8Array;
  /** Bytes appended to `moov` after its children. */
  readonly moovTrailer?: Uint8Array;
  /** Top-level boxes appended after everything else. */
  readonly trailer?: readonly Uint8Array[];
  /** The coded samples in `mdat`; {@link MOVIE_SAMPLES} by default. */
  readonly samples?: Uint8Array;
}

/** The `moov` metadata an iPhone (keys) and a camera app (`udta`) write. */
export function identifyingMoovMetadata(): Uint8Array<ArrayBuffer>[] {
  return [identifyingUdta([LOCI, XMP_ATOM]), keyedMeta()];
}

/**
 * A movie with one video track whose `stco` points at the samples in `mdat`. The chunk
 * offset depends on the layout, but no box size depends on it, so one pass finds it.
 */
export function identifyingMovie(
  options: MovieOptions = {},
): Uint8Array<ArrayBuffer> {
  const brand = options.brand === undefined ? 'isom' : options.brand;
  const layout = options.layout ?? 'moov-first';
  const mdatSize = options.mdatSize ?? 'plain';
  const samples = options.samples ?? MOVIE_SAMPLES;
  const ftyp =
    brand === null
      ? new Uint8Array(0)
      : box('ftyp', ascii(brand), u32be(512), ascii(brand), ascii('mp41'));
  const mdat =
    mdatSize === 'largesize'
      ? concat(
          u32be(1),
          ascii('mdat'),
          u32be(0),
          u32be(16 + samples.length),
          samples,
        )
      : mdatSize === 'to-end'
        ? concat(u32be(0), ascii('mdat'), samples)
        : box('mdat', samples);
  const mdatHeader = mdatSize === 'largesize' ? 16 : 8;
  const moovFor = (samplesAt: number) =>
    box(
      'moov',
      MOVIE_MVHD,
      movieTrack(samplesAt, samples.length, options.trackUdta),
      ...(options.moovMetadata ?? identifyingMoovMetadata()),
      options.moovTrailer ?? new Uint8Array(0),
    );
  const trailer = options.trailer ?? [];
  if (layout === 'moov-last') {
    return concat(ftyp, mdat, moovFor(ftyp.length + mdatHeader), ...trailer);
  }
  const moovLength = moovFor(0).length;
  return concat(
    ftyp,
    moovFor(ftyp.length + moovLength + mdatHeader),
    mdat,
    ...trailer,
  );
}

export interface TopBox {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/** The top-level boxes of a well-formed movie fixture, for assertions on layout. */
export function topLevelBoxes(bytes: Uint8Array): TopBox[] {
  const boxes: TopBox[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    let size = view.getUint32(pos);
    if (size === 1) size = Number(view.getBigUint64(pos + 8));
    if (size === 0) size = bytes.length - pos;
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    boxes.push({ type, start: pos, end: pos + size });
    pos += size;
  }
  return boxes;
}

/** The single top-level box of `type`; throws when there is not exactly one. */
export function topLevelBox(bytes: Uint8Array, type: string): TopBox {
  const found = topLevelBoxes(bytes).filter((b) => b.type === type);
  if (found.length !== 1) throw new Error(`expected one ${type} box`);
  return found[0] as TopBox;
}
