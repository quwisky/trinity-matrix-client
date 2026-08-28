import { openSettingsFromRooms } from '../playwright/journeys/navigation.mts';
import { login, synapseSession } from '../playwright/support/app.mts';
import { expect, test } from './fixtures.mts';

const session = synapseSession();

test.describe('Android navigation', () => {
  test('logs in, opens settings by touch, and handles hardware Back', async ({
    app,
    page,
  }) => {
    await login(page, session, app.navigate);
    await openSettingsFromRooms(page, (control) => app.touch(control));

    await app.device.input.press('Back');
    await page.waitForURL(/\/rooms(\/|$)/, { timeout: 20_000 });
    await expect(page.locator('trn-rooms')).toBeVisible({ timeout: 20_000 });
  });

  test('restores the authenticated route after a native process restart', async ({
    app,
    page,
  }) => {
    await login(page, session, app.navigate);

    const relaunchedPage = await app.relaunch();
    await relaunchedPage.waitForURL(/\/rooms(\/|$)/, { timeout: 30_000 });
    await expect(relaunchedPage.locator('trn-rooms')).toBeVisible({ timeout: 30_000 });
  });

  test.describe('phone-sized Settings', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('drills into a section and restores its directory link on hardware Back', async ({
      app,
      page,
    }) => {
      await login(page, session, app.navigate);
      await openSettingsFromRooms(page, (control) => app.touch(control));

      const appearance = page.getByTestId('settings-nav-appearance');
      await expect(appearance).toBeVisible({ timeout: 20_000 });
      const target = await appearance.boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
      await app.touch(appearance);
      await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
      await expect(
        page.getByRole('heading', { name: 'Appearance' }),
      ).toBeFocused();

      await app.device.input.press('Back');
      await page.waitForURL(/\/settings$/, { timeout: 20_000 });
      await expect(appearance).toBeFocused();
      const horizontalOverflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(horizontalOverflow).toBeLessThanOrEqual(1);

      await app.device.input.press('Back');
      await page.waitForURL(/\/rooms(\/|$)/, { timeout: 20_000 });
    });
  });
});
