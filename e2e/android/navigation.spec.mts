import { openSettingsFromRooms } from '../playwright/journeys/navigation.mts';
import { login, synapseSession } from '../playwright/support/app.mts';
import { expect, test } from './fixtures.mts';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const session = synapseSession();
const composerRoomName = `Android insert ${Date.now()}`;

async function seedComposerRoom(): Promise<void> {
  const loginResponse = await fetch(`${session.hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: session.user },
      password: session.pass,
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Android room-seed login failed: ${loginResponse.status}`);
  }
  const { access_token: token } = (await loginResponse.json()) as {
    access_token: string;
  };
  const roomResponse = await fetch(
    `${session.hs}/_matrix/client/v3/createRoom`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: composerRoomName }),
    },
  );
  if (!roomResponse.ok) {
    throw new Error(`Android room seed failed: ${roomResponse.status}`);
  }
}

test.describe('Android navigation', () => {
  test.beforeAll(seedComposerRoom);

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

  test.describe('phone-sized composer', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('uses a native-style sheet that hardware Back dismisses', async ({
      app,
      page,
    }) => {
      await login(page, session, app.navigate);
      await page.getByTestId('rail-rooms').click();
      await expect(page.getByTestId('rail-rooms')).toHaveAttribute(
        'aria-current',
        'true',
      );
      const room = page
        .locator('button.channel', { hasText: composerRoomName })
        .first();
      await room.waitFor({ state: 'visible', timeout: 30_000 });
      await room.click();

      const trigger = page.getByTestId('composer-insert');
      await app.touch(trigger);
      await expect(page.getByTestId('action-sheet-surface')).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');

      await app.device.input.press('Back');
      await expect(page.getByTestId('action-sheet-surface')).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('composer-input')).toBeVisible();
    });
  });
});
