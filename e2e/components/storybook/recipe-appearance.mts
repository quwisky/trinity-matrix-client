import type { Locator } from '@playwright/test';
import type { Srgb } from '../../browser/support/contrast.mts';

export interface RenderedColour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const renderedRecipeStyle = (locator: Locator) =>
  locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      color: style.color,
      height: bounds.height,
      paddingBlock: style.paddingBlock,
      paddingInline: style.paddingInline,
    };
  });

export const renderedColour = (
  locator: Locator,
  source: 'backgroundColor' | 'borderColor' | 'color' | `--${string}`,
): Promise<RenderedColour> =>
  locator.evaluate((element: HTMLElement, name) => {
    const style = getComputedStyle(element);
    const value = name.startsWith('--')
      ? style.getPropertyValue(name).trim()
      : name === 'backgroundColor'
        ? style.backgroundColor
        : name === 'borderColor'
          ? style.borderColor
          : style.color;
    if (!value) {
      throw new Error(`Storybook recipe colour ${name} is empty`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Storybook recipe colour has no 2d canvas context');
    }
    const sentinel = '#010203';
    context.fillStyle = sentinel;
    context.fillStyle = value;
    if (context.fillStyle === sentinel && value !== sentinel) {
      throw new Error(`Browser rejected recipe colour ${name}="${value}"`);
    }
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  }, source);

export async function computedColour(
  element: Locator,
  property: string,
): Promise<Srgb> {
  return element.evaluate((node, name) => {
    const value = getComputedStyle(node).getPropertyValue(name);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('foundation states: no canvas context');
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  }, property);
}

/** One visible `box-shadow` layer: its colour flattened to sRGB, its alpha and its spread. */
export interface ShadowLayer {
  colour: Srgb;
  alpha: number;
  spread: number;
}

/**
 * Every visible layer of a computed `box-shadow` list, topmost first. Tailwind composes its
 * ring and inset layers into every shadow utility as transparent placeholders, so fully
 * transparent layers are skipped.
 */
export async function boxShadowLayers(
  element: Locator,
): Promise<ShadowLayer[]> {
  return element.evaluate((node) => {
    const shadow = getComputedStyle(node).boxShadow;
    const layers = [
      ...shadow.matchAll(
        /((?:rgba?|oklch|oklab|lab|lch|color)\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/gu,
      ),
    ];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('foundation states: no canvas context');
    return layers.flatMap(([, colour, , , , spread]) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return alpha === 0
        ? []
        : [{ colour: { r, g, b }, alpha, spread: Number(spread) }];
    });
  });
}
