import { browser, expect } from '@wdio/globals';
import { randomBytes } from 'node:crypto';
import {
  registerMasUser,
  type MasAccount,
} from '../../support/mas-account.mts';
import { resolveMasEnabled } from '../../support/homeserver/kind.mts';
import { readSession } from '../../support/session.mts';
import {
  fillByLabel,
  tap,
  waitForDurableActiveAccount,
  waitForRooms,
} from '../support/app.mts';
import {
  accessTokenDigest,
  accountDatabases,
  documentNow,
  homeserverStatusesSince,
  jsStoreHasRefreshToken,
  masTokenPair,
  overwriteJsAccessToken,
  recordRequests,
  revokeSessionAtMas,
  seedAccountFromOlderBuild,
  settleOnRooms,
  signInOnProviderPage,
  storedAccount,
  tokenEndpointRequests,
  vaultAnswer,
  waitForAppSync,
  waitForVaultTokenLife,
  whoamiWithVaultToken,
  type StoredAccount,
} from '../support/mas.mts';
import { onlyOn } from '../support/platform.mts';
import { resetApp, restartApp } from '../support/session.mts';

// A real OAuth account through the whole app on Android, against a real MAS, whose token grants
// come from native code: the browser journeys run on web, which has no vault. Opt-in:
// TRINITY_E2E_MAS=1 adds the stack and prepares the emulator (e2e/mobile/run.mts). MAS's access
// tokens live 60 s, so each refresh below takes about a minute.

/** Up to one 60 s token lifetime, one /sync long poll (30 s) and the retry after it. */
const REFRESH_TIMEOUT_MS = 180_000;

const freshAccount = async (prefix: string): Promise<MasAccount> => {
  const mas = readSession().homeserver?.mas;
  if (!mas) throw new Error('the MAS stack is not running');
  return registerMasUser(mas, `${prefix}-${randomBytes(4).toString('hex')}`);
};

/** Wait for native to replace the access token whose digest is `before`. */
async function refreshedFrom(
  account: StoredAccount,
  before: string | undefined,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const { kind, accessTokenDigest: digest } = await vaultAnswer(account);
      return kind === 'current' && digest !== before;
    },
    {
      timeout: REFRESH_TIMEOUT_MS,
      interval: 5_000,
      timeoutMsg: 'the vault never showed a new access token',
    },
  );
}

async function expectSignedInFromVault(account: StoredAccount): Promise<void> {
  expect(await vaultAnswer(account)).toEqual(
    expect.objectContaining({ kind: 'current' }),
  );
  expect(await jsStoreHasRefreshToken(account.userId)).toBe(false);
  expect(await whoamiWithVaultToken(account)).toEqual({
    status: 200,
    userId: account.userId,
    deviceId: account.deviceId,
  });
}

