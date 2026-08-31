import { expect, test } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  measureContrast,
} from '../../browser/support/contrast.mts';

/**
 * The values exposed by `TRINITY_PALETTES` in the Storybook toolbar.
 *
 * Do not import `theme.service.ts` into this Node test merely for its constant: that module
 * also loads Angular and three Capacitor plugins. A palette addition must update this focused
 * browser matrix alongside the two CSS blocks and registry entry documented by the theme.
 */
const PALETTES = ['trinity', 'amethyst', 'onyx'] as const;
const MODES = ['light', 'dark'] as const;
const BODY_COPY = 'No pinned messages in this room.';

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

interface SurfaceMeasurement {
  readonly bodyBackground: Rgba;
  readonly tokenBackground: Rgba;
  readonly bodyForeground: Rgba;
  readonly tokenForeground: Rgba;
  readonly bodyHeight: number;
  readonly viewportHeight: number;
}

test.describe('Storybook preview theme surface', () => {
  for (const palette of PALETTES) {
    for (const mode of MODES) {
      test(`${palette} ${mode} paints an accessible full-canvas surface`, async ({
        page,
      }) => {
        const globals = encodeURIComponent(`mode:${mode};palette:${palette}`);
        await page.goto(
          `/iframe.html?id=components-empty-state--body-only&viewMode=story&globals=${globals}`,
        );

        const copy = page.getByText(BODY_COPY, { exact: true });
        await expect(copy).toBeVisible();

        const rootState = await page.locator('html').evaluate((root) => ({
          dark: root.classList.contains('dark'),
          palette: root.getAttribute('data-theme'),
        }));
        expect(rootState).toEqual({
          dark: mode === 'dark',
          palette: palette === 'trinity' ? null : palette,
        });

        const surface = await page.evaluate((): SurfaceMeasurement => {
          const rgba = (colour: string): Rgba => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', {
              willReadFrequently: true,
            });
            if (!context) {
              throw new Error('theme surface: no 2d canvas context');
            }
            const sentinel = '#010203';
            context.fillStyle = sentinel;
            context.fillStyle = colour;
            if (context.fillStyle === sentinel && colour.trim() !== sentinel) {
              throw new Error(
                `theme surface: browser rejected the colour "${colour}"`,
              );
            }
            context.clearRect(0, 0, 1, 1);
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return { r, g, b, a };
          };

          // A DOM probe resolves aliases such as `--background: var(--trinity-chat)` before
          // canvas normalises the result. Comparing CSS strings would mistake hex and RGB
          // spellings of the same colour for different surfaces.
          const probe = document.createElement('div');
          probe.style.background = 'var(--background)';
          probe.style.color = 'var(--foreground)';
          document.body.append(probe);
          const bodyStyle = getComputedStyle(document.body);
          const probeStyle = getComputedStyle(probe);
          const result = {
            bodyBackground: rgba(bodyStyle.backgroundColor),
            tokenBackground: rgba(probeStyle.backgroundColor),
            bodyForeground: rgba(bodyStyle.color),
            tokenForeground: rgba(probeStyle.color),
            bodyHeight: document.body.getBoundingClientRect().height,
            viewportHeight: innerHeight,
          };
          probe.remove();
          return result;
        });

        expect(surface.bodyBackground.a).toBe(255);
        expect(surface.bodyBackground).toEqual(surface.tokenBackground);
        expect(surface.bodyForeground).toEqual(surface.tokenForeground);
        expect(surface.bodyHeight).toBeGreaterThanOrEqual(
          surface.viewportHeight,
        );

        // The issue was discovered as 2.2:1 muted copy on the browser's white fallback.
        // Measure the rendered component, not only the tokens, so that failure cannot return.
        await copy.evaluate((element) => {
          element.setAttribute('data-testid', 'storybook-body-copy');
        });
        const contrast = await measureContrast(page, 'storybook-body-copy');
        expect(contrast.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }
});
