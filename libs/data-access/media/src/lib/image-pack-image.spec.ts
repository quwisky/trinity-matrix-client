import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImagePackImageError, prepareImagePackImage } from './image-pack-image';

const ONE_MB = 1_048_576;

function stubBrowserImage(w: number, h: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (_src: unknown, opts?: ImageBitmapOptions) => ({
      width: opts?.resizeWidth ?? w,
      height: opts?.resizeHeight ?? h,
      close: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { drawImage: vi.fn() };
      }
      async convertToBlob(opts: { type: string }) {
        return new Blob([new Uint8Array(5000)], { type: opts.type });
      }
    },
  );
}

const png = (bytes = 10) =>
  new File([new Uint8Array(bytes)], 'a.png', { type: 'image/png' });

const gif = (bytes: number) =>
  new File([new Uint8Array(bytes)], 'a.gif', { type: 'image/gif' });

/** The resize edge the image was scaled to, if it was scaled. */
async function resizedEdge(
  usage: Parameters<typeof prepareImagePackImage>[1],
): Promise<number | undefined> {
  await prepareImagePackImage(png(100), usage);
  const calls = vi.mocked(createImageBitmap).mock.calls as unknown as [
    unknown,
    ImageBitmapOptions | undefined,
  ][];
  return calls.find(([, opts]) => opts?.resizeWidth)?.[1]?.resizeWidth;
}

const webp = (bytes: number, flags: number) => {
  const data = new Uint8Array(bytes);
  data.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  data.set(
    [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
    8,
  );
  data[20] = flags;
  return new File([data], 'a.webp', { type: 'image/webp' });
};

describe('prepareImagePackImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downscales a 1024 px PNG to 256 px for emoji', async () => {
    stubBrowserImage(1024, 1024);
    expect(await resizedEdge(['emoticon'])).toBe(256);
  });

  it('to 512 px for sticker and for both', async () => {
    stubBrowserImage(1024, 1024);
    expect(await resizedEdge(['sticker'])).toBe(512);
    stubBrowserImage(1024, 1024);
    expect(await resizedEdge(['emoticon', 'sticker'])).toBe(512);
  });

  it('downscales a large static WebP, keeping alpha and fixing the extension', async () => {
    stubBrowserImage(1024, 1024);
    const out = await prepareImagePackImage(webp(100, 0), ['emoticon']);
    expect(out.type).toBe('image/webp');
    expect(out.name).toBe('a.webp');
  });

  it('returns resized output for a PNG even when it is larger in bytes, as WebP', async () => {
    stubBrowserImage(1024, 1024);
    const out = await prepareImagePackImage(png(100), ['emoticon']);
    expect(out.size).toBe(5000);
    expect(out.type).toBe('image/webp');
    expect(out.name).toBe('a.webp');
  });

  it('keeps an animated WebP unchanged under 1 MB and rejects it over', async () => {
    const small = webp(ONE_MB, 0x02);
    expect(await prepareImagePackImage(small, ['emoticon'])).toBe(small);
    await expect(
      prepareImagePackImage(webp(ONE_MB + 1, 0x02), ['emoticon']),
    ).rejects.toMatchObject({ code: 'animated-too-large' });
  });

  it('keeps a small image unchanged', async () => {
    stubBrowserImage(100, 100);
    const file = png();
    expect(await prepareImagePackImage(file, ['emoticon'])).toBe(file);
  });

  it('keeps an animated GIF unchanged under 1 MB', async () => {
    const file = gif(ONE_MB);
    expect(await prepareImagePackImage(file, ['emoticon'])).toBe(file);
  });

  it('rejects an animated GIF over 1 MB with animated-too-large', async () => {
    const result = prepareImagePackImage(gif(ONE_MB + 1), ['emoticon']);
    await expect(result).rejects.toBeInstanceOf(ImagePackImageError);
    await expect(result).rejects.toMatchObject({ code: 'animated-too-large' });
  });

  it('rejects image/svg+xml with unsupported-type', async () => {
    const file = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' });
    await expect(
      prepareImagePackImage(file, ['emoticon']),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
  });
});
