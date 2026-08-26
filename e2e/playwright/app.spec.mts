import { test } from '@playwright/test';
import {
  expectLoginScreen,
  expectProtectedRouteRedirect,
} from './journeys/app-shell.mts';
import { webNavigate } from './support/app.mts';

// Smoke checks that need no homeserver — the SPA boots, the login screen renders,
// and the auth guard protects app routes.
test.describe('App shell', () => {
  test('renders the login screen with a homeserver field', async ({ page }) => {
    await expectLoginScreen(page, webNavigate);
  });

  test('redirects an unauthenticated user from /settings to /login', async ({
    page,
  }) => {
    await expectProtectedRouteRedirect(page, webNavigate);
  });
});
