import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  contrastRatio,
  measureLocatorContrast,
  resolveTokenSrgb,
  type Srgb,
} from '../../browser/support/contrast.mts';
import { disabledContrast } from './catalog-accessibility.mts';
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
  density: 'cosy' | 'compact' | 'spacious' = 'cosy',
): string => storybookThemeGlobals({ theme, mode }, density);

async function openStory(
  page: Page,
  id: string,
  theme: ThemeId = DEFAULT_STORYBOOK_THEME_PREVIEW.theme.id,
  mode: ResolvedThemeMode = DEFAULT_STORYBOOK_THEME_PREVIEW.mode.id,
  density: 'cosy' | 'compact' | 'spacious' = 'cosy',
  args?: string,
): Promise<void> {
  await page.goto(
    `/iframe.html?id=${id}&viewMode=story&globals=${globals(theme, mode, density)}${args ? `&args=${args}` : ''}`,
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

/**
 * #1217: a solid action on an attention surface inverts, so its fill stands out from the
 * surface at rest and on hover, its label stays readable on both, and its focus ring sits
 * on a gap in the surface colour. Returns the resolved attention hover fill.
 */
async function expectAttentionAction(
  page: Page,
  surface: Locator,
  action: Locator,
): Promise<Srgb> {
  await action.evaluate((element) =>
    element.setAttribute('data-testid', 'attention-action'),
  );
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await resolveTokenSrgb(
      page,
      'attention-action',
      '--trinity-state-attention-surface',
    ),
  );
  const restFill = await computedColour(action, 'background-color');
  expect(restFill).toEqual(
    await resolveTokenSrgb(
      page,
      'attention-action',
      '--trinity-state-attention-action-surface',
    ),
  );
  expect(contrastRatio(restFill, attentionSurface)).toBeGreaterThanOrEqual(3);
  expect((await measureLocatorContrast(action)).ratio).toBeGreaterThanOrEqual(
    AA_NORMAL_TEXT,
  );

  await action.hover();
  const hoverSurface = await resolveTokenSrgb(
    page,
    'attention-action',
    '--trinity-state-attention-action-hover-surface',
  );
  await expect
    .poll(() => computedColour(action, 'background-color'))
    .toEqual(hoverSurface);
  expect(hoverSurface).not.toEqual(restFill);
  expect(contrastRatio(hoverSurface, attentionSurface)).toBeGreaterThanOrEqual(
    3,
  );
  expect((await measureLocatorContrast(action)).ratio).toBeGreaterThanOrEqual(
    AA_NORMAL_TEXT,
  );
  await page.mouse.move(0, 0);

  await action.focus();
  await expect(action).toBeFocused();
  const attentionRing = await computedColour(action, 'outline-color');
  expect(attentionRing).toEqual(
    await resolveTokenSrgb(
      page,
      'attention-action',
      '--trinity-focus-ring-on-attention',
    ),
  );
  expect(contrastRatio(attentionRing, attentionSurface)).toBeGreaterThanOrEqual(
    3,
  );
  // The ring shares the inverted fill's colour, so a gap in the surface colour is what
  // keeps it distinct from the button.
  const ringOffset = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      colour: style.getPropertyValue('--tw-ring-offset-color').trim(),
      width: style.getPropertyValue('--tw-ring-offset-width').trim(),
    };
  });
  expect(ringOffset.width).not.toMatch(/^0(px)?$/);
  expect(ringOffset.colour).not.toBe('');
  await action.evaluate((element: HTMLElement) => element.blur());
  return hoverSurface;
}

/**
 * #1224: every focusable on an attention surface sits on the accent, so the surface switches
 * them all to the on-attention ring. A text field (transparent, so its own background is the
 * accent) and a ghost action both use it, at 3:1 or more against the surface.
 */
async function expectAttentionSurfaceRing(
  page: Page,
  surface: Locator,
  focusables: readonly Locator[],
): Promise<void> {
  const attentionSurface = await computedColour(surface, 'background-color');
  for (const [index, focusable] of focusables.entries()) {
    const testId = `attention-focusable-${index}`;
    await focusable.evaluate(
      (element, id) => element.setAttribute('data-testid', id),
      testId,
    );
    await focusable.focus();
    await expect(focusable).toBeFocused();
    // Buttons draw the global outline; trnInput draws its ring as border and shadow.
    const ring = await focusable.evaluate((element) =>
      getComputedStyle(element).outlineStyle === 'none'
        ? 'border-top-color'
        : 'outline-color',
    );
    const ringColour = await computedColour(focusable, ring);
    expect(contrastRatio(ringColour, attentionSurface)).toBeGreaterThanOrEqual(
      3,
    );
    expect(ringColour).toEqual(
      await resolveTokenSrgb(page, testId, '--trinity-focus-ring-on-attention'),
    );
    await focusable.evaluate((element: HTMLElement) => element.blur());
  }
}

