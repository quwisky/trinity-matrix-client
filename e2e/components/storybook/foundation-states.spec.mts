import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  contrastRatio,
  resolveTokenSrgb,
  type Srgb,
} from '../../browser/support/contrast.mts';
import {
  type ResolvedThemeMode,
  type ThemeId,
} from '@trinity/theme-foundation';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  STORYBOOK_THEME_PREVIEWS,
  storybookThemeGlobals,
} from './theme-preview.mts';

const TOOLBAR_STORY = 'components-message-toolbar--all-actions';
const globals = (
  theme: ThemeId,
  mode: ResolvedThemeMode,
  density: 'cosy' | 'compact' = 'cosy',
): string => storybookThemeGlobals({ theme, mode }, density);

async function openStory(
  page: Page,
  id: string,
  theme: ThemeId = DEFAULT_STORYBOOK_THEME_PREVIEW.theme.id,
  mode: ResolvedThemeMode = DEFAULT_STORYBOOK_THEME_PREVIEW.mode.id,
  density: 'cosy' | 'compact' = 'cosy',
): Promise<void> {
  await page.goto(
    `/iframe.html?id=${id}&viewMode=story&globals=${globals(theme, mode, density)}`,
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
  for (const { theme, mode } of STORYBOOK_THEME_PREVIEWS) {
    test(`${theme.id} ${mode.id} toolbar states use accessible semantic recipes`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openStory(page, TOOLBAR_STORY, theme.id, mode.id);
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

      await openStory(page, 'components-banner--accent', theme.id, mode.id);
      const banner = page.locator('[data-variant="accent"]');
      const bannerAction = page.getByRole('button', { name: 'Set up' });
      await bannerAction.evaluate((element) =>
        element.setAttribute('data-testid', 'attention-action'),
      );
      await bannerAction.focus();
      await expect(bannerAction).toBeFocused();
      const attentionRing = await computedColour(bannerAction, 'outline-color');
      const attentionSurface = await computedColour(banner, 'background-color');
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

      await openStory(page, 'components-input--default', theme.id, mode.id);
      const field = page.getByRole('textbox', { name: 'Room name' });
      await field.evaluate((element) => {
        element.setAttribute('data-testid', 'focus-field');
        const probe = document.createElement('span');
        probe.setAttribute('data-testid', 'focus-halo-probe');
        // Match Helm's `ring-ring/50` in the browser's own colour space, composited over
        // the Storybook canvas instead of comparing the opaque source token.
        probe.style.background =
          'color-mix(in oklab, var(--ring) 50%, var(--background))';
        document.body.append(probe);
      });
      await field.focus();
      await expect(field).toBeFocused();
      expect(
        await field.evaluate(
          (element) => getComputedStyle(element).outlineStyle,
        ),
      ).toBe('none');
      expect(
        await field.evaluate((element) => getComputedStyle(element).boxShadow),
      ).not.toBe('none');
      const halo = await computedColour(
        page.getByTestId('focus-halo-probe'),
        'background-color',
      );
      const fieldSurface = await resolveTokenSrgb(
        page,
        'focus-field',
        '--background',
      );
      expect(contrastRatio(halo, fieldSurface)).toBeGreaterThanOrEqual(3);
    });
  }

  test('compact density reduces precise-pointer chrome without changing semantics', async ({
    page,
  }) => {
    await openStory(
      page,
      TOOLBAR_STORY,
      DEFAULT_STORYBOOK_THEME_PREVIEW.theme.id,
      DEFAULT_STORYBOOK_THEME_PREVIEW.mode.id,
      'cosy',
    );
    const action = page.getByRole('button', { name: 'Add reaction' });
    const cosy = await action.boundingBox();
    expect(cosy).not.toBeNull();

    await openStory(
      page,
      TOOLBAR_STORY,
      DEFAULT_STORYBOOK_THEME_PREVIEW.theme.id,
      DEFAULT_STORYBOOK_THEME_PREVIEW.mode.id,
      'compact',
    );
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
    ['components-input--direct-helm-prompt', 'Prompt response'],
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
