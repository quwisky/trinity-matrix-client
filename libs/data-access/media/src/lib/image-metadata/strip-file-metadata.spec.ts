import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinParts } from './image-metadata';
import { SVG_SNIFF_BYTES } from './svg-metadata';
import {
  JPEG_IMAGE_DATA,
  JPEG_JFIF,
  JPEG_SOI,
  ascii,
  concat,
  containsAscii,
  identifyingJpeg,
  identifyingPng,
  jpegExif,
  identifyingTiff,
} from './image-metadata.fixture';
import {
  VIDEO_IDENTIFYING_MARKERS,
  identifyingMovie,
  topLevelBox,
} from './video-metadata.fixture';
import {
  bytesWithoutMediaMetadata,
  strippedMedia,
  withoutImageMetadata,
  withoutMediaMetadata,
} from './strip-file-metadata';
import {
  expectedStrip,
  identifyingPage,
  tiffLayout,
} from './tiff-metadata.fixture';

vi.mock('./image-metadata', async (importOriginal) => {
  const real = await importOriginal<typeof import('./image-metadata')>();
  return { ...real, joinParts: vi.fn(real.joinParts) };
});

function expectNoVideoLocation(bytes: Uint8Array): void {
  for (const marker of VIDEO_IDENTIFYING_MARKERS) {
    expect(containsAscii(bytes, marker), marker).toBe(false);
  }
}

/** Record the size of every Blob read into memory while `run` is pending. */
async function blobReads<T>(
  run: () => Promise<T>,
): Promise<{ result: T; sizes: number[] }> {
  const sizes: number[] = [];
  const real = Blob.prototype.arrayBuffer;
  const spy = vi
    .spyOn(Blob.prototype, 'arrayBuffer')
    .mockImplementation(function (this: Blob) {
      sizes.push(this.size);
      return real.call(this);
    });
  try {
    return { result: await run(), sizes };
  } finally {
    spy.mockRestore();
  }
}

/** A movie with 64 KiB of samples, far more than its moov, so a read of them stands out. */
function largeMovie(): Uint8Array<ArrayBuffer> {
  return identifyingMovie({
    layout: 'moov-last',
    samples: new Uint8Array(64 * 1024).fill(0x5a),
  });
}