/**
 * Every visible colour in a computed `box-shadow` list, topmost first, flattened to sRGB.
 * Tailwind composes its ring and inset layers into every shadow utility as transparent
 * placeholders, so fully transparent layers are skipped.
 */
async function boxShadowColours(element: Locator): Promise<Srgb[]> {
  return element.evaluate((node) => {
    const shadow = getComputedStyle(node).boxShadow;
    const colours =
      shadow.match(/(?:rgba?|oklch|oklab|lab|lch|color)\([^)]*\)/gu) ?? [];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('foundation states: no canvas context');
    return colours.flatMap((colour) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return alpha === 0 ? [] : [{ r, g, b }];
    });
  });
}

/** Ratios measured by {@link expectAttentionControls}, for the evidence log. */
interface AttentionControlRatios {
  placeholder: number;
  border: number;
  fieldRing: number;
  trackBorder: number;
  selectedFill: number;
  segmentRing: number;
  selectPlaceholder: number;
  selectBorder: number;
  selectRing: number;
}

/**
 * #1241: form controls on an attention surface use the attention control roles. The field's
 * placeholder clears 4.5:1 and its resting border 3:1 against the surface; the segmented
 * track stays the surface colour, so the selected option's inverted fill and the on-attention
 * ring (drawn on a gap in the track colour) clear 3:1 against what is directly behind them;
 * the select trigger's placeholder, border and ring follow the field.
 */
