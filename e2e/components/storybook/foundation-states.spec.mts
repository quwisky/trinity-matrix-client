import { expect, test, type Locator } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  contrastRatio,
  measureLocatorContrast,
  resolveTokenSrgb,
  type Srgb,
} from '../../browser/support/contrast.mts';
import { disabledContrast } from './catalog-accessibility.mts';
import { expectSeparatedFocusRing } from './focus-ring-pixels.mts';
import { boxShadowLayers, computedColour } from './recipe-appearance.mts';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  openStory,
  STORYBOOK_THEME_PREVIEWS,
} from './theme-preview.mts';

const TOOLBAR_STORY = 'components-message-toolbar--all-actions';

/**
 * The focus ring an element actually paints, not a property that happens to hold a colour.
 * Helm controls keep `outline-none`, so the global outline's colour is computed but never
 * drawn; their ring is a box-shadow. An outline counts only when its style is not `none` and
 * it is at least 2px wide. A shadow ring counts only when it is opaque, in the expected
 * colour, and spreads at least 2px. Returns the painted colour.
 */
async function expectPaintedRing(
  element: Locator,
  expected: Srgb,
): Promise<Srgb> {
  const outline = await element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
  if (outline.style !== 'none') {
    expect(outline.width).toBeGreaterThanOrEqual(2);
    const colour = await computedColour(element, 'outline-color');
    expect(colour).toEqual(expected);
    return colour;
  }
  const rings = (await boxShadowLayers(element)).filter(
    (layer) => layer.alpha === 255 && layer.spread >= 2,
  );
  expect(rings.map((layer) => layer.colour)).toContainEqual(expected);
  return expected;
}

