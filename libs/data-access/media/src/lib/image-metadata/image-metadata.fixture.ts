/**
 * Byte-level image builders for the metadata-stripping specs. Each one assembles a small but
 * structurally valid file from labelled parts, so a spec can assert exactly which parts
 * survive. The metadata carries recognisable markers ("Canon", "52.5200", "Berlin", ...) that
 * must never appear in a stripped result.
 */

export const IDENTIFYING_MARKERS = [
  'Canon',
  'EOS R6',
  '2026:10:01 12:34:56',
  '52.5200',
  'Berlin',
  'rdf:Description',
  'Alice Example',
  'Shot at home',
] as const;

export function ascii(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

export function concat(
  ...parts: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u16be(value: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

export function u32be(value: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

export function u32le(value: number): Uint8Array<ArrayBuffer> {
  return u32be(value).reverse();
}

/** Whether `haystack` contains the ASCII `needle`. */
export function containsAscii(haystack: Uint8Array, needle: string): boolean {
  const target = ascii(needle);
  outer: for (let i = 0; i + target.length <= haystack.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Whether `haystack` contains `needle` as one contiguous run. */
export function containsBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// TIFF / Exif

interface TiffEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Raw value bytes in the TIFF's byte order. */
  readonly value: Uint8Array;
}

/**
 * A TIFF block with IFD0 (make, model, datetime, orientation, artist) and a GPS IFD holding
 * latitude 52.5200 N. `orientation` null leaves the tag out.
 */
export function identifyingTiff(
  orientation: number | null,
  order: 'II' | 'MM' = 'MM',
): Uint8Array<ArrayBuffer> {
  const le = order === 'II';
  const u16 = (v: number) => (le ? u16be(v).reverse() : u16be(v));
  const u32 = (v: number) => (le ? u32le(v) : u32be(v));
  const text = (s: string) => ascii(`${s}\0`);
  const rational = (n: number, d: number) => concat(u32(n), u32(d));

  const gpsEntries: TiffEntry[] = [
    { tag: 0x0001, type: 2, count: 2, value: text('N') },
    {
      tag: 0x0002,
      type: 5,
      count: 3,
      value: concat(rational(52, 1), rational(31, 1), rational(12, 1)),
    },
    // An ASCII note so the latitude also appears as a searchable string.
    { tag: 0x001b, type: 7, count: 8, value: ascii('52.5200N') },
  ];
  const ifd0Entries: TiffEntry[] = [
    { tag: 0x010f, type: 2, count: 6, value: text('Canon') },
    { tag: 0x0110, type: 2, count: 7, value: text('EOS R6') },
    ...(orientation === null
      ? []
      : [{ tag: 0x0112, type: 3, count: 1, value: u16(orientation) }]),
    { tag: 0x0132, type: 2, count: 20, value: text('2026:10:01 12:34:56') },
    { tag: 0x013b, type: 2, count: 14, value: text('Alice Example') },
    { tag: 0x8825, type: 4, count: 1, value: u32(0) }, // patched below
  ];

  const ifdSize = (entries: readonly TiffEntry[]) =>
    2 + entries.length * 12 + 4;
  const external = (entries: readonly TiffEntry[]) =>
    entries.reduce(
      (sum, e) => sum + (e.value.length > 4 ? e.value.length : 0),
      0,
    );

  const ifd0Offset = 8;
  const ifd0DataOffset = ifd0Offset + ifdSize(ifd0Entries);
  const gpsOffset = ifd0DataOffset + external(ifd0Entries);
  const gpsDataOffset = gpsOffset + ifdSize(gpsEntries);

  const writeIfd = (
    entries: readonly TiffEntry[],
    dataOffset: number,
  ): { ifd: Uint8Array; data: Uint8Array } => {
    const records: Uint8Array[] = [u16(entries.length)];
    const data: Uint8Array[] = [];
    let cursor = dataOffset;
    for (const entry of entries) {
      const value = entry.tag === 0x8825 ? u32(gpsOffset) : entry.value;
      let field: Uint8Array;
      if (value.length > 4) {
        field = u32(cursor);
        data.push(value);
        cursor += value.length;
      } else {
        field = concat(value, new Uint8Array(4 - value.length));
      }
      records.push(
        concat(u16(entry.tag), u16(entry.type), u32(entry.count), field),
      );
    }
    records.push(u32(0));
    return { ifd: concat(...records), data: concat(...data) };
  };

  const ifd0 = writeIfd(ifd0Entries, ifd0DataOffset);
  const gps = writeIfd(gpsEntries, gpsDataOffset);
  return concat(
    ascii(order),
    u16(42),
    u32(ifd0Offset),
    ifd0.ifd,
    ifd0.data,
    gps.ifd,
    gps.data,
  );
}

/** The exact 26-byte big-endian TIFF the stripper writes to keep an orientation. */
export function orientationOnlyTiff(
  orientation: number,
): Uint8Array<ArrayBuffer> {
  // prettier-ignore
  return Uint8Array.of(
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
    0x00, orientation, 0x00, 0x00, // value
    0x00, 0x00, 0x00, 0x00, // no next IFD
  );
}

export const XMP_PACKET =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ' +
  'exif:GPSLatitude="52.5200N" photoshop:City="Berlin" dc:creator="Alice Example"/>' +
  '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

// ---------------------------------------------------------------------------------------
// JPEG

export function jpegSegment(
  marker: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return concat(
    Uint8Array.of(0xff, marker),
    u16be(payload.length + 2),
    payload,
  );
}

export const JPEG_SOI = Uint8Array.of(0xff, 0xd8);
export const JPEG_EOI = Uint8Array.of(0xff, 0xd9);
export const JPEG_JFIF = jpegSegment(
  0xe0,
  concat(ascii('JFIF\0'), Uint8Array.of(1, 2, 0, 0, 1, 0, 1, 0, 0)),
);
export const JPEG_ICC = jpegSegment(
  0xe2,
  concat(
    ascii('ICC_PROFILE\0'),
    Uint8Array.of(1, 1),
    ascii('fake-icc-profile-bytes'),
  ),
);
export const JPEG_ADOBE = jpegSegment(
  0xee,
  concat(ascii('Adobe'), Uint8Array.of(0, 100, 0, 0, 0, 0, 1)),
);
export const JPEG_XMP = jpegSegment(
  0xe1,
  concat(ascii('http://ns.adobe.com/xap/1.0/\0'), ascii(XMP_PACKET)),
);
export const JPEG_EXTENDED_XMP = jpegSegment(
  0xe1,
  concat(
    ascii('http://ns.adobe.com/xmp/extension/\0'),
    ascii('0123456789ABCDEF0123456789ABCDEF'),
    u32be(40),
    u32be(0),
    ascii('<rdf:li>Berlin</rdf:li>'),
  ),
);
export const JPEG_IPTC = jpegSegment(
  0xed,
  concat(
    ascii('Photoshop 3.0\0'),
    ascii('8BIM'),
    u16be(0x0404),
    ascii('City: Berlin'),
  ),
);
export const JPEG_COMMENT = jpegSegment(0xfe, ascii('Shot at home'));
export const JPEG_MPF = jpegSegment(
  0xe2,
  concat(ascii('MPF\0'), ascii('MM\0*index')),
);
export const JPEG_DQT = jpegSegment(
  0xdb,
  concat(
    Uint8Array.of(0),
    Uint8Array.from({ length: 64 }, (_, i) => i + 1),
  ),
);
export const JPEG_SOF0 = jpegSegment(
  0xc0,
  Uint8Array.of(8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1),
);
export const JPEG_DHT = jpegSegment(
  0xc4,
  concat(
    Uint8Array.of(0),
    Uint8Array.of(0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
  ),
);
export const JPEG_SOS = jpegSegment(
  0xda,
  Uint8Array.of(3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0),
);
/** Entropy-coded data with a stuffed 0xFF00, a restart marker and a fill byte. */
// prettier-ignore
export const JPEG_SCAN = Uint8Array.of(
  0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a, 0xff, 0x00, 0xbc,
);

export function jpegExif(tiff: Uint8Array): Uint8Array<ArrayBuffer> {
  return jpegSegment(0xe1, concat(ascii('Exif\0\0'), tiff));
}

/** Image bytes a lossless strip must keep verbatim: tables, frame, scan and EOI. */
export const JPEG_IMAGE_DATA = concat(
  JPEG_DQT,
  JPEG_SOF0,
  JPEG_DHT,
  JPEG_SOS,
  JPEG_SCAN,
  JPEG_EOI,
);

/** A camera-style JPEG carrying every metadata kind plus an MPF trailer image. */
export function identifyingJpeg(
  orientation: number | null = 6,
): Uint8Array<ArrayBuffer> {
  const trailerImage = concat(
    JPEG_SOI,
    jpegExif(identifyingTiff(1)),
    JPEG_IMAGE_DATA,
  );
  return concat(
    JPEG_SOI,
    JPEG_JFIF,
    jpegExif(identifyingTiff(orientation, 'II')),
    JPEG_XMP,
    JPEG_EXTENDED_XMP,
    JPEG_ICC,
    JPEG_MPF,
    JPEG_IPTC,
    JPEG_ADOBE,
    JPEG_COMMENT,
    JPEG_IMAGE_DATA,
    trailerImage,
  );
}

// ---------------------------------------------------------------------------------------
// PNG

export const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** Independent CRC-32 so the fixtures do not trust the implementation under test. */
export function fixtureCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(
  type: string,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const typed = concat(ascii(type), data);
  return concat(u32be(data.length), typed, u32be(fixtureCrc32(typed)));
}

export const PNG_IHDR = pngChunk(
  'IHDR',
  concat(u32be(16), u32be(16), Uint8Array.of(8, 6, 0, 0, 0)),
);
export const PNG_ICCP = pngChunk(
  'iCCP',
  concat(ascii('sRGB\0'), Uint8Array.of(0), ascii('zlib-profile')),
);
export const PNG_SRGB = pngChunk('sRGB', Uint8Array.of(0));
export const PNG_GAMA = pngChunk('gAMA', u32be(45455));
export const PNG_CHRM = pngChunk('cHRM', new Uint8Array(32).fill(1));
export const PNG_PHYS = pngChunk(
  'pHYs',
  concat(u32be(2835), u32be(2835), Uint8Array.of(1)),
);
export const PNG_IDAT = pngChunk('IDAT', ascii('compressed-pixels'));
export const PNG_IEND = pngChunk('IEND', new Uint8Array(0));

/** A PNG with every text/time/Exif chunk the stripper must remove. */
export function identifyingPng(
  orientation: number | null = 6,
): Uint8Array<ArrayBuffer> {
  return concat(
    PNG_SIGNATURE,
    PNG_IHDR,
    PNG_ICCP,
    PNG_SRGB,
    PNG_GAMA,
    PNG_CHRM,
    PNG_PHYS,
    pngChunk('eXIf', identifyingTiff(orientation)),
    pngChunk('tEXt', ascii('Author\0Alice Example')),
    pngChunk(
      'zTXt',
      concat(ascii('Comment\0'), Uint8Array.of(0), ascii('Shot at home')),
    ),
    pngChunk(
      'iTXt',
      concat(
        ascii('XML:com.adobe.xmp\0'),
        Uint8Array.of(0, 0),
        ascii('\0\0'),
        ascii(XMP_PACKET),
      ),
    ),
    pngChunk('tIME', Uint8Array.of(0x07, 0xea, 10, 1, 12, 34, 56)),
    PNG_IDAT,
    PNG_IEND,
  );
}

// ---------------------------------------------------------------------------------------
// WebP

export function riffChunk(
  fourcc: string,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return concat(
    ascii(fourcc),
    u32le(data.length),
    data,
    data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0),
  );
}

export function webpFile(
  ...chunks: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const body = concat(ascii('WEBP'), ...chunks);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

export function vp8x(flags: number): Uint8Array<ArrayBuffer> {
  // flags, 3 reserved bytes, canvas width-1 and height-1 as 24-bit little-endian.
  return riffChunk('VP8X', Uint8Array.of(flags, 0, 0, 0, 15, 0, 0, 15, 0, 0));
}

export const WEBP_ICCP = riffChunk('ICCP', ascii('fake-icc-profile'));
/** Odd length, so the chunk carries a pad byte that must survive. */
export const WEBP_VP8L = riffChunk('VP8L', ascii('/lossless-bitstream'));
export const WEBP_ALPH = riffChunk('ALPH', ascii('alpha'));

export const VP8X_ICC = 0x20;
export const VP8X_ALPHA = 0x10;
export const VP8X_EXIF = 0x08;
export const VP8X_XMP = 0x04;

export function identifyingWebp(
  orientation: number | null = 6,
): Uint8Array<ArrayBuffer> {
  return webpFile(
    vp8x(VP8X_ICC | VP8X_ALPHA | VP8X_EXIF | VP8X_XMP),
    WEBP_ICCP,
    WEBP_ALPH,
    WEBP_VP8L,
    riffChunk('EXIF', identifyingTiff(orientation, 'II')),
    riffChunk('XMP ', ascii(XMP_PACKET)),
    riffChunk('ABCD', ascii('private: Alice Example')),
  );
}

// ---------------------------------------------------------------------------------------
// HEIF (ISO-BMFF)

export function box(
  type: string,
  ...payload: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const body = concat(...payload);
  return concat(u32be(body.length + 8), ascii(type), body);
}

export function fullBox(
  type: string,
  version: number,
  ...payload: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  return box(type, Uint8Array.of(version, 0, 0, 0), ...payload);
}

export const HEIF_PIXELS = ascii('hevc-coded-image-data');
export const HEIF_EXIF_PAYLOAD = concat(
  u32be(6),
  ascii('Exif\0\0'),
  identifyingTiff(1),
);
export const HEIF_XMP_PAYLOAD = ascii(XMP_PACKET);

function infe(
  id: number,
  type: string,
  contentType?: string,
): Uint8Array<ArrayBuffer> {
  return fullBox(
    'infe',
    2,
    u16be(id),
    u16be(0),
    ascii(type),
    ascii('\0'),
    contentType === undefined ? new Uint8Array(0) : ascii(`${contentType}\0`),
  );
}

/**
 * A HEIC still: an image item, an Exif item and an XMP item, located in `mdat` through an
 * `iloc` (version 1, construction method 0). The meta box's size does not depend on the
 * offsets, so they are patched after one layout pass.
 */
export function identifyingHeic(
  overrides: {
    readonly exifOffsetDelta?: number;
    /** Store the Exif item in the meta box's `idat` (construction method 1). */
    readonly exifInIdat?: boolean;
    /** The XMP item's `content_type`. */
    readonly xmpContentType?: string;
    /** How the mdat header states its size: plain, 64-bit `largesize`, or 0 (to the end). */
    readonly mdatSize?: 'plain' | 'largesize' | 'to-end';
  } = {},
): Uint8Array<ArrayBuffer> {
  const inIdat = overrides.exifInIdat ?? false;
  const mdatSize = overrides.mdatSize ?? 'plain';
  const mdatBox = (
    ...payload: readonly Uint8Array[]
  ): Uint8Array<ArrayBuffer> => {
    const body = concat(...payload);
    if (mdatSize === 'largesize') {
      return concat(
        u32be(1),
        ascii('mdat'),
        u32be(0),
        u32be(body.length + 16),
        body,
      );
    }
    if (mdatSize === 'to-end') return concat(u32be(0), ascii('mdat'), body);
    return box('mdat', body);
  };
  const ftyp = box(
    'ftyp',
    ascii('heic'),
    u32be(0),
    ascii('mif1'),
    ascii('heic'),
  );
  const build = (offsets: readonly [number, number, number]) => {
    const iloc = fullBox(
      'iloc',
      1,
      Uint8Array.of(0x44, 0x00), // offset_size 4, length_size 4, base_offset_size 0, index_size 0
      u16be(3),
      ...[
        [1, 0, offsets[0], HEIF_PIXELS.length],
        [2, inIdat ? 1 : 0, offsets[1], HEIF_EXIF_PAYLOAD.length],
        [3, 0, offsets[2], HEIF_XMP_PAYLOAD.length],
      ].map(([id, method, offset, length]) =>
        concat(
          u16be(id!),
          u16be(method!),
          u16be(0),
          u16be(1),
          u32be(offset!),
          u32be(length!),
        ),
      ),
    );
    const meta = fullBox(
      'meta',
      0,
      fullBox(
        'hdlr',
        0,
        u32be(0),
        ascii('pict'),
        new Uint8Array(12),
        ascii('\0'),
      ),
      fullBox('pitm', 0, u16be(1)),
      fullBox(
        'iinf',
        0,
        u16be(3),
        infe(1, 'hvc1'),
        infe(2, 'Exif'),
        infe(3, 'mime', overrides.xmpContentType ?? 'application/rdf+xml'),
      ),
      iloc,
      ...(inIdat ? [box('idat', HEIF_EXIF_PAYLOAD)] : []),
    );
    const mdat = inIdat
      ? mdatBox(HEIF_PIXELS, HEIF_XMP_PAYLOAD)
      : mdatBox(HEIF_PIXELS, HEIF_EXIF_PAYLOAD, HEIF_XMP_PAYLOAD);
    return { meta, mdat };
  };
  const first = build([0, 0, 0]);
  const mdatPayload =
    ftyp.length + first.meta.length + (mdatSize === 'largesize' ? 16 : 8);
  const exifOffset = inIdat ? 0 : mdatPayload + HEIF_PIXELS.length;
  const { meta, mdat } = build([
    mdatPayload,
    exifOffset + (overrides.exifOffsetDelta ?? 0),
    mdatPayload + HEIF_PIXELS.length + (inIdat ? 0 : HEIF_EXIF_PAYLOAD.length),
  ]);
  return concat(ftyp, meta, mdat);
}

/**
 * A HEIF whose iloc (version 0, offset/length/base sizes all 0) declares `items` items of
 * 0xFFFF zero-byte extents each: 6 bytes per item that ask for 65,535 iterations apiece.
 */
export function pathologicalIlocHeic(items: number): Uint8Array<ArrayBuffer> {
  const entries = new Uint8Array(items * 6);
  for (let i = 0; i < items; i++) {
    entries.set(concat(u16be(i + 1), u16be(0), u16be(0xffff)), i * 6);
  }
  return concat(
    box('ftyp', ascii('heic'), u32be(0), ascii('mif1'), ascii('heic')),
    fullBox(
      'meta',
      0,
      fullBox(
        'hdlr',
        0,
        u32be(0),
        ascii('pict'),
        new Uint8Array(12),
        ascii('\0'),
      ),
      fullBox('iinf', 0, u16be(1), infe(1, 'Exif')),
      fullBox('iloc', 0, Uint8Array.of(0x00, 0x00), u16be(items), entries),
    ),
    box('mdat', HEIF_EXIF_PAYLOAD),
  );
}

/**
 * A HEIF whose Exif item is split into `extents` one-byte extents (8 iloc bytes each),
 * stored in a real mdat placed after `emptyMdats` empty 8-byte mdat boxes.
 */
export function manyExtentsHeic(
  extents: number,
  emptyMdats = 0,
): Uint8Array<ArrayBuffer> {
  const ftyp = box(
    'ftyp',
    ascii('heic'),
    u32be(0),
    ascii('mif1'),
    ascii('heic'),
  );
  const build = (mdatPayload: number) => {
    const table = new Uint8Array(extents * 8);
    for (let i = 0; i < extents; i++) {
      table.set(concat(u32be(mdatPayload + i), u32be(1)), i * 8);
    }
    return fullBox(
      'meta',
      0,
      fullBox(
        'hdlr',
        0,
        u32be(0),
        ascii('pict'),
        new Uint8Array(12),
        ascii('\0'),
      ),
      fullBox('iinf', 0, u16be(1), infe(1, 'Exif')),
      fullBox(
        'iloc',
        0,
        Uint8Array.of(0x44, 0x00),
        u16be(1),
        u16be(1),
        u16be(0),
        u16be(extents),
        table,
      ),
    );
  };
  const metaLength = build(0).length;
  const fillerLength = emptyMdats * 8;
  const meta = build(ftyp.length + metaLength + fillerLength + 8);
  const filler = new Uint8Array(fillerLength);
  for (let i = 0; i < emptyMdats; i++) {
    filler.set(concat(u32be(8), ascii('mdat')), i * 8);
  }
  return concat(
    ftyp,
    meta,
    filler,
    box('mdat', new Uint8Array(extents).fill(0x41)),
  );
}
