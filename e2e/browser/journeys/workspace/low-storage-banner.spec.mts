import { expect, test } from '../../../fixtures.mts';

/**
 * Installed before the app loads: persistent storage is granted, so its notice stays out
 * of the slot, and only 100 MB of a 10 GB quota is left.
 */
function fakeLowSpace(): void {
  const quota = 10 * 1024 ** 3;
  Object.defineProperties(StorageManager.prototype, {
    persisted: { configurable: true, value: () => Promise.resolve(true) },
    estimate: {
      configurable: true,
      value: () => Promise.resolve({ quota, usage: quota - 100 * 1024 ** 2 }),
    },
  });
}

test.describe('Low-storage warning', () => {
  test('warns at startup when the device is low on space', async ({ page }) => {
    await page.addInitScript(fakeLowSpace);
    await page.goto('/login');

    const summary = page.getByTestId('app-capability-summary');
    await expect(summary).toContainText('This device is running low on space.');
    await summary.getByRole('button', { name: 'System status' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'System status' })
        .locator('article')
        .filter({ hasText: 'This device is running low on space' }),
    ).toContainText('Free up space on this device');
  });
});