test.describe('semantic design foundations', () => {
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

  test('spacious density loosens message toolbar spacing without shrinking its actions', async ({
    page,
  }) => {
    const { theme, mode } = DEFAULT_STORYBOOK_THEME_PREVIEW;
    const measure = async (density: 'cosy' | 'spacious') => {
      await openStory(page, TOOLBAR_STORY, theme.id, mode.id, density);
      const action = page.getByRole('button', { name: 'Add reaction' });
      await expect(action).toHaveAccessibleName('Add reaction');
      const toolbar = page.getByRole('toolbar', { name: 'Message actions' });
      return {
        action: await action.boundingBox(),
        gap: await toolbar.evaluate((node) =>
          getComputedStyle(node)
            .getPropertyValue('--trinity-density-item-gap')
            .trim(),
        ),
      };
    };
    const cosy = await measure('cosy');
    const spacious = await measure('spacious');

    // The action glyph box is clamped (24-25px) by design; the density shows in the item gap.
    expect(spacious.action!.width).toBeGreaterThanOrEqual(cosy.action!.width);
    expect(spacious.action!.height).toBeGreaterThanOrEqual(cosy.action!.height);
    expect([cosy.gap, spacious.gap]).toEqual(['4px', '6px']);
  });

  test('a disabled solid button keeps native semantics and draws the disabled roles', async ({
    page,
  }) => {
    await openStory(page, 'components-banner--disabled-action');
    const action = page.getByTestId('banner-disabled-action');
    await expect(action).toBeDisabled();
    const opacity = await action.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).opacity),
    );
    expect(opacity).toBe(1);
    for (const [property, token] of [
      ['background-color', '--trinity-disabled-surface'],
      ['color', '--trinity-disabled-foreground'],
      ['border-top-color', '--trinity-disabled-border'],
    ] as const) {
      expect(await computedColour(action, property), property).toEqual(
        await resolveTokenSrgb(page, 'banner-disabled-action', token),
      );
    }
    const { text, background } = await measureLocatorContrast(action);
    expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  test('an unavailable solid button keeps the disabled roles on hover and its focus ring', async ({
    page,
  }) => {
    await openStory(page, 'components-control-recipe-matrix--complete-catalog');
    const testId = 'catalog-button-unavailable';
    const action = page.getByTestId(testId);
    await expect(action).toHaveAttribute('aria-disabled', 'true');
    const disabledSurface = await resolveTokenSrgb(
      page,
      testId,
      '--trinity-disabled-surface',
    );

    await action.hover();
    expect(await computedColour(action, 'background-color')).toEqual(
      disabledSurface,
    );
    expect(
      await action.evaluate((element) => getComputedStyle(element).opacity),
    ).toBe('1');

    // A solid primary button's focus ring stands apart from its edge, so the disabled border
    // must not replace it.
    await expectSeparatedFocusRing(
      page,
      action,
      await resolveTokenSrgb(page, testId, '--trinity-focus-ring'),
    );

    // Its fill is clipped to the padding box, so the border keeps its colour while focused:
    // a transparent one would shrink the fill by a pixel.
    await action.focus();
    await expect(action).toBeFocused();
    expect(
      await action.evaluate((element) => element.matches(':focus-visible')),
    ).toBe(true);
    expect(await computedColour(action, 'border-top-color')).toEqual(
      await resolveTokenSrgb(page, testId, '--trinity-disabled-border'),
    );
  });

  test('a disabled solid secondary or outline button keeps the shared fade', async ({
    page,
  }) => {
    await openStory(page, 'components-control-recipe-matrix--complete-catalog');
    for (const testId of [
      'catalog-button-disabled',
      'catalog-button-readonly',
    ]) {
      const [opacity, token] = await page
        .getByTestId(testId)
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            Number.parseFloat(style.opacity),
            Number.parseFloat(
              style.getPropertyValue('--trinity-disabled-opacity'),
            ),
          ];
        });
      expect(opacity, testId).toBe(token);
    }
  });

  for (const { theme, mode } of STORYBOOK_THEME_PREVIEWS) {
    test(`${theme.id} ${mode.id} failed file metadata stays readable on its error surface`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openStory(
        page,
        'components-media-bubble--error',
        theme.id,
        mode.id,
      );
      const file = page.getByRole('button', {
        name: /modern-interface-review\.pdf/i,
      });
      const metadata = file.locator('.media__sub');
      await file.evaluate((element) =>
        element.setAttribute('data-testid', 'error-file'),
      );
      expect(
        await disabledContrast(page, metadata, file),
        'resting metadata',
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

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
      expect(
        await disabledContrast(page, metadata, file),
        'hovered metadata',
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

      await page.mouse.down();
      expect(
        await disabledContrast(page, metadata, file),
        'pressed metadata',
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      await page.mouse.up();
    });
  }

  for (const { theme, mode } of STORYBOOK_THEME_PREVIEWS) {
    test(`${theme.id} ${mode.id} tabs keep the selected, hover and focus states readable`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openStory(page, 'components-tabs--default', theme.id, mode.id);
      const selected = page.getByRole('tab', { name: 'Emoji' });
      const resting = page.getByRole('tab', { name: 'Stickers' });
      await expect(selected).toHaveAttribute('aria-selected', 'true');
      await selected.evaluate((element) =>
        element.setAttribute('data-testid', 'selected-tab'),
      );

      expect(await computedColour(selected, 'background-color')).toEqual(
        await resolveTokenSrgb(
          page,
          'selected-tab',
          '--trinity-state-selected-surface',
        ),
      );
      const ratios: Record<string, number> = {
        selected: (await measureLocatorContrast(selected)).ratio,
        resting: (await measureLocatorContrast(resting)).ratio,
      };

      await resting.hover();
      await expect
        .poll(() => computedColour(resting, 'background-color'))
        .toEqual(
          await resolveTokenSrgb(
            page,
            'selected-tab',
            '--trinity-state-hover-surface',
          ),
        );
      ratios.hover = (await measureLocatorContrast(resting)).ratio;

      // Hovering the selected tab keeps its pill.
      const pill = await resolveTokenSrgb(
        page,
        'selected-tab',
        '--trinity-state-selected-surface',
      );
      await selected.hover();
      await expect
        .poll(() => computedColour(selected, 'background-color'))
        .toEqual(pill);
      ratios.selectedHover = (await measureLocatorContrast(selected)).ratio;
      await page.mouse.move(0, 0);

      const surface = await resolveTokenSrgb(
        page,
        'selected-tab',
        '--trinity-surface-overlay',
      );
      const focusRing = await resolveTokenSrgb(
        page,
        'selected-tab',
        '--trinity-focus-ring',
      );
      // Keyboard modality first, so the tab matches :focus-visible.
      await page.keyboard.press('Tab');
      await selected.focus();
      await expect(selected).toBeFocused();
      const selectedRing = await expectPaintedRing(selected, focusRing);
      ratios.selectedRingOnPill = contrastRatio(selectedRing, pill);
      ratios.selectedRingOnSurface = contrastRatio(selectedRing, surface);

      // Manual activation: focus moves to a tab that stays unselected.
      await openStory(page, 'components-tabs--manual', theme.id, mode.id);
      await page.keyboard.press('Tab');
      await page.getByRole('tab', { name: 'Emoji' }).focus();
      await page.keyboard.press('ArrowLeft');
      const focused = page.getByRole('tab', { name: 'Stickers' });
      await expect(focused).toBeFocused();
      await expect(focused).toHaveAttribute('aria-selected', 'false');
      ratios.focusRing = contrastRatio(
        await expectPaintedRing(focused, focusRing),
        surface,
      );

      await openStory(page, 'components-tabs--disabled-tab', theme.id, mode.id);
      const disabled = page.getByRole('tab', { name: 'Stickers' });
      await expect(disabled).toBeDisabled();
      const [opacity, token] = await disabled.evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          Number.parseFloat(style.opacity),
          Number.parseFloat(
            style.getPropertyValue('--trinity-disabled-opacity'),
          ),
        ];
      });
      expect(opacity, 'disabled tab fades').toBe(token);

      expect(ratios.selected, 'selected label on pill').toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
      expect(ratios.resting, 'resting label').toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
      expect(ratios.hover, 'hovered label').toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
      expect(
        ratios.selectedHover,
        'hovered selected label',
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(ratios.focusRing, 'focus ring').toBeGreaterThanOrEqual(3);
      expect(
        ratios.selectedRingOnPill,
        'selected ring on pill',
      ).toBeGreaterThanOrEqual(3);
      expect(
        ratios.selectedRingOnSurface,
        'selected ring on surface',
      ).toBeGreaterThanOrEqual(3);
      test.info().annotations.push({
        type: 'contrast',
        description: `${theme.id} ${mode.id} tabs ${JSON.stringify(ratios)}`,
      });
    });
  }

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
