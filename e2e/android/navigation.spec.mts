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
});
