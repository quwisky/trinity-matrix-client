import { afterEach, describe, expect, it, vi } from 'vitest';
import { cssColorToHex } from './overlay-colors';

/** A 2D context with real `fillStyle` semantics: unparseable values are ignored. */
function stubCanvas(resolve: (css: string) => string | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => {
      let style = '#000000';
      return {
        get fillStyle() {
          return style;
        },
        set fillStyle(value: string) {
          style = /^#[0-9a-f]{6}$/.test(value)
            ? value
            : (resolve(value) ?? style);
        },
        clearRect: () => undefined,
        fillRect: () => undefined,
        getImageData: () => {
          const n = parseInt(style.slice(1), 16);
          return { data: [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255] };
        },
      };
    }) as never,
  );
}

describe('cssColorToHex', () => {
  afterEach(() => vi.restoreAllMocks());

  it('converts rgb() to #rrggbb', () => {
    expect(cssColorToHex('rgb(18, 18, 20)')).toBe('#121214');
    expect(cssColorToHex('rgba(219 222 225 / 1)')).toBe('#dbdee1');
  });

  it('returns null for an empty colour', () => {
    expect(cssColorToHex('')).toBeNull();
  });

  describe('canvas read-back', () => {
    const known: Record<string, string> = {
      'oklch(16% 0.004 270deg)': '#121214',
      black: '#000000',
      white: '#ffffff',
    };
    const resolve = (css: string) => known[css] ?? null;

    it('normalises a colour the browser understands', () => {
      stubCanvas(resolve);
      expect(cssColorToHex('oklch(16% 0.004 270deg)')).toBe('#121214');
    });

    it('returns null, not black, for a colour the browser rejects', () => {
      stubCanvas(resolve);
      expect(cssColorToHex('var(--unresolved)')).toBeNull();
    });

    it('still accepts genuine black and white', () => {
      stubCanvas(resolve);
      expect(cssColorToHex('black')).toBe('#000000');
      expect(cssColorToHex('white')).toBe('#ffffff');
    });

    it('sends percentage rgb() through the canvas', () => {
      stubCanvas((css) => (css === 'rgb(10% 10% 10%)' ? '#1a1a1a' : null));
      expect(cssColorToHex('rgb(10% 10% 10%)')).toBe('#1a1a1a');
    });
  });
});
