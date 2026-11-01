import { test, expect, type Route } from '../../../fixtures.mts';
import {
  deviceKeysPublished,
  fillLabeledInput,
  homeserverSession,
  login,
  onDeviceCheck,
  settleSignIn,
  waitForRooms,
  webNavigate,
} from '../../../support/app.mts';
import { publishIdentityWithoutRecovery } from '../../../support/cross-signing.mts';
import { freshAccount } from '../../support/encryption-journey.mts';

// MSC4153 Phase 0, PR 3: where the new-device check applies and where it does not, and
// what it does to the rest of the app. Accounts get their identity from a throwaway crypto
// machine (no recovery), so these need no second browser. Needs a homeserver; self-skips.
const session = homeserverSession();
const KEY_QUERIES = '**/_matrix/client/v3/keys/query';

test.describe('The new-device check in the app', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('an account without an identity never meets the check', async ({
    page,
    request,
  }) => {
    test.slow();
    const { asSession } = await freshAccount(
      request,
      session.hs as string,
      'dc-none',
    );
    const banner = page.locator('trn-encryption-banner trn-banner');

    await login(page, asSession, webNavigate, 'forbid');
    // Settled: the status is known (the setup banner shows) and the app is still on Rooms.
    await expect(banner).toContainText(
      'Set up encryption to secure your messages.',
      { timeout: 30_000 },
    );
    expect(new URL(page.url()).pathname).toBe('/rooms');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForRooms(page);
    await expect(banner).toContainText(
      'Set up encryption to secure your messages.',
      { timeout: 30_000 },
    );
    expect(new URL(page.url()).pathname).toBe('/rooms');
  });

  test('a device that signed in before the account had an identity is never sent later', async ({
    page,
    request,
  }) => {
    // Owner decision 2026-10-12 (1): an existing device keeps the prompt, never the check.
    test.slow();
    const hs = session.hs as string;
    const { user, pass, asSession } = await freshAccount(
      request,
      hs,
      'dc-later',
    );
    const banner = page.locator('trn-encryption-banner trn-banner');
    await login(page, asSession, webNavigate, 'forbid');
    await expect(banner).toContainText(
      'Set up encryption to secure your messages.',
      { timeout: 30_000 },
    );

    // Another client sets up an identity for the account.
    await publishIdentityWithoutRecovery(request, hs, user, pass);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForRooms(page);
    // Settled: this device now reads the identity (the banner asks to verify), and stays.
    await expect(banner).toContainText(
      'verify it with one of your other devices',
      { timeout: 60_000 },
    );
    expect(new URL(page.url()).pathname).toBe('/rooms');
  });

  test('signing in again on the same device is not a new device', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const { user, pass, asSession } = await freshAccount(
      request,
      hs,
      'dc-relogin',
    );
    await publishIdentityWithoutRecovery(request, hs, user, pass);

    const published = deviceKeysPublished(page);
    await login(page, asSession, webNavigate, 'expect');
    await page.getByTestId('device-confirmation-skip').click();
    await waitForRooms(page);
    const userId = (
      (await page.locator('.userbar__handle').textContent()) ?? ''
    ).trim();
    // The re-auth checks the device still has its keys; one that hasn't published yet has none.
    await published;

    await page.goto(`/login?reauth=${encodeURIComponent(userId)}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(
      page.getByText('Sign in again to reconnect this account'),
    ).toBeVisible({ timeout: 15_000 });
    await fillLabeledInput(page, 'Password', pass);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settleSignIn(page, 'forbid');
    // Settled: the status is known (the banner asks to verify), and no check came.
    await expect(
      page.locator('trn-encryption-banner trn-banner'),
    ).toContainText('isn’t verified yet', { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe('/rooms');
  });

  test('a pending check on one account never blocks the other, and comes back with it', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const marked = await freshAccount(request, hs, 'dc-two-marked');
    const plain = await freshAccount(request, hs, 'dc-two-plain');
    await publishIdentityWithoutRecovery(request, hs, marked.user, marked.pass);

    await login(page, marked.asSession, webNavigate, 'expect');
    await expect(
      page.getByTestId('device-confirmation-other-device'),
    ).toBeVisible({ timeout: 30_000 });

    // "Add account" in the account menu opens this same route.
    await page.goto('/login?add=1', { waitUntil: 'domcontentloaded' });
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Sign in' })
      .waitFor({ timeout: 30_000 });
    await fillLabeledInput(page, 'Username', plain.user);
    await fillLabeledInput(page, 'Password', plain.pass);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settleSignIn(page, 'forbid');

    // The account still waiting on its check is marked in the switcher (PR 2).
    await page.getByTestId('user-menu-trigger').click();
    const markedRow = page
      .getByTestId('account-row')
      .filter({ hasText: marked.user });
    await expect(markedRow.getByTestId('account-row-unverified')).toHaveText(
      'Unverified',
      { timeout: 30_000 },
    );

    // Switching back brings the check back.
    await markedRow.click();
    await page.waitForURL(onDeviceCheck, { timeout: 30_000 });
    await expect(
      page.getByTestId('device-confirmation-other-device'),
    ).toBeVisible({ timeout: 30_000 });

    // The check has no account menu (and desktop and mobile have no address bar): its own
    // way back to the other account opens Rooms as that account.
    await page.getByTestId('device-confirmation-other-account').click();
    await waitForRooms(page);
    await expect(page.locator('.userbar__handle')).toContainText(plain.user, {
      timeout: 30_000,
    });
    expect(new URL(page.url()).pathname).toBe('/rooms');
  });

  test('Open Security settings from the verify page reaches Security, and leaving it returns to the check', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const { user, pass, asSession } = await freshAccount(request, hs, 'dc-sec');
    await publishIdentityWithoutRecovery(request, hs, user, pass);

    await login(page, asSession, webNavigate, 'expect');
    await expect(
      page.getByTestId('device-confirmation-no-recovery'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId('device-confirmation-recovery-key'),
    ).toHaveCount(0);

    await page.getByTestId('device-confirmation-other-device').click();
    await page.waitForURL((url) => url.pathname === '/encryption/verify');
    await page.getByTestId('verify-security-settings').click();
    await page.waitForURL((url) => url.pathname === '/settings/security', {
      timeout: 30_000,
    });
    // Settled: Security rendered this account's state, and the URL held.
    await expect(page.getByTestId('security-needs-verification')).toBeVisible({
      timeout: 30_000,
    });
    expect(new URL(page.url()).pathname).toBe('/settings/security');

    await page.goto('/rooms', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(onDeviceCheck, { timeout: 30_000 });
  });

  test('a check that turns required late closes Settings over Rooms, which is not a trust flow, and opens the check', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const { user, pass, asSession } = await freshAccount(
      request,
      hs,
      'dc-late',
    );
    await publishIdentityWithoutRecovery(request, hs, user, pass);

    // Hold this device's key queries: neither the server identity check nor the device's
    // own identity download can answer until Settings is open over Rooms. Settings is not a
    // trust flow, so owner decision 2026-10-12 (2) closes it rather than waiting for it.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = async (route: Route): Promise<void> => {
      await released;
      await route.continue();
    };
    await page.route(KEY_QUERIES, hold);
    try {
      // The guard's settle time (10 s) lets Rooms open while the status is unknown.
      await login(page, asSession, webNavigate, 'forbid');
      await page.getByTestId('open-settings').click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible({ timeout: 15_000 });

      release();
      await page.waitForURL(onDeviceCheck, { timeout: 60_000 });
      await expect(
        page.getByTestId('device-confirmation-no-recovery'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(settings).toHaveCount(0);
    } finally {
      release();
      await page.unroute(KEY_QUERIES, hold);
    }
  });
});