async function expectAttentionControls(
  page: Page,
  surface: Locator,
  controls: { field: Locator; segmented: Locator; select: Locator },
): Promise<AttentionControlRatios> {
  const { field, segmented, select } = controls;
  // The field sits inside the surface, so it resolves the tokens the controls actually see.
  await field.evaluate((element) =>
    element.setAttribute('data-testid', 'attention-controls-field'),
  );
  const token = (name: string) =>
    resolveTokenSrgb(page, 'attention-controls-field', name);
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await token('--trinity-state-attention-surface'),
  );
  const controlBorder = await token('--trinity-state-attention-control-border');
  const placeholderToken = await token(
    '--trinity-state-attention-control-placeholder',
  );
  const onAttentionRing = await token('--trinity-focus-ring-on-attention');

  // Text field: placeholder, resting border and focus ring.
  const placeholder = await field.evaluate((element) => {
    const colour = getComputedStyle(element, '::placeholder').color;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('foundation states: no canvas context');
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  });
  expect(placeholder).toEqual(placeholderToken);
  const fieldBorder = await computedColour(field, 'border-top-color');
  expect(fieldBorder).toEqual(controlBorder);
  await field.focus();
  await expect(field).toBeFocused();
  const fieldRing = await computedColour(field, 'border-top-color');
  expect(fieldRing).toEqual(onAttentionRing);
  await field.evaluate((element: HTMLElement) => element.blur());

  // Segmented radio group: the track, the selected option and the ring on its gap.
  const track = segmented.getByRole('radiogroup');
  const trackSurface = await computedColour(track, 'background-color');
  expect(trackSurface).toEqual(
    await token('--trinity-state-attention-control-track-surface'),
  );
  const trackBorder = await computedColour(track, 'border-top-color');
  expect(trackBorder).toEqual(controlBorder);
  const selectedRadio = segmented.getByRole('radio', { checked: true });
  const selectedOption = segmented.locator('label[data-state="selected"]');
  const selectedFill = await computedColour(selectedOption, 'background-color');
  expect(selectedFill).toEqual(
    await token('--trinity-state-attention-action-surface'),
  );
  expect(
    (await measureLocatorContrast(selectedOption)).ratio,
  ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  for (const option of await segmented
    .locator('label[data-state="idle"]')
    .all()) {
    expect((await measureLocatorContrast(option)).ratio).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  }
  // Keyboard modality, so the native radio matches `:focus-visible`.
  await page.keyboard.press('Tab');
  await selectedRadio.focus();
  await expect(selectedRadio).toBeFocused();
  const [gap, segmentRing] = await boxShadowColours(selectedOption);
  expect(gap).toEqual(trackSurface);
  expect(segmentRing).toEqual(onAttentionRing);
  await selectedRadio.evaluate((element: HTMLElement) => element.blur());

  // Select trigger: transparent on the surface, with the attention placeholder and border.
  const trigger = select.getByRole('combobox');
  await trigger.evaluate((element) =>
    element.setAttribute('data-testid', 'attention-select-trigger'),
  );
  expect(await trigger.getAttribute('data-placeholder')).not.toBeNull();
  const selectPlaceholder = await computedColour(trigger, 'color');
  expect(selectPlaceholder).toEqual(placeholderToken);
  const selectContrast = await measureLocatorContrast(trigger);
  expect(selectContrast.background).toEqual(attentionSurface);
  const selectBorder = await computedColour(trigger, 'border-top-color');
  expect(selectBorder).toEqual(controlBorder);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  const selectRing = await computedColour(trigger, 'outline-color');
  expect(selectRing).toEqual(onAttentionRing);
  await trigger.evaluate((element: HTMLElement) => element.blur());

  const ratios = {
    placeholder: contrastRatio(placeholder, attentionSurface),
    border: contrastRatio(fieldBorder, attentionSurface),
    fieldRing: contrastRatio(fieldRing, attentionSurface),
    trackBorder: contrastRatio(trackBorder, attentionSurface),
    selectedFill: contrastRatio(selectedFill, trackSurface),
    segmentRing: contrastRatio(segmentRing, trackSurface),
    selectPlaceholder: contrastRatio(selectPlaceholder, attentionSurface),
    selectBorder: contrastRatio(selectBorder, attentionSurface),
    selectRing: contrastRatio(selectRing, attentionSurface),
  };
  for (const [name, ratio] of Object.entries(ratios)) {
    expect(ratio, name).toBeGreaterThanOrEqual(
      name.toLowerCase().includes('placeholder') ? AA_NORMAL_TEXT : 3,
    );
  }
  return ratios;
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
      const hoverSurface = await expectAttentionAction(
        page,
        page.locator('[data-variant="accent"]'),
        page.getByRole('button', { name: 'Set up' }),
      );

      // An anchor action needs its own hover rule: Helm's `[a]:hover` outranks the plain one.
      await openStory(
        page,
        'components-banner--accent-actions',
        theme.id,
        mode.id,
      );
      const linkAction = page.getByRole('link', { name: 'Learn more' });
      await linkAction.hover();
      await expect
        .poll(() => computedColour(linkAction, 'background-color'))
        .toEqual(hoverSurface);

      // #1224: the accent page header and accent overlay surface paint the same attention
      // surface, so a solid action in either inverts the same way. The toolbar layout's
      // own background loses to the accent, so it is checked as well.
      for (const layout of ['page', 'toolbar'] as const) {
        await openStory(
          page,
          'components-page-header--accent-action',
          theme.id,
          mode.id,
          'cosy',
          `layout:${layout}`,
        );
        const header = page.locator('header[data-trn-variant="accent"]');
        await expect(header).toHaveAttribute('data-trn-layout', layout);
        await expectAttentionAction(
          page,
          header,
          page.getByRole('button', { name: 'Verify' }),
        );
      }

      // #1241: form controls on the accent header, in both layouts, and the accent overlay.
      for (const layout of ['page', 'toolbar'] as const) {
        await openStory(
          page,
          'components-page-header--accent-controls',
          theme.id,
          mode.id,
          'cosy',
          `layout:${layout}`,
        );
        const header = page.locator('header[data-trn-variant="accent"]');
        await expect(header).toHaveAttribute('data-trn-layout', layout);
        const ratios = await expectAttentionControls(page, header, {
          field: page.getByRole('textbox', { name: 'Filter members' }),
          segmented: page.locator('trn-radio-group'),
          select: page.locator('trn-select'),
        });
        test.info().annotations.push({
          type: 'contrast',
          description: `${theme.id} ${mode.id} header ${layout} ${JSON.stringify(ratios)}`,
        });
      }

      await openStory(
        page,
        'components-overlay-recipes--accent-surface',
        theme.id,
        mode.id,
      );
      const overlayRatios = await expectAttentionControls(
        page,
        page.getByTestId('accent-overlay-surface'),
        {
          field: page.getByRole('textbox', { name: 'Recovery key' }),
          segmented: page.locator('trn-radio-group'),
          select: page.locator('trn-select'),
        },
      );
      test.info().annotations.push({
        type: 'contrast',
        description: `${theme.id} ${mode.id} overlay ${JSON.stringify(overlayRatios)}`,
      });
      await expectAttentionSurfaceRing(
        page,
        page.getByTestId('accent-overlay-surface'),
        [
          page.getByRole('textbox', { name: 'Recovery key' }),
          page.getByRole('button', { name: 'Not now' }),
        ],
      );
      await expectAttentionAction(
        page,
        page.getByTestId('accent-overlay-surface'),
        page.getByRole('button', { name: 'Verify now' }),
      );
      // The attention hover token is shared, so the banner step's `hoverSurface` applies here.
      const overlayLink = page.getByRole('link', { name: 'Learn more' });
      await overlayLink.hover();
      await expect
        .poll(() => computedColour(overlayLink, 'background-color'))
        .toEqual(hoverSurface);
      await page.mouse.move(0, 0);

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
