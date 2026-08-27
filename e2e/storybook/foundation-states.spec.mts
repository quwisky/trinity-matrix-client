import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  contrastRatio,
  resolveTokenSrgb,
  type Srgb,
} from '../playwright/support/contrast.mts';

const PALETTES = ['trinity', 'amethyst', 'onyx'] as const;
const MODES = ['light', 'dark'] as const;
const TOOLBAR_STORY = 'components-message-toolbar--all-actions';

const globals = (
  palette: (typeof PALETTES)[number],
  mode: (typeof MODES)[number],
  density: 'cosy' | 'compact' = 'cosy',
): string =>
  encodeURIComponent(`mode:${mode};palette:${palette};density:${density}`);

async function openStory(
  page: Page,
  id: string,
  palette: (typeof PALETTES)[number] = 'trinity',
  mode: (typeof MODES)[number] = 'dark',
  density: 'cosy' | 'compact' = 'cosy',
): Promise<void> {
  await page.goto(
    `/iframe.html?id=${id}&viewMode=story&globals=${globals(palette, mode, density)}`,
  );
}

async function computedColour(
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

test.describe('semantic design foundations', () => {
  for (const palette of PALETTES) {
    for (const mode of MODES) {
      test(`${palette} ${mode} toolbar states use accessible semantic recipes`, async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openStory(page, TOOLBAR_STORY, palette, mode);
        const toolbar = page.getByRole('toolbar', { name: 'Message actions' });
        const action = page.getByRole('button', { name: 'Add reaction' });
        await expect(toolbar).toBeVisible();
        await action.evaluate((element) =>
          element.setAttribute('data-testid', 'foundation-action'),
        );

        const floating = await resolveTokenSrgb(
          page,
          'foundation-action',
          '--trinity-surface-floating',
        );
        expect(await computedColour(toolbar, 'background-color')).toEqual(
          floating,
        );

        await action.hover();
        await expect
          .poll(() => computedColour(action, 'background-color'))
          .toEqual(
            await resolveTokenSrgb(
              page,
              'foundation-action',
              '--trinity-state-hover-surface',
            ),
          );

        await page.mouse.down();
        await expect
          .poll(() => computedColour(action, 'background-color'))
          .toEqual(
            await resolveTokenSrgb(
              page,
              'foundation-action',
              '--trinity-state-pressed-surface',
            ),
          );
        await page.mouse.up();

        // Pressing the reaction action activates it, so close that picker and restart the
        // tab sequence from the document. This verifies keyboard focus, not mouse focus.
        await page.keyboard.press('Escape');
        await action.evaluate((element: HTMLElement) => element.blur());
        await page.mouse.move(0, 0);
        // Establish keyboard modality, then target the representative control. Storybook's
        // preview inserts its own first tabbable before the story canvas.
        await page.keyboard.press('Tab');
        await action.focus();
        await expect(action).toBeFocused();
        expect(
          await action.evaluate((element) => element.matches(':focus-visible')),
        ).toBe(true);
        const focus = await computedColour(action, 'outline-color');
        expect(focus).toEqual(
          await resolveTokenSrgb(
            page,
            'foundation-action',
            '--trinity-focus-ring',
          ),
        );
        expect(contrastRatio(focus, floating)).toBeGreaterThanOrEqual(3);

        await openStory(page, 'components-banner--accent', palette, mode);
        const banner = page.locator('[data-tone="accent"]');
        const bannerAction = page.getByRole('button', { name: 'Set up' });
        await bannerAction.evaluate((element) =>
          element.setAttribute('data-testid', 'attention-action'),
        );
        await bannerAction.focus();
        await expect(bannerAction).toBeFocused();
        const attentionRing = await computedColour(
          bannerAction,
          'outline-color',
        );
        const attentionSurface = await computedColour(
          banner,
          'background-color',
        );
        expect(attentionRing).toEqual(
          await resolveTokenSrgb(
            page,
            'attention-action',
            '--trinity-focus-ring-on-attention',
          ),
        );
        expect(
          contrastRatio(attentionRing, attentionSurface),
        ).toBeGreaterThanOrEqual(3);
      });
    }
  }

  test('compact density reduces precise-pointer chrome without changing semantics', async ({
    page,
  }) => {
    await openStory(page, TOOLBAR_STORY, 'trinity', 'dark', 'cosy');
    const action = page.getByRole('button', { name: 'Add reaction' });
    const cosy = await action.boundingBox();
    expect(cosy).not.toBeNull();

    await openStory(page, TOOLBAR_STORY, 'trinity', 'dark', 'compact');
    const compactAction = page.getByRole('button', { name: 'Add reaction' });
    const compact = await compactAction.boundingBox();
    expect(compact).not.toBeNull();
    expect(compact!.width).toBeLessThan(cosy!.width);
    expect(compact!.height).toBeLessThan(cosy!.height);
    await expect(compactAction).toHaveAccessibleName('Add reaction');
  });

  test('disabled controls retain native semantics and the shared disabled treatment', async ({
    page,
  }) => {
    await openStory(page, 'components-banner--disabled-action');
    const action = page.getByRole('button', { name: 'Retry now' });
    await expect(action).toBeDisabled();
    const opacity = await action.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).opacity),
    );
    const token = await action.evaluate((element) =>
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue(
          '--trinity-disabled-opacity',
        ),
      ),
    );
    expect(opacity).toBe(token);
  });

  test('failed file interactions retain an error-aware surface', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStory(page, 'components-media-bubble--error');
    const file = page.getByRole('button', {
      name: /modern-interface-review\.pdf/i,
    });
    await file.evaluate((element) =>
      element.setAttribute('data-testid', 'error-file'),
    );
    const initial = await computedColour(file, 'background-color');
    await file.hover();
    await expect
      .poll(() => computedColour(file, 'background-color'))
      .not.toEqual(initial);
    const hovered = await computedColour(file, 'background-color');
    const neutralHover = await resolveTokenSrgb(
      page,
      'error-file',
      '--trinity-state-hover-surface',
    );
    expect(hovered).not.toEqual(initial);
    expect(hovered).not.toEqual(neutralHover);
  });

  for (const [story, label] of [
    ['components-input--default', 'Room name'],
    ['components-textarea--default', 'Room topic'],
  ] as const) {
    test(`${label} wrapper renders one owned focus indicator`, async ({
      page,
    }) => {
      await openStory(page, story);
      const field = page.getByRole('textbox', { name: label });
      await field.focus();
      await expect(field).toBeFocused();
      const focus = await field.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          outlineStyle: style.outlineStyle,
          boxShadow: style.boxShadow,
        };
      });
      expect(focus.outlineStyle).toBe('none');
      expect(focus.boxShadow).not.toBe('none');
    });
  }

  test('reduced motion collapses state transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStory(page, TOOLBAR_STORY);
    const action = page.getByRole('button', { name: 'Add reaction' });
    const durations = await action.evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(',')
        .map((value) => Number.parseFloat(value)),
    );
    expect(durations.every((duration) => duration <= 0.00001)).toBe(true);
  });
});
