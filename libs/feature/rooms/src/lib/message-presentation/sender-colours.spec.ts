import { describe, expect, it } from 'vitest';
import {
  MIN_SENDER_CONTRAST,
  contrastRatio,
  decideColours,
  parseCssColour,
  parseHexColour,
  relativeLuminance,
  toHex,
  type Rgb,
} from './sender-colours';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const grey = (value: number): Rgb => ({ r: value, g: value, b: value });

/** Within one 8-bit step per channel: OKLCH conversions round. */
function expectNear(actual: Rgb | null, expected: Rgb): void {
  expect(actual).not.toBeNull();
  for (const channel of ['r', 'g', 'b'] as const) {
    expect(
      Math.abs((actual as Rgb)[channel] - expected[channel]),
    ).toBeLessThanOrEqual(1);
  }
}

describe('sender colour parsing', () => {
  it('reads six hex digits, with or without #, in either case', () => {
    expect(parseHexColour('e03030')).toEqual({ r: 224, g: 48, b: 48 });
    expect(parseHexColour('#E03030')).toEqual({ r: 224, g: 48, b: 48 });
  });

  it.each(['#abc', 'red', 'e0303', '#e03030ff', 'rgb(1, 2, 3)', ''])(
    'rejects %j as a sender colour',
    (value) => {
      expect(parseHexColour(value)).toBeNull();
    },
  );

  it('reads the computed-colour forms browsers produce', () => {
    expect(parseCssColour('#fff')).toEqual(WHITE);
    expect(parseCssColour('rgb(224, 48, 48)')).toEqual({
      r: 224,
      g: 48,
      b: 48,
    });
    expect(parseCssColour('rgba(224, 48, 48, 0.5)')).toEqual({
      r: 224,
      g: 48,
      b: 48,
    });
    expect(parseCssColour('rgb(224 48 48 / 50%)')).toEqual({
      r: 224,
      g: 48,
      b: 48,
    });
    expect(parseCssColour('color-mix(in oklch, red, blue)')).toBeNull();
  });

  it('resolves the OKLCH theme surfaces to sRGB', () => {
    // The default theme's light and dark canvases (variables.scss :321 and :494).
    expectNear(parseCssColour('oklch(99% 0.004 85deg)'), {
      r: 253,
      g: 252,
      b: 249,
    });
    expectNear(parseCssColour('oklch(20% 0.005 269deg)'), {
      r: 21,
      g: 22,
      b: 24,
    });
    // Chromium serializes computed OKLCH with a 0–1 lightness and bare numbers.
    expectNear(parseCssColour('oklch(0.2 0.005 269)'), { r: 21, g: 22, b: 24 });
    expectNear(parseCssColour('oklch(100% 0 0deg)'), WHITE);
  });
});

describe('contrast (WCAG 2 relative luminance)', () => {
  it('measures luminance and the 21:1 extreme', () => {
    // The three coefficients sum to 1 only up to floating-point rounding.
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
  });

  it('keeps a text colour at 3:1 and drops one just below', () => {
    expect(MIN_SENDER_CONTRAST).toBe(3);
    expect(contrastRatio(grey(0x94), WHITE)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(grey(0x95), WHITE)).toBeLessThan(3);
    expect(decideColours({ fg: grey(0x94), bg: null }, BLACK, WHITE)).toEqual({
      fg: true,
      bg: false,
    });
    expect(decideColours({ fg: grey(0x95), bg: null }, BLACK, WHITE)).toEqual({
      fg: false,
      bg: false,
    });
  });
});

describe('which sender colours to keep', () => {
  const yellow: Rgb = { r: 255, g: 235, b: 59 };
  const darkText: Rgb = { r: 56, g: 50, b: 45 };
  const lightText: Rgb = { r: 221, g: 222, b: 225 };

  it('checks a background alone against the inherited text colour', () => {
    expect(decideColours({ fg: null, bg: yellow }, darkText, WHITE)).toEqual({
      fg: false,
      bg: true,
    });
    expect(decideColours({ fg: null, bg: yellow }, lightText, BLACK)).toEqual({
      fg: false,
      bg: false,
    });
  });

  it('keeps a readable pair whatever the surface', () => {
    expect(decideColours({ fg: BLACK, bg: yellow }, lightText, BLACK)).toEqual({
      fg: true,
      bg: true,
    });
  });

  it('drops the text colour of an unreadable pair and checks the background alone', () => {
    const paleYellow: Rgb = { r: 255, g: 255, b: 0 };
    expect(
      decideColours({ fg: paleYellow, bg: yellow }, darkText, WHITE),
    ).toEqual({ fg: false, bg: true });
    expect(
      decideColours({ fg: paleYellow, bg: yellow }, lightText, BLACK),
    ).toEqual({ fg: false, bg: false });
  });

  it('keeps nothing when the sender asked for nothing', () => {
    expect(decideColours({ fg: null, bg: null }, darkText, WHITE)).toEqual({
      fg: false,
      bg: false,
    });
  });

  it('writes a colour back as #rrggbb', () => {
    expect(toHex({ r: 224, g: 48, b: 8 })).toBe('#e03008');
  });
});
