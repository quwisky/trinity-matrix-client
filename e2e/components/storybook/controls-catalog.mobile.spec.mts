import { expect, test } from '@playwright/test';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  storybookThemeGlobals,
} from './theme-preview.mts';

const CATALOG_STORY =
  '/iframe.html?id=components-control-recipe-matrix--complete-catalog&viewMode=story';

test('Controls catalog keeps compact coarse-pointer targets operable', async ({
  page,
}) => {
  await page.goto(
    `${CATALOG_STORY}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW, 'compact')}`,
  );
  await expect(page.getByTestId('complete-controls-catalog')).toBeVisible();
  expect(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
  ).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  for (const control of await page.locator('[data-catalog-touch]').all()) {
    const bounds = await control.boundingBox();
    const label = (await control.getAttribute('data-testid')) ?? 'control';
    expect(bounds).not.toBeNull();
    expect(bounds!.height, label).toBeGreaterThanOrEqual(44);
    expect(bounds!.width, label).toBeGreaterThanOrEqual(44);
  }

  const unavailable = page.getByTestId('catalog-button-readonly');
  await unavailable.tap({ force: true });
  await expect(page.getByTestId('action-unavailable-feedback')).toHaveText(
    'Only room owners can archive this room.',
  );
});
