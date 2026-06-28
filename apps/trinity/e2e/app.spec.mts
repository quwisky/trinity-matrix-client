import { test, expect } from '@playwright/test';

// Smoke checks that need no homeserver — the SPA boots, the login screen renders,
// and the auth guard protects app routes.
test.describe('App shell', () => {
  test('renders the login screen with a homeserver field', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('ion-input[label="Homeserver"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Continue', { exact: true })).toBeVisible();
  });

  test('redirects an unauthenticated user from /settings to /login', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.waitForURL('**/login', { timeout: 20_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
