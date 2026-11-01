import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  databaseNames,
  homeserverSession,
  login,
  preferenceKeys,
  waitForRooms,
} from '../../../support/app.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import {
  completeMasSignIn,
  masEndpoints,
  openAddAccount,
  registerMasUser,
  signInWithMas,
  trackMasTraffic,
  type MasAccount,
  type MasEndpoints,
  type MasTokenResponse,
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

/** The stack's account; the describe below skips when there is none, so this is a guard. */
function masAccount(): MasAccount {
  if (!mas) throw new Error('the MAS stack is not running (TRINITY_E2E_MAS=1)');
  return mas;
}

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

/** `whoami` body for an access token, which names the device the token belongs to. */
async function whoami(
  request: APIRequestContext,
  account: MasAccount,
  accessToken: string,
): Promise<{ user_id: string; device_id: string }> {
  const response = await request.get(
    `${account.hs}/_matrix/client/v3/account/whoami`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as { user_id: string; device_id: string };
}

/** A refresh grant sent from outside the app, as another process holding the token would. */
async function rotateOutsideApp(
  request: APIRequestContext,
  endpoints: MasEndpoints,
  refreshToken: string | undefined,
  clientId: string | undefined,
): Promise<MasTokenResponse> {
  expect(refreshToken, 'MAS issued a refresh token').toBeDefined();
  expect(clientId, 'the app sent its client id').toBeDefined();
  const response = await request.post(endpoints.token, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken as string,
      client_id: clientId as string,
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as MasTokenResponse;
}

test.describe('MAS session lifecycle', () => {
  test.skip(!mas, 'needs the opt-in MAS stack (TRINITY_E2E_MAS=1)');

  test('a refused refresh keeps the keys and signing in again reclaims the device', async ({
    page,
    authPlatform,
    request,
  }) => {
    // Up to one 60 s access-token lifetime before the refusal, plus two sign-ins.
    test.setTimeout(360_000);
    const account = await registerMasUser(
      masAccount(),
      `mas-refused-${testResourceId('run')}`,
    );
    const userId = `@${account.user}:${account.serverName}`;
    const endpoints = await masEndpoints(request, account);
    const traffic = trackMasTraffic(page, account, endpoints);
    const ownStores = async (): Promise<string[]> =>
      (await databaseNames(page))
        .filter((name) => name.includes(userId))
        .sort();

    await signInWithMas(page, authPlatform, account);
    await expect
      .poll(async () => (await ownStores()).length)
      .toBeGreaterThanOrEqual(2);
    const deviceBefore = (
      await whoami(request, account, await traffic.latestAccessToken())
    ).device_id;
    const storesBefore = await ownStores();

    // Revoking the refresh token ends the session at MAS, so the app's next refresh is refused.
    expect(traffic.clientId, 'the app sent its client id').toBeDefined();
    const revoked = await request.post(endpoints.revocation, {
      form: {
        token: traffic.tokenResponses.at(-1)?.refresh_token ?? '',
        token_type_hint: 'refresh_token',
        client_id: traffic.clientId as string,
      },
    });
    expect(revoked.ok()).toBe(true);

    await expect(page).toHaveURL(/\/login\?reauth=/, { timeout: 150_000 });
    // A soft logout: no store was deleted and the account record is still there.
    expect(await ownStores()).toEqual(storesBefore);
    expect(
      await page.evaluate(() =>
        localStorage.getItem('CapacitorStorage.matrix.accounts'),
      ),
    ).toContain(userId);
    await expect(page.getByTestId('remove-reauth-account')).toBeVisible();

    await completeMasSignIn(page, authPlatform, account);
    await waitForRooms(page, 60_000);

    // Signing in again must land on the same device, or the kept keys would not match it.
    const accessToken = await traffic.latestAccessToken();
    expect((await whoami(request, account, accessToken)).device_id).toBe(
      deviceBefore,
    );
    const query = await request.post(
      `${account.hs}/_matrix/client/v3/keys/query`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        data: { device_keys: { [userId]: [] } },
      },
    );
    expect(query.ok()).toBe(true);
    const body = (await query.json()) as {
      device_keys: Record<string, Record<string, unknown>>;
    };
    expect(body.device_keys[userId]?.[deviceBefore]).toBeDefined();
    expect(await ownStores()).toEqual(storesBefore);
  });

  test('a rotation outside the app never wipes the account', async ({
    page,
    authPlatform,
    request,
  }) => {
    // Two 60 s access-token lifetimes: the tolerated refresh, then the refused one.
    test.setTimeout(420_000);
    const account = await registerMasUser(
      masAccount(),
      `mas-rotated-${testResourceId('run')}`,
    );
    const userId = `@${account.user}:${account.serverName}`;
    const endpoints = await masEndpoints(request, account);
    const traffic = trackMasTraffic(page, account, endpoints);
    const ownStores = async (): Promise<string[]> =>
      (await databaseNames(page))
        .filter((name) => name.includes(userId))
        .sort();

    await signInWithMas(page, authPlatform, account);
    await expect
      .poll(async () => (await ownStores()).length)
      .toBeGreaterThanOrEqual(2);
    const storesBefore = await ownStores();

    // Tolerated: the new pair stays unused, so MAS still accepts the app's refresh.
    await rotateOutsideApp(
      request,
      endpoints,
      traffic.tokenResponses.at(-1)?.refresh_token,
      traffic.clientId,
    );
    await expect
      .poll(() => traffic.refreshGrants.length, {
        timeout: 150_000,
        intervals: [5_000],
      })
      .toBeGreaterThanOrEqual(1);
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
    expect(await ownStores()).toEqual(storesBefore);
    await expect(page).toHaveURL(/\/rooms/);

    // Not tolerated: the other process uses its new access token, so the refresh token
    // the app holds is spent for good and the app's next refresh is refused.
    const outside = await rotateOutsideApp(
      request,
      endpoints,
      traffic.tokenResponses.at(-1)?.refresh_token,
      traffic.clientId,
    );
    expect(await whoamiStatus(request, account, outside.access_token)).toBe(
      200,
    );
    await expect(page).toHaveURL(/\/login\?reauth=/, { timeout: 150_000 });
    expect(await ownStores()).toEqual(storesBefore);
  });

  test('signs in through MAS with the authorization-code flow', async ({
    page,
    authPlatform,
    request,
  }) => {
    const account = masAccount();
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
    const account = masAccount();
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
    // The token that must be refused later starts out valid.
    expect(
      await whoamiStatus(request, account, await traffic.latestAccessToken()),
    ).toBe(200);
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
    // The code exchange and both refreshes answered; the grants are only requests so far.
    await expect
      .poll(() => traffic.tokenResponses.length)
      .toBeGreaterThanOrEqual(3);

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
    // …while the app keeps syncing with the second refreshed one.
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

  test('keeps the session and its keys while discovery briefly fails during a refresh', async ({
    page,
    authPlatform,
    request,
  }) => {
    // One 60 s MAS access-token lifetime, the refused attempts, then the recovery.
    test.setTimeout(300_000);
    const account = masAccount();
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

    // The first refresh discovers the provider through auth_metadata. Answer it with a
    // temporary 503 and a Matrix-style JSON body, which used to end the session.
    const discovery = `${account.hs}/_matrix/client/v1/auth_metadata`;
    let refused = 0;
    const syncsBeforeOutage = traffic.syncs.length;
    await page.route(discovery, (route) => {
      refused += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'Unavailable' }),
      });
    });
    // The expired token is refused on /sync, which starts the refresh that meets the outage.
    // Other callers of auth_metadata (account management) cannot satisfy these three.
    await expect
      .poll(
        () =>
          traffic.syncs
            .slice(syncsBeforeOutage)
            .some((sync) => sync.status === 401),
        { timeout: 150_000, intervals: [2_000] },
      )
      .toBe(true);
    await expect.poll(() => refused).toBeGreaterThanOrEqual(1);
    // Discovery failed, so the refresh never reached the token endpoint.
    expect(traffic.refreshGrants).toHaveLength(0);
    await page.unroute(discovery);

    // Discovery is back: the next attempt refreshes, and the app keeps syncing on it.
    await expect
      .poll(() => traffic.refreshGrants.length, {
        timeout: 90_000,
        intervals: [2_000],
      })
      .toBeGreaterThanOrEqual(1);
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
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${account.user}:`,
    );
    expect(await ownStores()).toEqual(storesBefore);
  });

  test('signs out with one revocation and forgets only that account', async ({
    page,
    authPlatform,
    request,
  }) => {
    const account = masAccount();
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
    // Valid until the sign-out ends the session.
    expect(await whoamiStatus(request, account, accessToken)).toBe(200);
    await expect
      .poll(
        async () =>
          (await databaseNames(page)).filter((n) => n.includes(userId)).length,
      )
      .toBeGreaterThanOrEqual(2);

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();
    // The MAS account has no key backup, so the removal offers the key export first.
    await page.getByRole('button', { name: 'Remove anyway' }).click();

    // The password account survives and takes over; the switcher no longer lists MAS's.
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${session.user}:`,
    );
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
    await expect(page.getByTestId('account-row')).not.toContainText(userId);
    await page.keyboard.press('Escape');

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

    // One revocation pass, by matrix-js-sdk's logout(): each token once, and no
    // POST /logout. Read last, so a late second pass would be counted too.
    expect([...traffic.revocations].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    expect(traffic.logoutCalls).toEqual([]);
  });

  test('factory reset completes for a MAS account and ends its session', async ({
    page,
    authPlatform,
    request,
  }) => {
    const account = masAccount();
    const userId = `@${account.user}:${account.serverName}`;
    const traffic = trackMasTraffic(
      page,
      account,
      await masEndpoints(request, account),
    );
    await signInWithMas(page, authPlatform, account);
    const accessToken = await traffic.latestAccessToken();
    // Valid until the reset ends the session.
    expect(await whoamiStatus(request, account, accessToken)).toBe(200);
    await expect
      .poll(
        async () =>
          (await databaseNames(page)).filter((n) => n.includes(userId)).length,
      )
      .toBeGreaterThanOrEqual(2);

    // From ?add, reached inside the running app, so the client is live and holds its
    // databases open when the reset runs. A page.goto loads a fresh document whose client
    // may not have restarted yet, which leaves signOutAll nothing to sign out.
    await openAddAccount(page);
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
    await expect
      .poll(() => whoamiStatus(request, account, accessToken), {
        timeout: 30_000,
      })
      .toBe(401);
    // The reset revokes through both of its steps before the wipe: the SDK's
    // logout(true) in signOutAll, and Trinity's own revokeProviderSession. Each revokes
    // the access and the refresh token; MAS answers the second pass with an RFC 7009
    // no-op 200. Neither sends POST /logout.
    expect([...traffic.revocations].sort()).toEqual([
      'access_token',
      'access_token',
      'refresh_token',
      'refresh_token',
    ]);
    expect(traffic.logoutCalls).toEqual([]);
  });
});

