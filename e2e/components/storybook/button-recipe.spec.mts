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

const STORY =
  '/iframe.html?id=components-button--canonical-states&viewMode=story';

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
