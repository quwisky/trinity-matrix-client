import { test, expect, type Page } from '@playwright/test';
import { login, fillIonInput, synapseSession } from './support/app.mts';

// Authenticated journeys through Settings — the work landed this session: theme
// switching, profile editing, and device management. They need a live homeserver,
// so the suite skips itself when the disposable Synapse wasn't available (no Docker).
const session = synapseSession();

const hasDarkPalette = (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    document.documentElement.classList.contains('ion-palette-dark'),
  );

test.describe('Settings', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.beforeEach(async ({ page }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();
    await page.waitForURL('**/settings', { timeout: 20_000 });
  });

  test('toggles the app theme between dark and light', async ({ page }) => {
    await page.getByTestId('theme-dark').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(true);

    await page.getByTestId('theme-light').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(false);
  });

  test('edits and saves the display name', async ({ page }) => {
    const name = `E2E ${Date.now()}`;
    await fillIonInput(page, 'Display name', name);
    await page.getByTestId('save-name').click();

    // The profile header reflects the persisted name (Save round-trips the HS).
    await expect(page.locator('ion-list h2').first()).toHaveText(name, {
      timeout: 20_000,
    });
  });

  test('lists the current device under Devices', async ({ page }) => {
    const devices = page.locator('trn-devices-section');
    await expect(
      devices.getByText('Devices', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    // Once the list loads, the signed-in session carries a "This device" badge.
    await expect(devices.getByText('This device')).toBeVisible({
      timeout: 30_000,
    });
  });
});
