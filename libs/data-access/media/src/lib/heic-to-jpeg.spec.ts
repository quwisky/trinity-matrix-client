import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { HEIC_DECODE_DEADLINE_MS, heicToJpeg } from './heic-to-jpeg';

type FakeWorker = {
  postMessage: Mock;
  terminate: Mock;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

const fakeWorker = (): FakeWorker & Worker =>
  ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  }) as unknown as FakeWorker & Worker;

const heic = (name = 'IMG_1.heic', type = 'image/heic') =>
  new File([new Uint8Array([1, 2, 3])], name, { type, lastModified: 42 });

describe('heicToJpeg', () => {
  let bitmapMock: Mock;
  let convertToBlob: Mock;

  beforeEach(() => {
    bitmapMock = vi.fn(async () => ({
      width: 4000,
      height: 3000,
      close: vi.fn(),
    }));
    convertToBlob = vi.fn(
      async (opts: { type: string }) =>
        new Blob([new Uint8Array(2)], { type: opts.type }),
    );
    vi.stubGlobal('createImageBitmap', bitmapMock);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return { drawImage: vi.fn() };
        }
        convertToBlob = convertToBlob;
      },
    );
    if (typeof ImageData === 'undefined') {
      vi.stubGlobal(
        'ImageData',
        class {
          constructor(
            readonly data: Uint8ClampedArray,
            readonly width: number,
            readonly height: number,
          ) {}
        },
      );
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns a non-HEIC file untouched and starts no worker', async () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const createWorker = vi.fn();
    expect(await heicToJpeg(png, createWorker)).toBe(png);
    expect(bitmapMock).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('converts through the platform decoder when it can read the file', async () => {
    const createWorker = vi.fn();
    const out = await heicToJpeg(heic(), createWorker);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_1.jpg');
    expect(out.lastModified).toBe(42);
    expect(convertToBlob).toHaveBeenCalledWith({
      type: 'image/jpeg',
      quality: 0.9,
    });
    expect(bitmapMock).toHaveBeenCalledWith(expect.any(File), {
      imageOrientation: 'from-image',
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('asks the worker when the platform cannot decode, and terminates it', async () => {
    bitmapMock.mockRejectedValueOnce(new Error('unsupported'));
    const worker = fakeWorker();
    const pending = heicToJpeg(heic(), () => worker);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.onmessage?.({
      data: { width: 2, height: 1, rgba: new ArrayBuffer(8) },
    } as MessageEvent);
    const out = await pending;
    expect(out.type).toBe('image/jpeg');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a null reply',
      (w: FakeWorker) => w.onmessage?.({ data: null } as MessageEvent),
    ],
    ['a worker error', (w: FakeWorker) => w.onerror?.(new ErrorEvent('error'))],
  ])('sends the original after %s', async (_label, fail) => {
    bitmapMock.mockRejectedValueOnce(new Error('unsupported'));
    const worker = fakeWorker();
    const file = heic();
    const pending = heicToJpeg(file, () => worker);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    fail(worker);
    expect(await pending).toBe(file);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('gives up on a decoder that never answers', async () => {
    vi.useFakeTimers();
    bitmapMock.mockRejectedValueOnce(new Error('unsupported'));
    const worker = fakeWorker();
    const file = heic();
    const pending = heicToJpeg(file, () => worker);
    await vi.advanceTimersByTimeAsync(HEIC_DECODE_DEADLINE_MS);
    expect(await pending).toBe(file);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('sends the original where no worker can start', async () => {
    bitmapMock.mockRejectedValueOnce(new Error('unsupported'));
    const file = heic();
    expect(await heicToJpeg(file, () => null)).toBe(file);
  });

  it('sends the original when the JPEG encode yields nothing', async () => {
    convertToBlob.mockResolvedValueOnce(null);
    const file = heic();
    expect(await heicToJpeg(file, vi.fn())).toBe(file);
  });

  it.each([
    ['IMG_0001.HEIC', '', 'IMG_0001.jpg'],
    ['a.b.heif', 'image/heif', 'a.b.jpg'],
    ['photo', 'image/heic', 'photo.jpg'],
    ['', 'image/heic', ''],
    ['burst.heics', 'image/heic-sequence', 'burst.jpg'],
    ['x.heic', 'IMAGE/HEIC; charset=binary', 'x.jpg'],
  ])('names %s (%s) as %s', async (name, type, expected) => {
    expect((await heicToJpeg(heic(name, type), vi.fn())).name).toBe(expected);
  });

  it('leaves an untyped file without a HEIC extension alone', async () => {
    const file = heic('notes.txt', '');
    expect(await heicToJpeg(file, vi.fn())).toBe(file);
  });
});
