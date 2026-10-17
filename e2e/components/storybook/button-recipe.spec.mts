import { expect, test, type Locator } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  measureContrast,
  resolveTokenSrgb,
} from '../../browser/support/contrast.mts';
import {
  STORYBOOK_THEME_PREVIEWS,
  expectStorybookThemeRoot,
  storybookThemeGlobals,
} from './theme-preview.mts';
import { expectSeparatedFocusRing } from './focus-ring-pixels.mts';

const STORY =
  '/iframe.html?id=components-button--canonical-states&viewMode=story';
const FOCUS_STORY =
  '/iframe.html?id=components-button--solid-primary-focus&viewMode=story';

const recipeStyle = (control: Locator) =>
  control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      color: style.color,
      height: style.height,
      paddingBlock: style.paddingBlock,
      paddingInline: style.paddingInline,
      width: style.width,
    };
  });

test('canonical button recipes preserve independent semantic axes', async ({
  page,
}) => {
  await page.goto(STORY);

  const canonicalPrimary = page.getByTestId('canonical-primary');
  const canonicalDanger = page.getByTestId('canonical-danger');
  const canonicalIcon = page.getByTestId('canonical-icon');
  await expect(canonicalPrimary).toBeVisible();
  await expect(canonicalDanger).toBeVisible();
  await expect(canonicalIcon).toBeVisible();

  expect(await recipeStyle(canonicalDanger)).not.toEqual(
    await recipeStyle(canonicalPrimary),
  );
  expect(
    (await recipeStyle(page.getByTestId('canonical-danger-ghost'))).color,
  ).not.toBe(
    (await recipeStyle(page.getByTestId('canonical-primary-ghost'))).color,
  );
  await expect(canonicalIcon).toHaveAttribute('data-trn-icon-button', '');
});

for (const preview of STORYBOOK_THEME_PREVIEWS.filter(
  ({ mode }) => mode.id === 'light',
)) {
  test(`${preview.theme.id} light danger hover is opaque on card and rail surfaces`, async ({
    page,
  }) => {
    await page.goto(`${STORY}&globals=${storybookThemeGlobals(preview)}`);
    await expectStorybookThemeRoot(page, preview);

    for (const testId of ['danger-ghost-card', 'danger-ghost-rail']) {
      const button = page.getByTestId(testId);
      await expect(button).toBeVisible();
      await button.hover();

      const tint = await resolveTokenSrgb(
        page,
        testId,
        '--trinity-danger-tint-10',
      );
      await expect
        .poll(async () => (await measureContrast(page, testId)).background)
        .toEqual(tint);

      const measured = await measureContrast(page, testId);
      expect(measured.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
}

for (const preview of STORYBOOK_THEME_PREVIEWS.filter(
  ({ mode }) => mode.id === 'dark',
)) {
  test(`${preview.theme.id} dark secondary hover keeps its semantic surface`, async ({
    page,
  }) => {
    await page.goto(`${STORY}&globals=${storybookThemeGlobals(preview)}`);
    await expectStorybookThemeRoot(page, preview);

    const testId = 'canonical-secondary-ghost';
    const button = page.getByTestId(testId);
    await expect(button).toBeVisible();
    await button.hover();

    const secondary = await resolveTokenSrgb(page, testId, '--secondary');
    await expect
      .poll(async () => (await measureContrast(page, testId)).background)
      .toEqual(secondary);
  });
}

for (const preview of STORYBOOK_THEME_PREVIEWS) {
  test(`${preview.theme.id} ${preview.mode.id} solid primary focus ring stands apart from its fill on every surface`, async ({
    page,
  }) => {
    await page.goto(`${FOCUS_STORY}&globals=${storybookThemeGlobals(preview)}`);
    await expectStorybookThemeRoot(page, preview);

    for (const surface of ['canvas', 'card', 'rail']) {
      const testId = `focus-primary-${surface}`;
      const button = page.getByTestId(testId);
      await expect(button).toBeVisible();
      const ratios = await expectSeparatedFocusRing(
        page,
        button,
        await resolveTokenSrgb(page, testId, '--trinity-focus-ring'),
      );
      test.info().annotations.push({
        type: 'contrast',
        description: `${preview.theme.id} ${preview.mode.id} ${surface} ${JSON.stringify(ratios)}`,
      });
    }
  });
}

test.describe('on a high-density display', () => {
  test.use({ deviceScaleFactor: 2 });

  test('solid primary focus ring is sampled in CSS pixels', async ({
    page,
  }) => {
    await page.goto(FOCUS_STORY);
    for (const surface of ['canvas', 'card']) {
      const testId = `focus-primary-${surface}`;
      await expectSeparatedFocusRing(
        page,
        page.getByTestId(testId),
        await resolveTokenSrgb(page, testId, '--trinity-focus-ring'),
      );
    }
  });
});

test('a focused solid primary keeps a visible outline under forced colours', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(FOCUS_STORY);
  const button = page.getByTestId('focus-primary-canvas');
  await page.keyboard.press('Tab');
  await button.focus();
  await expect(button).toBeFocused();
  const outline = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
});
