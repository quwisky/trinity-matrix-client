import { expect, type Locator, type Page } from '@playwright/test';
import { contrastRatio, type Srgb } from '../../browser/support/contrast.mts';

/** Painted colours across a focused control's left edge, outside in. */
export interface FocusRingPixels {
  surface: Srgb;
  ring: Srgb;
  gap: Srgb;
  fill: Srgb;
}

/** Contrast between the neighbours a separated focus ring paints. */
export interface SeparatedRingRatios {
  ringToGap: number;
  ringToSurface: number;
  gapToSurface: number;
  fillToGap: number;
}

/** Rounding noise between two samples of one colour, per 0-255 channel. */
const CHANNEL_TOLERANCE = 2;

/** Compares channels, not luminance, so two hues of equal lightness still differ. */
function expectSameColour(actual: Srgb, expected: Srgb, message: string): void {
  const distance = Math.max(
    Math.abs(actual.r - expected.r),
    Math.abs(actual.g - expected.g),
    Math.abs(actual.b - expected.b),
  );
  expect(
    distance,
    `${message} ${JSON.stringify({ actual, expected })}`,
  ).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
}

/**
 * Samples the screenshot, not computed styles, along the vertical middle of the control's
 * left edge. Each column is chosen to land on a whole pixel inside its band for any
 * fractional box position, given the token offset and width of 2px or more.
 */
export async function focusRingPixels(
  page: Page,
  control: Locator,
): Promise<FocusRingPixels> {
  const box = await control.boundingBox();
  if (!box) throw new Error('focus ring pixels: the control is not rendered');
  const { offset, width } = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      offset: Number.parseFloat(
        style.getPropertyValue('--trinity-focus-ring-offset'),
      ),
      width: Number.parseFloat(
        style.getPropertyValue('--trinity-focus-ring-width'),
      ),
    };
  });
  const ring = Math.ceil(box.x - offset - width);
  const columns = {
    surface: ring - 4,
    ring,
    gap: Math.ceil(box.x - offset),
    fill: Math.floor(box.x) + 4,
  };
  const y = Math.floor(box.y + box.height / 2);
  // Helm's `transition-all` would otherwise catch the ring mid-fade. The columns are CSS
  // pixels, so the image must be too on a high-density display.
  const png = await page.screenshot({
    animations: 'disabled',
    scale: 'css',
    clip: {
      x: columns.surface,
      y,
      width: columns.fill - columns.surface + 1,
      height: 1,
    },
  });
  const row = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('focus ring pixels: no canvas context');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, 1).data;
    return Array.from({ length: image.width }, (_, index) => ({
      r: data[index * 4],
      g: data[index * 4 + 1],
      b: data[index * 4 + 2],
    }));
  }, png.toString('base64'));
  const at = (column: number): Srgb => row[column - columns.surface];
  return {
    surface: at(columns.surface),
    ring: at(columns.ring),
    gap: at(columns.gap),
    fill: at(columns.fill),
  };
}

/**
 * A focused control whose fill shares the ring's colour must show the ring apart from it: a
 * transparent gap that shows the surface behind the control, then the ring, at 3:1 or more
 * against both.
 */
export async function expectSeparatedFocusRing(
  page: Page,
  control: Locator,
  ringColour: Srgb,
): Promise<SeparatedRingRatios> {
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await control.focus();
  await expect(control).toBeFocused();
  const pixels = await focusRingPixels(page, control);
  await control.evaluate((element: HTMLElement) => element.blur());

  const ratios = {
    ringToGap: contrastRatio(pixels.ring, pixels.gap),
    ringToSurface: contrastRatio(pixels.ring, pixels.surface),
    gapToSurface: contrastRatio(pixels.gap, pixels.surface),
    fillToGap: contrastRatio(pixels.fill, pixels.gap),
  };
  expectSameColour(pixels.ring, ringColour, 'painted ring');
  expectSameColour(pixels.gap, pixels.surface, 'gap shows the surface');
  expect(ratios.ringToGap).toBeGreaterThanOrEqual(3);
  expect(ratios.ringToSurface).toBeGreaterThanOrEqual(3);
  return ratios;
}
