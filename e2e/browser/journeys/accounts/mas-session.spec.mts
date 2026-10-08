import { expect, test, type APIRequestContext } from '../../../fixtures.mts';
import {
  databaseNames,
  homeserverSession,
  login,
  preferenceKeys,
  waitForRooms,
} from '../../../support/app.mts';
import {
  masEndpoints,
  signInWithMas,
  trackMasTraffic,
  type MasAccount,
} from '../../support/mas.mts';

// Next-gen auth (MSC3861) against a REAL matrix-authentication-service: the provider most
// OAuth-native deployments (matrix.org among them) run, behind a delegating Synapse that
// answers an expired token with soft_logout: false. oidc-login.spec.mts mocks the provider
// and stops at the code exchange; this covers what follows on matrix-js-sdk 43: refresh,
// the SDK's own revocation at sign-out, and the factory reset.
//
// Opt-in: TRINITY_E2E_MAS=1 adds the stack (e2e/support/homeserver/mas/); without it every
// test skips. MAS issues 60 s access tokens, so the refresh test takes about three
// minutes.
const session = homeserverSession();
const mas = session.mas;

/** `whoami` status for an access token, straight at the MAS-backed homeserver. */
async function whoamiStatus(
  request: APIRequestContext,
  account: MasAccount,
  accessToken: string,
): Promise<number> {
  const response = await request.get(
    `${account.hs}/_matrix/client/v3/account/whoami`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  return response.status();
}

test.describe('MAS session lifecycle', () => {
  test.skip(!mas, 'needs the opt-in MAS stack (TRINITY_E2E_MAS=1)');

  test('signs in through MAS with the authorization-code flow', async ({
    page,
    authPlatform,
    request,
  }) => {
    const account = mas as MasAccount;
    const endpoints = await masEndpoints(request, account);
    const authorize: URL[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(endpoints.authorization))
        authorize.push(new URL(r.url()));
    });

    await signInWithMas(page, authPlatform, account);

    await expect(page.locator('.userbar__handle')).toContainText(
      `@${account.user}:`,
    );
    // matrix-js-sdk 43 takes redirect_uri as a positional argument; `(state, 'query')`
    // would still typecheck and send redirect_uri=query.
    const params = authorize[0]?.searchParams;
    expect(params?.get('redirect_uri')).toBe(
      authPlatform.callbackUrl(page, '/sso-callback', 'oidc'),
    );
    expect(params?.get('response_mode')).toBe('query');

    await page.reload();
    await waitForRooms(page, 60_000);
  });

  test('refreshes the access token twice and keeps the session', async ({
    page,
    authPlatform,
    request,
  }) => {
    // Two real 60 s MAS access-token lifetimes, plus sign-in and a reload.
    test.setTimeout(360_000);
    const account = mas as MasAccount;
    const userId = `@${account.user}:${account.serverName}`;
    const traffic = trackMasTraffic(
      page,
      account,
      await masEndpoints(request, account),
    );
    const ownStores = async (): Promise<string[]> =>
      (await databaseNames(page))
        .filter((name) => name.includes(userId))
        .sort();

    await signInWithMas(page, authPlatform, account);
    await expect
      .poll(async () => (await ownStores()).length)
      .toBeGreaterThanOrEqual(2);
    const storesBefore = await ownStores();

    // The first refresh follows the first 401 after expiry; the second is the SDK's
    // eager refresh at the expiry it learned from the first.
    await expect
      .poll(() => traffic.refreshGrants.length, {
        timeout: 240_000,
        intervals: [5_000],
      })
      .toBeGreaterThanOrEqual(2);

    // MAS rotates, and each grant presented the refresh token the previous response issued.
    const [exchange, firstRefresh] = traffic.tokenResponses;
    expect(
      traffic.refreshGrants[0].get('refresh_token') === exchange.refresh_token,
      'the first grant used the refresh token from the code exchange',
    ).toBe(true);
    expect(
      traffic.refreshGrants[1].get('refresh_token') ===
        firstRefresh.refresh_token,
      'the second grant used the rotated refresh token',
    ).toBe(true);

    // Past its lifetime, the code-exchange token is refused…
    expect(await whoamiStatus(request, account, exchange.access_token)).toBe(
      401,
    );
    // …while the app keeps syncing with the refreshed one.
    const latest = `Bearer ${await traffic.latestAccessToken()}`;
    await expect
      .poll(
        () =>
          traffic.syncs.some(
            (s) => s.authorization === latest && s.status === 200,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(page).toHaveURL(/\/rooms/);
    // A refresh that ended in a hard logout would have deleted these stores.
    expect(await ownStores()).toEqual(storesBefore);

    // The rotated pair reached storage: a reload restores the session from it.
    await page.reload();
    await waitForRooms(page, 60_000);
  });

  test('signs out with one revocation and forgets only that account', async ({
    page,
    authPlatform,
    request,
  }) => {
    const account = mas as MasAccount;
    const userId = `@${account.user}:${account.serverName}`;
    const traffic = trackMasTraffic(
      page,
      account,
      await masEndpoints(request, account),
    );

    await login(page, session);
    await signInWithMas(page, authPlatform, account, 'add');
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${account.user}:`,
    );
    const accessToken = await traffic.latestAccessToken();
    await expect
      .poll(
        async () =>
          (await databaseNames(page)).filter((n) => n.includes(userId)).length,
      )
      .toBeGreaterThanOrEqual(2);

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();

    // The password account survives and takes over; the switcher no longer lists MAS's.
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${session.user}:`,
    );
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
    await expect(page.getByTestId('account-row')).not.toContainText(userId);
    await page.keyboard.press('Escape');

    // One revocation pass, by matrix-js-sdk's logout(): each token once, and no
    // POST /logout. The switcher only updates after that step settled.
    await expect
      .poll(() => traffic.revocations.length)
      .toBeGreaterThanOrEqual(2);
    expect([...traffic.revocations].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    expect(traffic.logoutCalls).toEqual([]);
    // MAS ended the session, so the homeserver refuses its token.
    await expect
      .poll(() => whoamiStatus(request, account, accessToken), {
        timeout: 30_000,
      })
      .toBe(401);

    // Only that account's local data is gone. Its stores are deleted in the background.
    await expect
      .poll(
        async () =>
          (await databaseNames(page)).filter((n) => n.includes(userId)),
        {
          timeout: 45_000,
        },
      )
      .toEqual([]);
    expect(
      (await databaseNames(page)).some((n) => n.includes(`@${session.user}:`)),
    ).toBe(true);
    expect(
      (await preferenceKeys(page)).filter((k) => k.includes(userId)),
    ).toEqual([]);
    expect(
      await page.evaluate(() =>
        localStorage.getItem('CapacitorStorage.matrix.accounts'),
      ),
    ).not.toContain(userId);
  });

  test('factory reset completes for a MAS account and ends its session', async ({
    page,
    authPlatform,
    request,
  }) => {
    const account = mas as MasAccount;
    const userId = `@${account.user}:${account.serverName}`;
    const traffic = trackMasTraffic(
      page,
      account,
      await masEndpoints(request, account),
    );
    await signInWithMas(page, authPlatform, account);
    const accessToken = await traffic.latestAccessToken();

    // From ?add, with the client live and holding its databases open, as
    // clear-all-data.spec.mts does.
    await page.goto('/login?add', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('clear-all-data').click();
    const dialog = page.locator('trn-alert-dialog', {
      hasText: 'Erase all Trinity data',
    });
    await dialog.locator('input').fill('RESET TRINITY');
    await dialog.getByTestId('alert-confirm').click();

    await expect
      .poll(
        async () => (await preferenceKeys(page).catch(() => null))?.length,
        {
          timeout: 30_000,
        },
      )
      .toBe(0);
    await expect(page.getByLabel('Homeserver')).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        async () =>
          (await databaseNames(page).catch(() => null))?.filter((n) =>
            n.includes(userId),
          ),
        { timeout: 30_000 },
      )
      .toEqual([]);
    // signOutAll()'s logout() revoked the session at MAS before the wipe.
    await expect
      .poll(() => whoamiStatus(request, account, accessToken), {
        timeout: 30_000,
      })
      .toBe(401);
  });
});
