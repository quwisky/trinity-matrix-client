import { expect, test } from '@playwright/test';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  storybookThemeGlobals,
} from './theme-preview.mts';

const NAVIGATION_CATALOG =
  '/iframe.html?id=components-navigation-and-layout-recipe-matrix--complete-catalog&viewMode=story';
const OVERLAY_CATALOG =
  '/iframe.html?id=components-overlay-recipes--complete-catalog&viewMode=story';

test('Navigation catalog remains operable without clipping on a real mobile profile', async ({
  page,
}) => {
  await page.goto(
    `${NAVIGATION_CATALOG}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW, 'compact')}`,
  );
  await expect(
    page.getByTestId('complete-navigation-layout-catalog'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));

  const tabs = page.getByTestId('catalog-tabs-neutral-pill');
  const members = tabs.getByRole('tab', { name: 'Members' });
  await members.tap();
  await expect(members).toHaveAttribute('aria-selected', 'true');
});

test('Overlay catalog keeps portal and structural surfaces inside the mobile viewport', async ({
  page,
}) => {
  await page.goto(
    `${OVERLAY_CATALOG}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW, 'compact')}`,
  );
  await expect(page.getByTestId('complete-overlay-catalog')).toBeVisible();
  await page.getByTestId('anchored-overlay-trigger').scrollIntoViewIfNeeded();
  const portal = page.getByTestId('portal-overlay-surface');
  await expect(portal).toBeVisible();
  const bounds = await portal.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);

  await page.getByTestId('sheet-canonical').tap();
  const sheet = page.getByTestId('action-sheet-surface');
  await expect(sheet).toBeVisible();
  const sheetBounds = await sheet.boundingBox();
  expect(sheetBounds).not.toBeNull();
  expect(sheetBounds!.x).toBeCloseTo(0, 1);
  expect(sheetBounds!.width).toBeCloseTo(viewport!.width, 1);
  for (const control of [
    page.getByTestId('sheet-react-👍'),
    page.getByTestId('sheet-danger'),
  ]) {
    const controlBounds = await control.boundingBox();
    expect(controlBounds).not.toBeNull();
    expect(controlBounds!.height).toBeGreaterThanOrEqual(44);
    expect(controlBounds!.width).toBeGreaterThanOrEqual(44);
  }
});