/** Whether `a` and `b` hold the same bytes; a plain loop, cheap on large arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withoutImageMetadata', () => {
  it('returns a new file with the metadata removed, keeping name, type and date', async () => {
    const original = new File([identifyingJpeg()], 'IMG_0001.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_000_000,
    });

    const result = await withoutImageMetadata(original);

    expect(result).not.toBe(original);
    expect(result.name).toBe('IMG_0001.jpg');
    expect(result.type).toBe('image/jpeg');
    expect(result.lastModified).toBe(1_700_000_000_000);
    expect(result.size).toBeLessThan(original.size);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(containsAscii(bytes, 'Canon')).toBe(false);
    expect(containsAscii(bytes, '52.5200')).toBe(false);
  });

  it('strips by content, so a photo with a missing MIME type is covered too', async () => {
    const original = new File([identifyingPng()], 'download', { type: '' });

    const result = await withoutImageMetadata(original);

    expect(result).not.toBe(original);
    expect(result.type).toBe('');
  });

  it('recognises an SVG whose root follows a long editor prolog', async () => {
    const prolog = `<?xml version="1.0"?>\n<!-- ${'Generator: '.repeat(80)} -->\n`;
    const original = new File(
      [
        ascii(
          `${prolog}<svg xmlns="http://www.w3.org/2000/svg"><!-- Alice Example --></svg>`,
        ),
      ],
      'drawing.svg',
      { type: 'image/svg+xml' },
    );
    expect(prolog.length).toBeGreaterThan(512);

    const result = await withoutImageMetadata(original);

    expect(result).not.toBe(original);
    expect(result.type).toBe('image/svg+xml');
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(containsAscii(bytes, 'Alice Example')).toBe(false);
  });

  it('keeps the camera data of a raw file, judged by its name, removing only GPS', async () => {
    const layout = tiffLayout('MM', [identifyingPage('MM')]);
    const raw = new File([layout.bytes], 'DSC_0001.NEF', { type: '' });
    const scan = new File([layout.bytes], 'scan.tif', { type: 'image/tiff' });

    const rawBytes = new Uint8Array(
      await (await withoutImageMetadata(raw)).arrayBuffer(),
    );
    const scanBytes = new Uint8Array(
      await (await withoutImageMetadata(scan)).arrayBuffer(),
    );

    expect(Array.from(rawBytes)).toEqual(
      Array.from(expectedStrip(layout, { raw: true })),
    );
    expect(containsAscii(rawBytes, 'Canon')).toBe(true);
    expect(Array.from(scanBytes)).toEqual(Array.from(expectedStrip(layout)));
    expect(containsAscii(scanBytes, 'Canon')).toBe(false);
  });

  it('returns the very same file for anything that is not a supported image', async () => {
    const video = new File(
      [concat(Uint8Array.of(0, 0, 0, 0x18), ascii('ftypmp42\0\0\0\0mp42isom'))],
      'clip.mp4',
      { type: 'video/mp4' },
    );
    const text = new File([ascii('Canon at 52.5200N')], 'notes.txt', {
      type: 'text/plain',
    });

    expect(await withoutImageMetadata(video)).toBe(video);
    expect(await withoutImageMetadata(text)).toBe(text);
  });

  it('returns the very same file for a malformed image', async () => {
    // Exif present, but the file ends before any image data: the stripper cannot be
    // sure of the structure, so the user's file goes out exactly as chosen.
    const broken = new File(
      [concat(JPEG_SOI, jpegExif(identifyingTiff(6)))],
      'broken.jpg',
      { type: 'image/jpeg' },
    );

    expect(await withoutImageMetadata(broken)).toBe(broken);
  });

  it('returns the very same file when it cannot be read', async () => {
    const unreadable = new File([identifyingJpeg()], 'gone.jpg', {
      type: 'image/jpeg',
    });
    Object.defineProperty(unreadable, 'arrayBuffer', {
      value: () => Promise.reject(new DOMException('gone', 'NotReadableError')),
    });

    expect(await withoutImageMetadata(unreadable)).toBe(unreadable);
  });
});

describe('withoutMediaMetadata', () => {
  it('returns a video without its location, keeping name, type, date and size', async () => {
    const input = identifyingMovie({ layout: 'moov-last' });
    const original = new File([input], 'IMG_0002.MOV', {
      type: 'video/quicktime',
      lastModified: 1_700_000_000_000,
    });

    const result = await withoutMediaMetadata(original);

    expect(result).not.toBe(original);
    expect(result.name).toBe('IMG_0002.MOV');
    expect(result.type).toBe('video/quicktime');
    expect(result.lastModified).toBe(1_700_000_000_000);
    expect(result.size).toBe(original.size);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expectNoVideoLocation(bytes);
    const mdat = topLevelBox(input, 'mdat');
    expect(
      sameBytes(
        bytes.subarray(mdat.start, mdat.end),
        input.subarray(mdat.start, mdat.end),
      ),
    ).toBe(true);
  });

  it('reads only box headers and moov, leaving the samples as a slice of the file', async () => {
    const input = largeMovie();
    const moov = topLevelBox(input, 'moov');
    const mdat = topLevelBox(input, 'mdat');
    const original = new File([input], 'clip.mp4', { type: 'video/mp4' });
    const slice = vi.spyOn(Blob.prototype, 'slice');

    const { result, sizes } = await blobReads(() =>
      withoutMediaMetadata(original),
    );

    expect(result).not.toBe(original);
    // What was loaded: a sniff, top-level box headers, and moov. Never the samples.
    for (const size of sizes) {
      expect(
        size <= SVG_SNIFF_BYTES || size === moov.end - moov.start,
        `${size}`,
      ).toBe(true);
    }
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(
      mdat.end - mdat.start,
    );
    // The bytes before moov (ftyp and the samples) are a slice of the picked file.
    expect(slice).toHaveBeenCalledWith(0, moov.start);
    slice.mockRestore();
    expectNoVideoLocation(new Uint8Array(await result.arrayBuffer()));
  });

  it('strips a movie by its brand whatever MIME type the composer gave it', async () => {
    const original = new File([identifyingMovie()], 'clip.bin', {
      type: 'application/octet-stream',
    });

    const result = await withoutMediaMetadata(original);

    expect(result).not.toBe(original);
    expectNoVideoLocation(new Uint8Array(await result.arrayBuffer()));
  });

  it('still strips photos', async () => {
    const original = new File([identifyingJpeg()], 'IMG_0001.jpg', {
      type: 'image/jpeg',
    });

    const result = await withoutMediaMetadata(original);

    expect(result).not.toBe(original);
    expect(
      containsAscii(new Uint8Array(await result.arrayBuffer()), '52.5200'),
    ).toBe(false);
  });

  it('returns the very same file for a malformed or unreadable video', async () => {
    const broken = new File([identifyingMovie().slice(0, -4)], 'broken.mp4', {
      type: 'video/mp4',
    });
    const unreadable = new File([identifyingMovie()], 'gone.mp4', {
      type: 'video/mp4',
    });
    // The sniff succeeds; every later read of the file fails, as when it is moved away.
    const realSlice = unreadable.slice.bind(unreadable);
    Object.defineProperty(unreadable, 'slice', {
      value: (start?: number, end?: number) =>
        start === 0 && end === SVG_SNIFF_BYTES
          ? realSlice(start, end)
          : {
              arrayBuffer: () =>
                Promise.reject(new DOMException('gone', 'NotReadableError')),
            },
    });

    expect(await withoutMediaMetadata(broken)).toBe(broken);
    expect(await withoutMediaMetadata(unreadable)).toBe(unreadable);
    expect(await strippedMedia(broken)).toBe(broken);
  });

  it('rejects in strippedMedia where withoutMediaMetadata returns the file as picked', async () => {
    const unreadable = new File([identifyingJpeg()], 'gone.jpg', {
      type: 'image/jpeg',
    });
    // The sniff succeeds; reading the whole image fails, as when it is moved away.
    Object.defineProperty(unreadable, 'arrayBuffer', {
      value: () => Promise.reject(new DOMException('gone', 'NotReadableError')),
    });

    expect(await withoutMediaMetadata(unreadable)).toBe(unreadable);
    await expect(strippedMedia(unreadable)).rejects.toThrow('gone');
  });

  it('strips a movie in strippedMedia exactly as withoutMediaMetadata does', async () => {
    const original = new File([identifyingMovie()], 'clip.mp4', {
      type: 'video/mp4',
    });

    const strict = await strippedMedia(original);
    const lenient = await withoutMediaMetadata(original);

    expect(strict).not.toBe(original);
    expect(new Uint8Array(await strict.arrayBuffer())).toEqual(
      new Uint8Array(await lenient.arrayBuffer()),
    );
  });
});

describe('bytesWithoutMediaMetadata', () => {
  it('blanks a video in the buffer it read, without a second copy', async () => {
    const input = largeMovie();
    const original = new File([input], 'clip.mp4', { type: 'video/mp4' });

    const { result, sizes } = await blobReads(() =>
      bytesWithoutMediaMetadata(original),
    );

    expect(sizes).toEqual([original.size]);
    const bytes = new Uint8Array(result);
    expect(bytes.length).toBe(input.length);
    expectNoVideoLocation(bytes);
    const mdat = topLevelBox(input, 'mdat');
    expect(
      sameBytes(
        bytes.subarray(mdat.start, mdat.end),
        input.subarray(mdat.start, mdat.end),
      ),
    ).toBe(true);
  });

  it('returns the original bytes of a malformed video', async () => {
    const input = identifyingMovie().slice(0, -4);
    const original = new File([input], 'broken.mp4', { type: 'video/mp4' });

    const bytes = new Uint8Array(await bytesWithoutMediaMetadata(original));

    expect(Array.from(bytes)).toEqual(Array.from(input));
  });
});

describe('bytesWithoutMediaMetadata for images', () => {
  beforeEach(() => {
    vi.mocked(joinParts).mockClear();
  });

  it('hands over a stripped TIFF without copying it again', async () => {
    const layout = tiffLayout('MM', [identifyingPage('MM')]);
    const scan = new File([layout.bytes], 'scan.tif', { type: 'image/tiff' });

    const bytes = new Uint8Array(await bytesWithoutMediaMetadata(scan));

    expect(Array.from(bytes)).toEqual(Array.from(expectedStrip(layout)));
    expect(joinParts).not.toHaveBeenCalled();
  });

  it('copies a single part that is only a view into the original', async () => {
    const clean = concat(JPEG_SOI, JPEG_JFIF, JPEG_IMAGE_DATA);
    const photo = new File([clean, ascii('trailing data')], 'IMG.jpg', {
      type: 'image/jpeg',
    });

    const bytes = new Uint8Array(await bytesWithoutMediaMetadata(photo));

    expect(Array.from(bytes)).toEqual(Array.from(clean));
  });

  it('returns the stripped plaintext for an image', async () => {
    const original = new File([identifyingJpeg()], 'IMG_0001.jpg', {
      type: 'image/jpeg',
    });

    const bytes = new Uint8Array(await bytesWithoutMediaMetadata(original));

    expect(bytes.length).toBeLessThan(original.size);
    expect(containsAscii(bytes, 'Canon')).toBe(false);
  });

  it('passes the file name on, so a raw file keeps its camera data', async () => {
    const layout = tiffLayout('MM', [identifyingPage('MM')]);
    const raw = new File([layout.bytes], 'DSC_0001.nef', {
      type: 'image/x-nikon-nef',
    });

    const bytes = new Uint8Array(await bytesWithoutMediaMetadata(raw));

    expect(Array.from(bytes)).toEqual(
      Array.from(expectedStrip(layout, { raw: true })),
    );
    expect(containsAscii(bytes, 'Canon')).toBe(true);
  });

  it('returns the original bytes for anything else', async () => {
    const payload = ascii('Canon at 52.5200N');
    const text = new File([payload], 'notes.txt', { type: 'text/plain' });

    const bytes = new Uint8Array(await bytesWithoutMediaMetadata(text));

    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });
});
