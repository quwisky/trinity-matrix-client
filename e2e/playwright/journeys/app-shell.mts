import { expect, type Page } from '@playwright/test';
import type { Navigate } from '../support/app.mts';

export async function expectLoginScreen(
  page: Page,
  navigate: Navigate,
): Promise<void> {
  await navigate(page, '/login');
  await expect(page.getByLabel('Homeserver')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Continue', { exact: true })).toBeVisible();
}

export async function expectProtectedRouteRedirect(
  page: Page,
  navigate: Navigate,
): Promise<void> {
  await navigate(page, '/settings');
  await page.waitForURL('**/login', { timeout: 20_000 });
  await expect(page).toHaveURL(/\/login/);
}
