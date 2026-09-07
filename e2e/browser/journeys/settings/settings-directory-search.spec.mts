import { captureScreenshot } from '../../../support/screenshot.mts';
import { devices, expect, test, type Page } from '../../../fixtures.mts';
import { isAndroidE2E } from '../../../support/app.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  configureSettingsSuite,
  openSection,
} from '../../support/settings-journey.mts';

const search = (page: Page) =>
  page.getByRole('searchbox', { name: 'Search settings' });

const status = (page: Page) =>
  page.locator('trn-settings-directory-search').getByRole('status');

const navItems = (page: Page) => page.locator('[data-testid^="settings-nav-"]');

test.describe('Settings directory search', () => {
  configureSettingsSuite();

  test('filters by label or group, announces results, clears by button, and keeps detail selected', async ({
    page,
  }) => {
    test.skip(
      isAndroidE2E,
      'the routed Android host has a separate directory journey',
    );

    await openSection(page, 'notifications');
    await expect(
      page.getByRole('heading', { name: 'Notifications' }),
    ).toBeVisible();

    const field = search(page);
    const resultStatus = status(page);
    await expect(resultStatus).toHaveAttribute('aria-live', 'polite');
    const initialUrl = page.url();
    await field.fill('  PREF ');

    // Group matching preserves the registry order within Preferences.
    await expect(resultStatus).toHaveText('3 sections found');
    await expect(page).toHaveURL(initialUrl);
    await expect(
      page.getByText('No sections found.', { exact: true }),
    ).toBeHidden();
    await expect(navItems(page)).toHaveCount(3);
    await test.info().attach('settings-search-desktop', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });
    expect(await navItems(page).allTextContents()).toEqual([
      expect.stringContaining('Appearance'),
      expect.stringContaining('Notifications'),
      expect.stringContaining('Privacy'),
    ]);
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
    await expect(page.getByTestId('settings-nav-notifications')).toBeVisible();
    await expect(page.getByTestId('settings-nav-privacy')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Notifications' }),
    ).toBeVisible();

    await field.fill('does-not-exist');
    await expect(resultStatus).toContainText('0 sections found');
    await expect(resultStatus).toContainText('No sections found.');
    await expect(
      page.getByText('No sections found.', { exact: true }),
    ).toBeVisible();
    await expect(navItems(page)).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Notifications' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(field).toBeFocused();
    await expect(field).toBeEmpty();
    await expect(resultStatus).toHaveText('14 sections found');
    await expect(navItems(page)).toHaveCount(14);

    // Keyboard activation follows the filtered directory without changing the URL owner.
    await field.fill('privacy');
    await field.press('ControlOrMeta+A');
    await field.press('Backspace');
    await expect(field).toBeEmpty();
    await expect(resultStatus).toHaveText('14 sections found');
    await field.fill('privacy');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings-nav-privacy')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { name: 'Privacy' })).toBeFocused();
  });

  test.describe('Pixel 5 routed history', () => {
    test.use({
      viewport: devices['Pixel 5'].viewport,
      userAgent: devices['Pixel 5'].userAgent,
      deviceScaleFactor: devices['Pixel 5'].deviceScaleFactor,
      isMobile: devices['Pixel 5'].isMobile,
      hasTouch: devices['Pixel 5'].hasTouch,
    });

    test('keeps a routed direct link and query through mobile navigation and Back', async ({
      page,
    }) => {
      await closeSettings(page);
      await page.goto('/settings/appearance');
      await expect(page).toHaveURL(/\/settings\/appearance$/);
      await expect(
        page.getByRole('heading', { name: 'Appearance' }),
      ).toBeFocused();

      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(search(page)).toBeEmpty();
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(/\/rooms/);
      await page.goto('/settings');
      await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
      const field = search(page);
      await field.fill('  noti ');
      await expect(status(page)).toHaveText('1 section found');
      await page.getByTestId('settings-nav-notifications').click();
      await page.waitForURL(/\/settings\/notifications$/);
      await expect(
        page.locator('trn-settings-directory-search input'),
      ).toHaveValue('  noti ');
      await expect(
        page.getByRole('heading', { name: 'Notifications' }),
      ).toBeFocused();

      await page.goBack();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(field).toHaveValue('  noti ');
      await expect(
        page.getByTestId('settings-nav-notifications'),
      ).toBeFocused();

      await page.getByTestId('settings-nav-notifications').click();
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(field).toHaveValue('  noti ');
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(/\/rooms/);

      await page.goto('/settings');
      await expect(search(page)).toBeEmpty();
      await page.setViewportSize({ width: 1280, height: 700 });
      await expect(page).toHaveURL(/\/settings\/profile$/);
      await field.fill('appearance');
      await page.setViewportSize(devices['Pixel 5'].viewport);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('appearance');
    });
  });

  test.describe('Pixel 5 modal history and containment', () => {
    test.use({
      viewport: devices['Pixel 5'].viewport,
      userAgent: devices['Pixel 5'].userAgent,
      deviceScaleFactor: devices['Pixel 5'].deviceScaleFactor,
      isMobile: devices['Pixel 5'].isMobile,
      hasTouch: devices['Pixel 5'].hasTouch,
    });

    test('restores result focus on modal Back and exits in one step after resize', async ({
      page,
    }) => {
      test.skip(isAndroidE2E, 'the routed Android host does not own a modal');

      await page.setViewportSize(devices['Pixel 5'].viewport);
      await closeSettings(page);
      await openSettingsFromRooms(page);
      const field = search(page);
      await field.fill('appearance');
      await test.info().attach('settings-search-mobile', {
        body: await captureScreenshot(page, () => page.screenshot()),
        contentType: 'image/png',
      });
      const appearance = page.getByTestId('settings-nav-appearance');
      await appearance.click();
      await expect(page.getByTestId('mode-dark')).toBeVisible();
      await page.getByRole('button', { name: 'Back to sections' }).click();
      await expect(appearance).toBeFocused();
      await expect(field).toHaveValue('appearance');

      await appearance.click();
      await expect(page.getByTestId('mode-dark')).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 700 });
      await expect(field).toHaveValue('appearance');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(
        1,
      );
      // A wide filter can hide the current section before a later narrow Back.
      await field.fill('privacy');
      await page.setViewportSize(devices['Pixel 5'].viewport);
      await page.getByRole('button', { name: 'Back to sections' }).click();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('privacy');
      await page.getByTestId('settings-nav-privacy').click();
      await page.setViewportSize({ width: 1024, height: 700 });
      await closeSettings(page);
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
      await expect(page).not.toHaveURL(/\/settings/);

      await openSettingsFromRooms(page);
      await expect(search(page)).toBeEmpty();
    });

    test('keeps the bounded frame and both scroll owners usable when scaled', async ({
      page,
    }) => {
      test.skip(isAndroidE2E, 'the routed Android host has a separate frame');

      await page.setViewportSize({ width: 375, height: 800 });
      await closeSettings(page);
      await openSettingsFromRooms(page);
      await page.setViewportSize({ width: 1280, height: 600 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '125%';
      });
      await expect(page.locator('.settings-layout')).toHaveAttribute(
        'data-trn-layout',
        'workspace',
      );
      await expect(page.getByTestId('settings-detail')).toBeVisible();
      await search(page).fill('preferences');
      await expect(status(page)).toHaveText('3 sections found');

      const metrics = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(
          '[data-testid="settings-dialog"]',
        );
        const workspace = root?.querySelector<HTMLElement>(
          '[data-testid="settings-workspace"]',
        );
        const directory = root?.querySelector<HTMLElement>(
          '[data-testid="settings-dialog-directory"]',
        );
        const detail = root?.querySelector<HTMLElement>(
          '[data-testid="settings-detail"]',
        );
        if (!root || !workspace || !directory || !detail) {
          throw new Error('settings frame is incomplete');
        }
        return {
          rootOverflow: root.scrollWidth - root.clientWidth,
          workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
          directoryOverflowY: getComputedStyle(directory).overflowY,
          detailOverflowY: getComputedStyle(detail).overflowY,
          detailStartsAfterDirectory:
            detail.getBoundingClientRect().left >=
            directory.getBoundingClientRect().right - 1,
        };
      });
      expect(metrics.rootOverflow).toBeLessThanOrEqual(1);
      expect(metrics.workspaceOverflow).toBeLessThanOrEqual(1);
      expect(metrics.directoryOverflowY).toBe('auto');
      expect(metrics.detailOverflowY).toBe('auto');
      expect(metrics.detailStartsAfterDirectory).toBe(true);
    });
  });
});
