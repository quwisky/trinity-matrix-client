import type { Locator, Page } from '@playwright/test';

/** An opaque sRGB colour, 0-255 per channel. */
export interface Srgb {
  r: number;
  g: number;
  b: number;
}

/** What an element's label actually ends up looking like, once everything is painted. */
export interface MeasuredContrast {
  /** The text colour, flattened to opaque sRGB. */
  text: Srgb;
  /** Every background between the text and the first opaque surface, composited. */
  background: Srgb;
  /** WCAG 2.1 contrast ratio between the two. */
  ratio: number;
  /** The CSS colour strings that were composited, nearest-opaque-ancestor first. */
  layers: string[];
}

/** sRGB relative luminance, per WCAG 2.1. */
function luminance({ r, g, b }: Srgb): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Srgb, b: Srgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const AA_NORMAL_TEXT = 4.5;

/**
 * Resolve a CSS custom property to sRGB **in the element's own cascade**.
 *
 * Not from `document.documentElement`: this app scopes `--trinity-*` overrides to subtrees
 * (`login.page.scss` re-points `--background` on `.login-page`, and again inside a media
 * query), so a token read at the root can differ from the one the element actually sees.
 * Reading it where the element sits is the only comparison that means anything.
 */
export async function resolveTokenSrgb(
  page: Page,
  testId: string,
  token: string,
): Promise<Srgb> {
  return page
    .getByTestId(testId)
    .evaluate((element: HTMLElement, name: string) => {
      const value = getComputedStyle(element).getPropertyValue(name).trim();
      if (!value) {
        throw new Error(`contrast: "${name}" is not defined here`);
      }
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('contrast: no 2d canvas context');
      }
      const sentinel = '#010203';
      ctx.fillStyle = sentinel;
      ctx.fillStyle = value;
      if (ctx.fillStyle === sentinel && value !== sentinel) {
        throw new Error(`contrast: "${name}" is not a colour ("${value}")`);
      }
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    }, token);
}

/**
 * Measure what an element's label really contrasts against, in the browser.
 *
 * Colour is resolved by the page's own `<canvas>`, deliberately, rather than by parsing
 * `getComputedStyle` here. Computed values come back in whatever notation the stylesheet
 * used — Tailwind emits `color-mix(in oklab, var(--destructive) 10%, transparent)` for a
 * tinted button — so a regex that assumes `rgb()` reads the three oklab components as RGB
 * channels and returns a plausible, wrong answer instead of failing. Canvas accepts every
 * CSS colour syntax the stylesheet can produce and hands back composited sRGB bytes, which
 * is the number a person actually sees.
 *
 * Backgrounds are collected from the element up its ancestor chain until a fully opaque one is
 * found and composited in order, so a translucent wrapper between the element and its surface is
 * accounted for rather than mistaken for the surface. Not finding an opaque surface throws:
 * defaulting to white there would fabricate a passing ratio on a dark theme.
 */
export async function measureContrast(
  page: Page,
  testId: string,
): Promise<MeasuredContrast> {
  return measureLocatorContrast(page.getByTestId(testId));
}

/** Measure rendered text contrast for a locator when the target is inside a public host. */
export async function measureLocatorContrast(
  locator: Locator,
): Promise<MeasuredContrast> {
  const measured = await locator.evaluate((element: HTMLElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('contrast: no 2d canvas context');
    }

    /** Paint `colour` over whatever is already there; throws if the browser rejects it. */
    const paint = (colour: string): void => {
      const sentinel = '#010203';
      ctx.fillStyle = sentinel;
      ctx.fillStyle = colour;
      if (ctx.fillStyle === sentinel && colour.trim() !== sentinel) {
        throw new Error(`contrast: browser rejected the colour "${colour}"`);
      }
      ctx.fillRect(0, 0, 1, 1);
    };

    const readPixel = (): { r: number; g: number; b: number; a: number } => {
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a };
    };

    const isOpaque = (colour: string): boolean => {
      ctx.clearRect(0, 0, 1, 1);
      paint(colour);
      return readPixel().a === 255;
    };

    // Nearest opaque surface first, then every translucent background below it. Start at
    // the measured element because controls such as tooltips can own the first opaque paint;
    // in that case no ancestor colour participates in the pixels a person sees.
    const stack: string[] = [];
    let node: HTMLElement | null = element;
    let base: string | null = null;
    while (node) {
      const background = getComputedStyle(node).backgroundColor;
      if (isOpaque(background)) {
        base = background;
        break;
      }
      stack.unshift(background);
      node = node.parentElement;
    }
    if (base === null) {
      throw new Error(
        'contrast: no opaque ancestor background — refusing to assume white',
      );
    }

    const layers = [base, ...stack];
    ctx.clearRect(0, 0, 1, 1);
    for (const layer of layers) {
      paint(layer);
    }
    const background = readPixel();

    // The text colour is flattened onto that same background, so a translucent label
    // (opacity utilities, disabled states) is measured as it is seen.
    paint(getComputedStyle(element).color);
    const text = readPixel();

    return {
      text: { r: text.r, g: text.g, b: text.b },
      background: { r: background.r, g: background.g, b: background.b },
      layers,
    };
  });

  return {
    ...measured,
    ratio: contrastRatio(measured.text, measured.background),
  };
}
