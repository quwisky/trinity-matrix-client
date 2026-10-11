import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinParts } from './image-metadata';
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
  bytesWithoutImageMetadata,
  withoutImageMetadata,
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

describe('bytesWithoutImageMetadata', () => {
  beforeEach(() => {
    vi.mocked(joinParts).mockClear();
  });

  it('hands over a stripped TIFF without copying it again', async () => {
    const layout = tiffLayout('MM', [identifyingPage('MM')]);
    const scan = new File([layout.bytes], 'scan.tif', { type: 'image/tiff' });

    const bytes = new Uint8Array(await bytesWithoutImageMetadata(scan));

    expect(Array.from(bytes)).toEqual(Array.from(expectedStrip(layout)));
    expect(joinParts).not.toHaveBeenCalled();
  });

  it('copies a single part that is only a view into the original', async () => {
    const clean = concat(JPEG_SOI, JPEG_JFIF, JPEG_IMAGE_DATA);
    const photo = new File([clean, ascii('trailing data')], 'IMG.jpg', {
      type: 'image/jpeg',
    });

    const bytes = new Uint8Array(await bytesWithoutImageMetadata(photo));

    expect(Array.from(bytes)).toEqual(Array.from(clean));
  });

  it('returns the stripped plaintext for an image', async () => {
    const original = new File([identifyingJpeg()], 'IMG_0001.jpg', {
      type: 'image/jpeg',
    });

    const bytes = new Uint8Array(await bytesWithoutImageMetadata(original));

    expect(bytes.length).toBeLessThan(original.size);
    expect(containsAscii(bytes, 'Canon')).toBe(false);
  });

  it('passes the file name on, so a raw file keeps its camera data', async () => {
    const layout = tiffLayout('MM', [identifyingPage('MM')]);
    const raw = new File([layout.bytes], 'DSC_0001.nef', {
      type: 'image/x-nikon-nef',
    });

    const bytes = new Uint8Array(await bytesWithoutImageMetadata(raw));

    expect(Array.from(bytes)).toEqual(
      Array.from(expectedStrip(layout, { raw: true })),
    );
    expect(containsAscii(bytes, 'Canon')).toBe(true);
  });

  it('returns the original bytes for anything else', async () => {
    const payload = ascii('Canon at 52.5200N');
    const text = new File([payload], 'notes.txt', { type: 'text/plain' });

    const bytes = new Uint8Array(await bytesWithoutImageMetadata(text));

    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });
});