/** Settings › Account on a server whose provider owns the account. */
async function openProviderDeletion(page: Page): Promise<void> {
  await openSettingsSection(page, 'account');
  await expect(page.getByTestId('delete-account-provider')).toBeVisible({
    timeout: 30_000,
  });
  // OAuth 2.0 aware clients must not offer the legacy password and deletion forms.
  await expect(page.getByTestId('change-password')).toHaveCount(0);
  await expect(page.getByTestId('delete-account')).toHaveCount(0);
}

test.describe('MAS account deletion', () => {
  test.skip(!mas, 'needs the opt-in MAS stack (TRINITY_E2E_MAS=1)');

  test('deletes the account on the provider page and removes it here', async ({
    page,
    authPlatform,
  }) => {
    test.setTimeout(300_000);
    const account = await registerMasUser(
      masAccount(),
      `mas-delete-${testResourceId('run')}`,
    );
    const userId = `@${account.user}:${account.serverName}`;
    await signInWithMas(page, authPlatform, account);
    await openProviderDeletion(page);

    const [provider] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByTestId('delete-account-provider').click(),
    ]);
    await provider.waitForLoadState('domcontentloaded');
    // MAS 1.26 advertises no account_deactivate action and rejects unknown ones, so the
    // app opens the bare account page, whose home holds Delete account.
    expect(new URL(provider.url()).searchParams.has('action')).toBe(false);
    await provider
      .getByRole('button', { name: 'Delete account' })
      .first()
      .click({ timeout: 30_000 });
    const dialog = provider.getByRole('dialog');
    const password = dialog.locator('input[type="password"]');
    if ((await password.count()) > 0) {
      await password.fill(account.pass);
    } else {
      await dialog.getByRole('textbox').first().fill(userId);
    }
    // Closing the tab before MAS answers would cancel the deactivation itself.
    const deactivated = provider.waitForResponse(
      (response) =>
        response.url().endsWith('/graphql') &&
        /deactivate/iu.test(response.request().postData() ?? ''),
    );
    await dialog.getByRole('button', { name: 'Delete account' }).click();
    expect((await deactivated).ok()).toBe(true);

    // MAS revokes the session; the app notices on its own, or on Check now.
    const checkNow = page.getByTestId('delete-account-check-now');
    await expect
      .poll(
        async () => {
          if (new URL(page.url()).pathname === '/login') return true;
          if (await checkNow.isEnabled().catch(() => false)) {
            await checkNow.click().catch(() => undefined);
          }
          return false;
        },
        { timeout: 180_000, intervals: [5_000] },
      )
      .toBe(true);
    await expect(page.getByTestId('login-account-deleted')).toHaveText(
      `Your account ${userId} was deleted.`,
    );
  });
});
