import { expect, test } from '@playwright/test';
import {
  DISABLED_READABILITY,
  disabledContrast,
  expectContrast,
  formatAxeResults,
  runAxe,
} from './catalog-accessibility.mts';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  STORYBOOK_THEME_PREVIEWS,
  expectStorybookThemeRoot,
  storybookThemeGlobals,
} from './theme-preview.mts';

const CATALOG_STORY =
  '/iframe.html?id=components-content-recipe-matrix--complete-catalog&viewMode=story';
for (const preview of STORYBOOK_THEME_PREVIEWS) {
  test(`${preview.theme.id} ${preview.mode.id} Foundations and Generic Content catalog is complete and accessible`, async ({
    page,
  }) => {
    await page.goto(
      `${CATALOG_STORY}&globals=${storybookThemeGlobals(preview)}`,
    );
    const catalog = page.getByTestId('complete-content-catalog');
    await expect(catalog).toBeVisible();
    await expectStorybookThemeRoot(page, preview);

    const tooltipTrigger = page.getByTestId('catalog-tooltip-top');
    await tooltipTrigger.focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();

    const scan = await runAxe(page);
    expect(formatAxeResults(scan.violations)).toEqual([]);
    expect(formatAxeResults(scan.incomplete)).toEqual([]);

    const canvas = page.locator('body');
    for (const icon of await page
      .locator('[data-testid^="catalog-icon-variant-"]')
      .all()) {
      await expectContrast(icon, 'color', canvas, 'backgroundColor', 4.5);
    }

    for (const badge of await page
      .locator('[data-testid^="catalog-badge-"]')
      .all()) {
      await expectContrast(badge, 'color', badge, 'backgroundColor', 4.5);
    }

    for (const banner of await page
      .locator('[data-testid^="catalog-banner-"] .banner')
      .all()) {
      await expectContrast(banner, 'color', banner, 'backgroundColor', 4.5);
    }

    const disabledBanner = page
      .getByTestId('catalog-banner-disabled')
      .locator('.banner');
    const disabledAction = disabledBanner.getByRole('button');
    expect(
      await disabledContrast(
        page,
        'catalog-banner-disabled-action',
        disabledBanner,
      ),
    ).toBeGreaterThanOrEqual(DISABLED_READABILITY);

    await expectContrast(
      page.getByTestId('catalog-empty-muted-line').locator('p').last(),
      'color',
      canvas,
      'backgroundColor',
      4.5,
    );
    await expectContrast(
      page.getByTestId('catalog-empty-danger-hero').locator('p').last(),
      'color',
      canvas,
      'backgroundColor',
      4.5,
    );

    for (const progress of await page
      .locator('[data-testid^="catalog-progress-"]')
      .all()) {
      const track = progress.locator('[role=progressbar]');
      const indicator = track.locator('[data-slot=progress-indicator]');
      await expectContrast(
        indicator,
        'backgroundColor',
        track,
        'backgroundColor',
        3,
      );
    }

    for (const spinner of await page
      .locator('[data-testid^="catalog-spinner-"] hlm-spinner')
      .all()) {
      await expectContrast(spinner, 'color', canvas, 'backgroundColor', 3);
    }

    await expectContrast(tooltip, 'color', tooltip, 'backgroundColor', 4.5);

    for (const avatarId of [
      'catalog-avatar-online',
      'catalog-avatar-unavailable',
      'catalog-avatar-offline',
    ]) {
      await expectContrast(
        page.getByTestId(avatarId).locator('.presence-dot'),
        'backgroundColor',
        canvas,
        'backgroundColor',
        3,
      );
    }

    const accountBadge = page
      .getByTestId('catalog-avatar-offline')
      .getByTestId('account-badge');
    // The hashed hue is decorative: identity is carried by this AA initial and
    // the accessible account name asserted below, never by colour alone.
    await expectContrast(
      accountBadge,
      'color',
      accountBadge,
      'backgroundColor',
      4.5,
    );

    await expect(disabledAction).toBeDisabled();
    await expect(disabledAction).toHaveAccessibleName('Retry');
    await expect(page.getByRole('img', { name: 'Online' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Away' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Offline' })).toBeVisible();
    await expect(
      page.getByRole('img', {
        name: 'Account: Ada account (@ada:example.org)',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: 'accent xs progress' }),
    ).toBeVisible();
  });
}

test('catalog retains compact density and bounded exact avatar geometry', async ({
  page,
}) => {
  await page.goto(
    `${CATALOG_STORY}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW, 'compact')}`,
  );
  await expect(page.getByTestId('complete-content-catalog')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  const exactAvatar = page.getByTestId('catalog-avatar-exact');
  await expect(exactAvatar).toHaveAttribute('data-size', '2xs');
  await expect(exactAvatar).toHaveAttribute('data-exact-size', '72');
  expect(await exactAvatar.locator('hlm-avatar').boundingBox()).toMatchObject({
    height: 72,
    width: 72,
  });
});
