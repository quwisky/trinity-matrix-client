import { expect, test, type Page, type Route } from '../../../fixtures.mts';

const HOMESERVER = 'https://hs.design-system.example';

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockPasswordHomeserver(page: Page): Promise<void> {
  await page.route(/\/\.well-known\/matrix\/client/, (route) =>
    json(route, { 'm.homeserver': { base_url: HOMESERVER } }),
  );
  await page.route(
    /hs\.design-system\.example\/_matrix\/client\/versions/,
    (route) =>
      json(route, { versions: ['v1.1', 'v1.15'], unstable_features: {} }),
  );
  await page.route(
    /hs\.design-system\.example\/_matrix\/client\/v3\/login/,
    (route) => json(route, { flows: [{ type: 'm.login.password' }] }),
  );
  await page.route(
    /hs\.design-system\.example\/_matrix\/client\/v1\/auth_metadata/,
    (route) => json(route, { errcode: 'M_NOT_FOUND' }, 404),
  );
  await page.route(
    /hs\.design-system\.example\/_matrix\/client\/v3\/register\/available/,
    (route) => json(route, { errcode: 'M_FORBIDDEN' }, 403),
  );
}

test.describe('public design-system tracer', () => {
  test('preserves labelled fields, keyboard progression and password disclosure', async ({
    page,
  }) => {
    await mockPasswordHomeserver(page);
    await page.goto('/login');

    const authCard = page.locator('[trncard]');
    await expect(authCard).toHaveAttribute('data-variant', 'muted');
    await expect(authCard).toHaveAttribute('data-size', 'md');
    await expect(authCard).toHaveCSS('flex-grow', '0');
    const wordmark = authCard.locator('.login-card__wordmark');
    await expect(wordmark).toHaveCSS('font-size', '24px');
    await expect(wordmark).toHaveCSS('font-weight', '800');

    const homeserver = page.getByRole('textbox', { name: 'Homeserver' });
    await expect(homeserver).toHaveAttribute('id', 'homeserver');
    await expect(
      page.locator('trn-field-label', { hasText: 'Homeserver' }),
    ).toHaveAttribute('controlid', 'homeserver');

    await homeserver.fill('design-system.example');
    await homeserver.press('Enter');

    const username = page.getByRole('textbox', { name: 'Username' });
    const password = page.getByRole('textbox', { name: 'Password' });
    await expect(username).toBeFocused();
    await expect(password).toHaveAttribute('type', 'password');

    const disclosure = page.getByRole('button', { name: 'Show password' });
    await disclosure.click();
    const concealment = page.getByRole('button', { name: 'Hide password' });
    await expect(concealment).toHaveAttribute('aria-pressed', 'true');
    await expect(password).toHaveAttribute('type', 'text');
    await expect(concealment).toHaveAccessibleName('Hide password');
  });
});