describe('an OAuth account through the native token vault', () => {
  let provider: MasAccount | undefined;
  let signedIn: StoredAccount | undefined;

  const signedInAccount = (test: Mocha.Context): StoredAccount => {
    if (!signedIn) test.skip();
    return signedIn as StoredAccount;
  };

  before(function skipWithoutMas(this: Mocha.Context) {
    onlyOn(
      'android',
      'iOS has no CI runner that can run the MAS stack, and this drives Custom Tabs',
    ).call(this);
    if (!readSession().homeserver?.mas) {
      // A run that asked for the stack must not go green with no test run.
      if (resolveMasEnabled()) {
        throw new Error(
          'TRINITY_E2E_MAS=1, but the E2E session has no MAS account',
        );
      }
      console.log(
        `[mobile] skipped: ${this.test?.parent?.fullTitle() ?? ''} — needs the MAS stack (TRINITY_E2E_MAS=1)`,
      );
      this.skip();
    }
  });

  it('signs a fresh account in on the provider page, and the vault owns its tokens', async function (this: Mocha.Context) {
    this.timeout(300_000);
    await resetApp();
    await recordRequests();
    provider = await freshAccount('android-mas');

    await fillByLabel('Homeserver', provider.hs);
    await tap('//button[normalize-space()="Continue"]');
    await signInOnProviderPage(provider);
    await settleOnRooms();

    const account = await storedAccount();
    expect(account.userId).toBe(`@${provider.user}:${provider.serverName}`);
    await expectSignedInFromVault(account);
    // The code exchange is the app's own, in JS.
    expect(await tokenEndpointRequests(account.tokenEndpoint)).toBe(1);
    signedIn = account;
  });

  it('stays signed in through a refresh that native code made', async function (this: Mocha.Context) {
    this.timeout(REFRESH_TIMEOUT_MS + 150_000);
    const account = signedInAccount(this);
    const before = await vaultAnswer(account);

    await refreshedFrom(account, before.accessTokenDigest);
    const rotated = await documentNow();

    expect((await vaultAnswer(account)).accessTokenExpiresAt).toBeGreaterThan(
      before.accessTokenExpiresAt ?? 0,
    );
    await expectSignedInFromVault(account);
    // Only the code exchange: no refresh grant left the WebView.
    expect(await tokenEndpointRequests(account.tokenEndpoint)).toBe(1);
    // The vault's token works, and the app's own client took it up.
    await waitForAppSync(account, rotated);
    await settleOnRooms(10_000);
  });

  it('starts signed in from the vault after a restart', async function (this: Mocha.Context) {
    this.timeout(420_000);
    const account = signedInAccount(this);
    await waitForDurableActiveAccount(account.userId);
    // Enough life left that the digest below can only change if the start refused its token.
    await waitForVaultTokenLife(account, 40_000);
    const { accessTokenDigest: before } = await vaultAnswer(account);
    await overwriteJsAccessToken(account.userId);

    await restartApp();
    await recordRequests();
    await waitForRooms(90_000);
    await waitForAppSync(account, 0);

    expect((await vaultAnswer(account)).accessTokenDigest).toBe(before);
    await expectSignedInFromVault(account);
    expect(await tokenEndpointRequests(account.tokenEndpoint)).toBe(0);
  });

  it('keeps everything when MAS ends the session, and moves the account to a new device', async function (this: Mocha.Context) {
    this.timeout(720_000);
    const account = signedInAccount(this);
    const stores = await accountDatabases(account.userId);
    expect(stores.length).toBeGreaterThanOrEqual(2);
    const expectUntouched = async (): Promise<void> => {
      const stored = await storedAccount();
      expect(stored.userId).toBe(account.userId);
      expect(stored.deviceId).toBe(account.deviceId);
      expect(stored.lineage).toBe(account.lineage);
      expect(await accountDatabases(account.userId)).toEqual(
        expect.arrayContaining(stores),
      );
    };

    await waitForVaultTokenLife(account, 15_000);
    const revoked = await documentNow();
    expect(await revokeSessionAtMas(account)).toBe(200);

    await browser.waitUntil(
      async () => new URL(await browser.getUrl()).searchParams.has('reauth'),
      {
        timeout: REFRESH_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: 'the app never reached the re-auth page',
      },
    );
    expect(new URL(await browser.getUrl()).searchParams.has('device')).toBe(
      false,
    );
    // MAS answers 200 for a dead token too: this is what shows the revocation took.
    expect(await homeserverStatusesSince(account.baseUrl, revoked)).toContain(
      401,
    );
    await expectUntouched();

    // The first sign-in finds the device without keys: it saves nothing and moves on.
    await signInOnProviderPage(provider as MasAccount);
    await browser.waitUntil(
      async () =>
        new URL(await browser.getUrl()).searchParams.get('device') === 'new',
      {
        timeout: 60_000,
        timeoutMsg: 'the device check never offered a new device',
      },
    );
    await expectUntouched();

    // Nothing is live to check for a key backup, so replacing the old device asks first.
    await signInOnProviderPage(provider as MasAccount);
    const replace = $('[data-testid="alert-confirm"]');
    await expect(replace).toBeDisplayed({ wait: 60_000 });
    await replace.click();
    await settleOnRooms();

    const moved = await storedAccount();
    expect(moved.userId).toBe(account.userId);
    expect(moved.deviceId).not.toBe(account.deviceId);
    expect(moved.lineage).not.toBe(account.lineage);
    await expectSignedInFromVault(moved);
    expect(await vaultAnswer(account)).toEqual({ kind: 'gone' });
  });

  it('moves an older build’s tokens into the vault and refreshes them there', async function (this: Mocha.Context) {
    this.timeout(480_000);
    await resetApp();
    const older = await freshAccount('android-mas-upgrade');
    const pair = await masTokenPair(older);
    const lineage = await seedAccountFromOlderBuild(older, pair);
    const seeded = await storedAccount();
    expect(seeded.lineage).toBe(lineage);
    expect(await jsStoreHasRefreshToken(seeded.userId)).toBe(true);
    expect(await vaultAnswer(seeded)).toEqual({ kind: 'gone' });
    await waitForDurableActiveAccount(seeded.userId);

    await restartApp();
    await recordRequests();
    await waitForRooms(90_000);

    // The vault answers for the seeded lineage. A slow start may already have rotated the
    // 60 s token, so the digest is not compared here.
    await expectSignedInFromVault(seeded);

    await refreshedFrom(seeded, accessTokenDigest(pair.accessToken));
    const rotated = await documentNow();
    await expectSignedInFromVault(seeded);
    await waitForAppSync(seeded, rotated);
    expect(await tokenEndpointRequests(seeded.tokenEndpoint)).toBe(0);
    expect((await storedAccount()).lineage).toBe(lineage);
    await settleOnRooms(10_000);
  });
});
