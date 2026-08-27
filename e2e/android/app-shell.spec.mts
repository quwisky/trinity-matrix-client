import {
  expectLoginScreen,
  expectProtectedRouteRedirect,
} from '../playwright/journeys/app-shell.mts';
import { test } from './fixtures.mts';

test.describe('Android app shell', () => {
  test('renders login and protects authenticated routes in the installed app', async ({
    app,
    page,
  }) => {
    await expectLoginScreen(page, app.navigate);
    await expectProtectedRouteRedirect(page, app.navigate);
  });
});
