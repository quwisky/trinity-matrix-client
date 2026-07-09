import { test, expect, type Page } from '@playwright/test';
import { login, fillLabeledInput, synapseSession } from './support/app.mts';

// Authenticated journeys through Settings — the work landed this session: theme
// switching, profile editing, and device management. They need a live homeserver,
// so the suite skips itself when the disposable Synapse wasn't available (no Docker).
const session = synapseSession();

// A 1x1 transparent PNG — a valid image the homeserver accepts as an avatar.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const hasDarkPalette = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

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
    await fillLabeledInput(page, 'Display name', name);
    await page.getByTestId('save-name').click();

    // The profile header reflects the persisted name (Save round-trips the HS).
    await expect(page.getByTestId('profile-display-name')).toHaveText(name, {
      timeout: 20_000,
    });
  });

  test('changes the profile picture from the avatar corner badge', async ({
    page,
  }) => {
    const change = page.getByTestId('change-avatar');
    await expect(change).toBeVisible();
    // Icon-only control: a labelled button carrying an SVG icon, no "Change" text.
    await expect(change).toHaveAttribute(
      'aria-label',
      'Change profile picture',
    );
    await expect(change.locator('svg')).toBeVisible();
    await expect(change).not.toContainText('Change');

    // Clicking the badge opens the hidden file input's chooser; upload a PNG.
    const chooserPromise = page.waitForEvent('filechooser');
    await change.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });

    // setAvatar patches the profile's mxc, so the picture round-trips the
    // homeserver and the avatar (beside the badge) renders as an <img>.
    const avatar = change.locator('..').locator('trn-avatar img');
    await expect(avatar).toBeVisible({ timeout: 30_000 });
  });

  test('lists the current device under Devices', async ({ page }) => {
    const devices = page.locator('trn-devices-section');
    await expect(devices.getByText('Devices', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Once the list loads, the signed-in session carries a "This device" badge.
    await expect(devices.getByText('This device')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('toggles and persists the virtualized-timeline flag', async ({
    page,
  }) => {
    // Capacitor Preferences stores non-secret prefs in localStorage under this key.
    const KEY = 'CapacitorStorage.trinity.flags.virtual-timeline';
    const read = () => page.evaluate((k) => localStorage.getItem(k), KEY);

    const checkbox = page
      .getByTestId('flag-virtual-timeline')
      .locator('hlm-checkbox');
    await expect(checkbox).toBeVisible();
    expect(await read()).not.toBe('true'); // off by default

    await checkbox.click();
    await expect.poll(read).toBe('true'); // persisted to Preferences

    // Survives a reload (FeatureFlagsService.init reads it back at startup).
    await page.reload();
    await page.waitForURL('**/settings', { timeout: 20_000 });
    expect(await read()).toBe('true');

    // Toggling back off persists too.
    await page
      .getByTestId('flag-virtual-timeline')
      .locator('hlm-checkbox')
      .click();
    await expect.poll(read).toBe('false');
  });
});
