/** A colour in 8-bit sRGB. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The contrast a sender colour must keep (owner decision 2), by WCAG 2 relative luminance. */
export const MIN_SENDER_CONTRAST = 3;

/** One sender element's requested colours, already validated as `#RRGGBB`. */
export interface ColourRequest {
  readonly fg: Rgb | null;
  readonly bg: Rgb | null;
}

/** Which of an element's requested colours survive the guard. */
export interface ColourDecision {
  readonly fg: boolean;
  readonly bg: boolean;
}

// Fixed patterns over theme values and computed styles, never built from message text.
const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const RGB_FUNCTION =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i;
const OKLCH_FUNCTION =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/i;

/** Six hex digits, with or without `#`, as sRGB; anything else is null. */
export function parseHexColour(value: string): Rgb | null {
  const match = HEX6.exec(value);
  return match
    ? {
        r: Number.parseInt(match[1], 16),
        g: Number.parseInt(match[2], 16),
        b: Number.parseInt(match[3], 16),
      }
    : null;
}

/**
 * The colour forms Trinity's surfaces arrive in: hex, `rgb()`/`rgba()` and `oklch()` (the theme
 * tokens are OKLCH, and Chromium keeps OKLCH in computed values). Null for anything else, so the
 * caller can ask the browser instead: a malformed number (`1.2.3`), and a see-through colour
 * (alpha below 1, such as Chromium's computed `transparent`, `rgba(0, 0, 0, 0)`), whose
 * appearance depends on what lies behind it.
 */
export function parseCssColour(value: string): Rgb | null {
  const text = value.trim();
  if (text.startsWith('#')) {
    const short = HEX3.exec(text);
    if (short) {
      return {
        r: Number.parseInt(short[1] + short[1], 16),
        g: Number.parseInt(short[2] + short[2], 16),
        b: Number.parseInt(short[3] + short[3], 16),
      };
    }
    return parseHexColour(text);
  }
  const rgb = RGB_FUNCTION.exec(text);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
    return opaque(rgb[4], rgb[5]) && allFinite(r, g, b)
      ? { r: channel(r), g: channel(g), b: channel(b) }
      : null;
  }
  const oklch = OKLCH_FUNCTION.exec(text);
  if (oklch) {
    const lightness = Number(oklch[1]) / (oklch[2] ? 100 : 1);
    // A percentage chroma is relative to 0.4, CSS Color 4's reference range.
    const chroma = oklch[4] ? (Number(oklch[3]) / 100) * 0.4 : Number(oklch[3]);
    const hue = Number(oklch[5]);
    return opaque(oklch[6], oklch[7]) && allFinite(lightness, chroma, hue)
      ? oklchToRgb(lightness, chroma, hue)
      : null;
  }
  return null;
}

/** OKLCH to gamut-clipped 8-bit sRGB (Björn Ottosson's OKLab matrices). */
export function oklchToRgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): Rgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const aAxis = chroma * Math.cos(hue);
  const bAxis = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * aAxis + 0.2158037573 * bAxis) ** 3;
  const m = (lightness - 0.1055613458 * aAxis - 0.0638541728 * bAxis) ** 3;
  const s = (lightness - 0.0894841775 * aAxis - 1.291485548 * bAxis) ** 3;
  return {
    r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** WCAG 2 relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio, 1 to 21, in either argument order. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Which colours of one element to keep (spec A1, contrast guard):
 * - text colour only: against `background` (the nearest kept sender background, else the
 *   message surface);
 * - background only: against `inheritedText` (the nearest kept sender text colour, else the
 *   theme's);
 * - both: kept as a pair when they reach 3:1 against each other; otherwise the text colour is
 *   dropped and the background is checked alone.
 */
export function decideColours(
  request: ColourRequest,
  inheritedText: Rgb,
  background: Rgb,
): ColourDecision {
  const { fg, bg } = request;
  const readable = (a: Rgb, b: Rgb): boolean =>
    contrastRatio(a, b) >= MIN_SENDER_CONTRAST;
  if (fg && bg && readable(fg, bg)) {
    return { fg: true, bg: true };
  }
  if (bg) {
    return { fg: false, bg: readable(inheritedText, bg) };
  }
  return { fg: fg !== null && readable(fg, background), bg: false };
}

/** A colour as `#rrggbb`, the only form written back through the CSSOM. */
export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function allFinite(...values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

/** No alpha, or an alpha of at least 1 (CSS clamps above it); a malformed alpha is not opaque. */
function opaque(
  alpha: string | undefined,
  percent: string | undefined,
): boolean {
  return alpha === undefined || Number(alpha) / (percent ? 100 : 1) >= 1;
}

function linear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function encode(linearValue: number): number {
  const c = Math.min(1, Math.max(0, linearValue));
  const gamma = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(gamma * 255);
}
