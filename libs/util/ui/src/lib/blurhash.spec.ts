import { encode } from 'blurhash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BLURHASH_LENGTH, blurhashToDataUrl } from './blurhash';

/**
 * Decoding needs a canvas, and jsdom has none — `getContext('2d')` returns null, which the
 * function treats as "no placeholder". Left alone, every assertion here would pass against
 * a body of `return null`, so the happy path is given a canvas double and the pixels are
 * read back out of it. What is under test is this module's wiring — the decode size, the
 * byte order, the guards — not the library's DCT maths.
 */
function stubCanvas(): { pixels: () => Uint8ClampedArray | null } {
  let captured: ImageData | null = null;
  const context = {
    createImageData: (width: number, height: number) =>
      ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }) as ImageData,
    putImageData: (image: ImageData) => {
      captured = image;
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,STUB',
  };
  vi.spyOn(document, 'createElement').mockReturnValue(
    canvas as unknown as HTMLCanvasElement,
  );
  return { pixels: () => (captured as ImageData | null)?.data ?? null };
}

/** A blurhash of a solid colour, so what comes back out is checkable by eye and by test. */
function hashOfSolid(r: number, g: number, b: number): string {
  const size = 4;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels.set([r, g, b, 255], i * 4);
  }
  return encode(pixels, size, size, 4, 4);
}

describe('blurhashToDataUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  it('paints the colour the hash encodes', () => {
    const canvas = stubCanvas();

    const url = blurhashToDataUrl(hashOfSolid(220, 30, 40));

    expect(url).toBe('data:image/png;base64,STUB');
    const data = canvas.pixels();
    expect(data).not.toBeNull();
    // 32 x 32 x RGBA. A wrong decode size or a mis-set buffer shows up here first.
    expect(data?.length).toBe(32 * 32 * 4);
    // Red, and opaque. Generous bounds: this asserts the channels are not transposed or
    // shifted, not that the codec round-trips to an exact value.
    const [red, green, blue, alpha] = data as Uint8ClampedArray;
    expect(red).toBeGreaterThan(150);
    expect(green).toBeLessThan(120);
    expect(blue).toBeLessThan(120);
    expect(alpha).toBe(255);
  });

  it('tells two different hashes apart', () => {
    // Guards against a stub that reports the same buffer whatever it was handed — the way
    // the test above could pass while decoding nothing.
    const first = stubCanvas();
    blurhashToDataUrl(hashOfSolid(220, 30, 40));
    const red = first.pixels()?.[0] ?? 0;
    vi.restoreAllMocks();

    const second = stubCanvas();
    blurhashToDataUrl(hashOfSolid(20, 30, 220));
    const blue = second.pixels()?.[0] ?? 0;

    expect(red).toBeGreaterThan(blue + 100);
  });

  it('ignores a missing hash', () => {
    stubCanvas();
    expect(blurhashToDataUrl(undefined)).toBeNull();
    expect(blurhashToDataUrl('')).toBeNull();
  });

  it('refuses an over-long hash before scanning it', () => {
    // The cap bounds WORK, and that is all it does — `isBlurhashValid` refuses any
    // over-long string anyway, so no test can attribute a rejection to the cap alone. The
    // first version of this test tried, and passed with the cap deleted.
    //
    // What IS attributable is the ordering: the length check runs before the alphabet scan,
    // so a hostile megabyte is never scanned. Asserted by watching the regex rather than by
    // timing it, which would be flaky.
    const canvas = stubCanvas();
    const scan = vi.spyOn(RegExp.prototype, 'test');
    const huge = 'L'.repeat(1_000_000);
    expect(huge.length).toBeGreaterThan(MAX_BLURHASH_LENGTH);

    expect(blurhashToDataUrl(huge)).toBeNull();
    expect(canvas.pixels()).toBeNull();
    expect(scan).not.toHaveBeenCalled();

    // …and the scan does run for something short enough to be worth checking, so the
    // assertion above is about ORDER and not about the spy never firing at all.
    blurhashToDataUrl('LEHV6nWB2yk8pyo0adR*.7kCMdn!');
    expect(scan).toHaveBeenCalled();
  });

  it('ignores a malformed hash rather than throwing', () => {
    stubCanvas();
    // Two ways a federated hash arrives broken, and the library's own validator catches
    // only the second: `!` is outside the base83 alphabet (which it does not check at all),
    // and the short string's declared component count does not match its length.
    expect(blurhashToDataUrl('LEHV6nWB2yk8pyo0adR*.7kCMdn!')).toBeNull();
    expect(blurhashToDataUrl('LEHV6nWB2yk8')).toBeNull();

    // `#` IS legal base83, so this must still decode — a validator that rejected the whole
    // punctuation range would look correct here while quietly refusing real hashes.
    expect(blurhashToDataUrl('LEHV6nWB2yk8pyo0adR*.7kCMdn#')).not.toBeNull();
  });
});
