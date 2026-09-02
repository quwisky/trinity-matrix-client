import type { Locator } from '@playwright/test';

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
  source: 'backgroundColor' | 'color' | `--${string}`,
): Promise<RenderedColour> =>
  locator.evaluate((element: HTMLElement, name) => {
    const style = getComputedStyle(element);
    const value = name.startsWith('--')
      ? style.getPropertyValue(name).trim()
      : name === 'backgroundColor'
        ? style.backgroundColor
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
