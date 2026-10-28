import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { downscaleImage } from './media-processing';

/** The decrypted original is 3 bytes long; the stubbed downscaled output is smaller. */
const ORIGINAL_BYTES = 3;
const DOWNSCALED_BYTES = 2;

let bitmapMock: Mock;
/** Every bitmap the stubbed `createImageBitmap` produced, in order (decoded, resized). */
let bitmaps: { close: Mock }[];
let convertToBlob: Mock;
let canvasSizes: { width: number; height: number }[];

/** Stub the browser decode/resize/encode boundary for an image of `w`×`h`. */
function stubBrowserImage(w: number, h: number): void {
  bitmaps = [];
  bitmapMock = vi.fn(async (_src: unknown, opts?: ImageBitmapOptions) => {
    const bitmap = {
      width: opts?.resizeWidth ?? w,
      height: opts?.resizeHeight ?? h,
      close: vi.fn(),
    };
    bitmaps.push(bitmap);
    return bitmap;
  });
  vi.stubGlobal('createImageBitmap', bitmapMock);
  convertToBlob = vi.fn(
    async (opts: { type: string }) =>
      new Blob([new Uint8Array(DOWNSCALED_BYTES)], { type: opts.type }),
  );
  canvasSizes = [];
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        canvasSizes.push({ width, height });
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      convertToBlob = convertToBlob;
    },
  );
}

const image = (
  type: string,
  bytes: BlobPart = new Uint8Array(ORIGINAL_BYTES),
) => new Blob([bytes], { type });

describe('downscaleImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shrinks a JPEG to the long edge and encodes it as JPEG', async () => {
    stubBrowserImage(3000, 2000);

    const result = await downscaleImage(image('image/jpeg'), 640);

    expect(bitmapMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resizeWidth: 640,
        resizeHeight: 427,
        resizeQuality: 'high',
      }),
    );
    expect(canvasSizes).toEqual([{ width: 640, height: 427 }]);
    expect(convertToBlob).toHaveBeenCalledWith({
      type: 'image/jpeg',
      quality: 0.8,
    });
    expect(result.size).toBe(DOWNSCALED_BYTES);
    expect(result.type).toBe('image/jpeg');
  });

  it.each([
    [320, 320, 213],
    [960, 960, 640],
  ])('shrinks to a %i px edge', async (edge, w, h) => {
    stubBrowserImage(3000, 2000);

    await downscaleImage(image('image/jpeg'), edge);

    expect(canvasSizes).toEqual([{ width: w, height: h }]);
  });

  it('re-encodes a PNG as WebP to keep transparency', async () => {
    stubBrowserImage(3000, 2000);

    const result = await downscaleImage(image('image/png'), 640);

    expect(convertToBlob).toHaveBeenCalledWith({
      type: 'image/webp',
      quality: 0.8,
    });
    expect(result.type).toBe('image/webp');
  });

  it('draws on a regular canvas when OffscreenCanvas is unavailable', async () => {
    stubBrowserImage(3000, 2000);
    vi.stubGlobal('OffscreenCanvas', undefined);
    const toBlob = vi.fn((cb: BlobCallback, type: string) =>
      cb(new Blob([new Uint8Array(DOWNSCALED_BYTES)], { type })),
    );
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas'
        ? { getContext: () => ({ drawImage: vi.fn() }), toBlob }
        : realCreate(tag)) as typeof document.createElement);

    const result = await downscaleImage(image('image/jpeg'), 640);

    expect(toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/jpeg',
      0.8,
    );
    expect(result.size).toBe(DOWNSCALED_BYTES);
  });

  describe('animated PNG labelled image/png', () => {
    /** Signature, IHDR, then `chunk` (when set) and IDAT: just the headers the scan reads. */
    function pngBytes(chunk?: string): Uint8Array<ArrayBuffer> {
      const bytes: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
      const add = (type: string, length: number) => {
        bytes.push(0, 0, 0, length, ...[...type].map((c) => c.charCodeAt(0)));
        bytes.push(...new Array<number>(length + 4).fill(0)); // data + CRC
      };
      add('IHDR', 13);
      if (chunk) add(chunk, 8);
      add('IDAT', 4);
      return new Uint8Array(bytes);
    }

    it('is kept as sent when an acTL chunk precedes the image data', async () => {
      stubBrowserImage(3000, 2000);
      const original = image('image/png', pngBytes('acTL'));

      const result = await downscaleImage(original, 640);

      expect(bitmapMock).not.toHaveBeenCalled();
      expect(result).toBe(original);
    });

    it('is still downscaled when it has no acTL chunk', async () => {
      stubBrowserImage(3000, 2000);

      const result = await downscaleImage(
        image('image/png', pngBytes('gAMA')),
        640,
      );

      expect(result.size).toBe(DOWNSCALED_BYTES);
    });
  });

  it('closes the full-size bitmap as soon as the resized one exists, and the resized one after encoding', async () => {
    stubBrowserImage(3000, 2000);
    let decodedClosedWhenEncoding = false;
    const encode = convertToBlob.getMockImplementation()!;
    convertToBlob.mockImplementation(async (opts: { type: string }) => {
      decodedClosedWhenEncoding = bitmaps[0].close.mock.calls.length > 0;
      return encode(opts);
    });

    await downscaleImage(image('image/jpeg'), 640);

    expect(decodedClosedWhenEncoding).toBe(true);
    expect(bitmaps).toHaveLength(2);
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    expect(bitmaps[1].close).toHaveBeenCalledTimes(1);
  });

  it('closes both bitmaps when encoding fails', async () => {
    stubBrowserImage(3000, 2000);
    convertToBlob.mockRejectedValue(new Error('encode failed'));

    await downscaleImage(image('image/jpeg'), 640);

    expect(bitmaps).toHaveLength(2);
    expect(bitmaps[0].close).toHaveBeenCalled();
    expect(bitmaps[1].close).toHaveBeenCalled();
  });

  it('closes the full-size bitmap and keeps the original when the resize fails', async () => {
    stubBrowserImage(3000, 2000);
    bitmapMock.mockImplementationOnce(bitmapMock.getMockImplementation()!);
    bitmapMock.mockImplementationOnce(async () => {
      throw new Error('resize failed');
    });
    const original = image('image/jpeg');

    const result = await downscaleImage(original, 640);

    expect(bitmaps).toHaveLength(1);
    expect(bitmaps[0].close).toHaveBeenCalled();
    expect(result).toBe(original);
  });

  it('keeps the original when the encoded thumbnail is bigger', async () => {
    stubBrowserImage(3000, 2000);
    convertToBlob.mockResolvedValue(
      new Blob([new Uint8Array(ORIGINAL_BYTES + 1)], { type: 'image/jpeg' }),
    );
    const original = image('image/jpeg');

    expect(await downscaleImage(original, 640)).toBe(original);
  });

  it('keeps an image already within the edge as is', async () => {
    stubBrowserImage(600, 400);
    const original = image('image/jpeg');

    const result = await downscaleImage(original, 640);

    expect(canvasSizes).toEqual([]);
    expect(result).toBe(original);
  });

  it('falls back to the original when decoding fails', async () => {
    stubBrowserImage(3000, 2000);
    bitmapMock.mockRejectedValue(new Error('undecodable'));
    const original = image('image/jpeg');

    expect(await downscaleImage(original, 640)).toBe(original);
  });

  it('falls back to the original when encoding fails', async () => {
    stubBrowserImage(3000, 2000);
    convertToBlob.mockRejectedValue(new Error('encode failed'));
    const original = image('image/jpeg');

    expect(await downscaleImage(original, 640)).toBe(original);
  });
});
