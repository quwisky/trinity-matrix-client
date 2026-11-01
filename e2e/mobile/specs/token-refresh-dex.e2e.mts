import { browser, expect } from '@wdio/globals';
import { readSession } from '../../support/session.mts';
import { waitForDurableActiveAccount } from '../support/app.mts';
import { startOwnDex, unusedPort, type OwnDex } from '../support/own-dex.mts';
import { onlyOn } from '../support/platform.mts';
import { pluginCall } from '../support/push-handoff.mts';
import { resetApp, restartApp, webview } from '../support/session.mts';

/** What the plugin answers. Tokens never reach an `expect` value: a failure would print them. */
interface TokenAnswer {
  readonly kind: string;
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: number;
}

const ROTATED_ACCOUNT = '@token-refresh-rotated:token.test';
const REFUSED_ACCOUNT = '@token-refresh-refused:token.test';
const OFFLINE_ACCOUNT = '@token-refresh-offline:token.test';
/** In no registry, so a launch sweep removes its record. */
const UNLISTED_ACCOUNT = '@token-refresh-unlisted:token.test';
const REGISTERED_ACCOUNTS = [ROTATED_ACCOUNT, REFUSED_ACCOUNT, OFFLINE_ACCOUNT];
const LINEAGE = 'token-refresh-dex';
const DEVICE_ID = 'TOKENREFRESH';
const REGISTRY_KEY = 'matrix.accounts';

/**
 * The registry as the app leaves OAuth accounts that must sign back in: a binding and no tokens.
 * The launch sweep keeps their vault records, and restoring one opens its re-auth page without
 * starting a client, so nothing in JS can refresh behind the spec: a record it had rotated would
 * answer `current` to the access token the spec holds.
 */
const registry = (dex: OwnDex): string =>
  JSON.stringify({
    activeUserId: ROTATED_ACCOUNT,
    accounts: REGISTERED_ACCOUNTS.map((userId) => ({
      baseUrl: 'https://unreachable.invalid',
      userId,
      deviceId: DEVICE_ID,
      lineage: LINEAGE,
      oidc: {
        issuer: dex.issuer,
        clientId: dex.clientId,
        tokenEndpoint: dex.tokenEndpoint,
      },
    })),
  });

const refreshTokens = (userId: string, tokenSeen: string) =>
  pluginCall('PushHandoff', 'refreshTokens', {
    userId,
    lineage: LINEAGE,
    tokenSeen,
  }) as Promise<TokenAnswer>;

const currentTokens = (userId: string) =>
  pluginCall('PushHandoff', 'currentTokens', {
    userId,
    lineage: LINEAGE,
  }) as Promise<TokenAnswer>;

/** The fields a rotation answers with; a refresh token, or `unsaved`, would add one. */
const ROTATED_FIELDS = ['accessToken', 'accessTokenExpiresAt', 'kind'];

function expectRotated(answer: TokenAnswer): void {
  expect(answer.kind).toBe('rotated');
  expect(Object.keys(answer).sort()).toEqual(ROTATED_FIELDS);
  expect((answer.accessTokenExpiresAt ?? 0) > Date.now()).toBe(true);
}

describe('native token refresh against Dex', () => {
  let dex: OwnDex | undefined;
  /** Spent by the first test, and the refused grant's token after it. */
  let spentRefreshToken = '';

  const migrate = async (
    userId: string,
    accessToken: string,
    refreshToken: string,
    tokenEndpoint: string,
  ): Promise<void> => {
    expect(
      await pluginCall('PushHandoff', 'migrateTokens', {
        userId,
        lineage: LINEAGE,
        accessToken,
        refreshToken,
        tokenEndpoint,
        clientId: dex?.clientId,
        deviceId: DEVICE_ID,
      }),
    ).toEqual({ stored: true });
  };

  const removeAll = async (): Promise<void> => {
    for (const userId of [...REGISTERED_ACCOUNTS, UNLISTED_ACCOUNT]) {
      await pluginCall('PushHandoff', 'removeTokens', { userId });
    }
  };

  before(async function (this: Mocha.Context) {
    onlyOn(
      'ios',
      "Mobile E2E's only Dex is Docker's, whose 2.46.1 hangs on a refresh grant (dexidp/dex#5017)",
    ).call(this);
    if (!readSession().homeserver?.sso) {
      console.log(
        `[mobile] skipped: ${this.test?.parent?.fullTitle() ?? ''} — no dex on PATH, so no provider to grant tokens`,
      );
      this.skip();
    }
    dex = await startOwnDex();
    await resetApp();
    await pluginCall('Preferences', 'set', {
      key: REGISTRY_KEY,
      value: registry(dex),
    });
    await waitForDurableActiveAccount(ROTATED_ACCOUNT);
    // The first launch's sweep may still be running, on a list that names nobody. From this one
    // on, the sweep keeps every record the tests store, whenever it runs.
    await restartApp();
    // A run that died keeps its records in the keychain, and a record of this lineage is not
    // overwritten by a migration.
    await removeAll();
  });

  // A failed test leaves the session in the native context, where a call cannot reach the plugin.
  beforeEach(() => webview());

  after(async () => {
    if (!dex) return;
    dex.stop();
    await webview();
    await removeAll();
    await pluginCall('Preferences', 'remove', { key: REGISTRY_KEY });
    for (const userId of [...REGISTERED_ACCOUNTS, UNLISTED_ACCOUNT]) {
      expect((await currentTokens(userId)).kind).toBe('gone');
    }
  });

  it('rotates through the keychain, across a restart', async () => {
    if (!dex) throw new Error('Dex did not start');
    const minted = await dex.mint();
    // Proves the grant Node sends is one Dex takes, so its refusal below means the token.
    const control = await dex.refresh(minted.refreshToken);
    expect(control.status).toBe(200);
    const first = control.tokens;
    if (!first)
      throw new Error('Dex answered the control grant with no tokens');
    await migrate(
      ROTATED_ACCOUNT,
      first.accessToken,
      first.refreshToken,
      dex.tokenEndpoint,
    );
    // Dex's tokens carry whole seconds: two in one second can be the same bytes.
    await browser.pause(1_100);

    const rotated = await refreshTokens(ROTATED_ACCOUNT, first.accessToken);
    expectRotated(rotated);
    expect(rotated.accessToken !== first.accessToken).toBe(true);

    // Fails if the app never sent the grant: only a grant spends this token.
    const replay = await dex.refresh(first.refreshToken);
    expect(replay.status).toBe(400);
    expect(replay.error).toBe('invalid_grant');
    spentRefreshToken = first.refreshToken;

    await migrate(
      UNLISTED_ACCOUNT,
      'unlisted-access-token',
      'unlisted-refresh-token',
      dex.tokenEndpoint,
    );
    await browser.pause(1_100);
    await restartApp();
    // Its going says the launch sweep has run, so the record below survived one.
    await browser.waitUntil(
      async () => (await currentTokens(UNLISTED_ACCOUNT)).kind === 'gone',
      { timeout: 30_000, timeoutMsg: 'the launch sweep never ran' },
    );

    // Fails if the record did not survive (`gone`), or holds a spent refresh token (`refused`).
    const again = await refreshTokens(
      ROTATED_ACCOUNT,
      rotated.accessToken ?? '',
    );
    expectRotated(again);
    expect(again.accessToken !== rotated.accessToken).toBe(true);
  });

  it('answers refused for a refresh token Dex has spent, and keeps answering it', async () => {
    if (!dex || !spentRefreshToken)
      throw new Error('The rotation test did not spend a token');
    await migrate(
      REFUSED_ACCOUNT,
      'refused-access-token',
      spentRefreshToken,
      dex.tokenEndpoint,
    );

    expect(
      await refreshTokens(REFUSED_ACCOUNT, 'refused-access-token'),
    ).toEqual({ kind: 'refused' });
    // No access token: the record is marked, and nothing it holds may be used again.
    expect(await currentTokens(REFUSED_ACCOUNT)).toEqual({ kind: 'refused' });
  });

  it('answers transient when nothing listens, and keeps the record', async () => {
    if (!dex) throw new Error('Dex did not start');
    const endpoint = new URL(dex.tokenEndpoint);
    endpoint.port = String(await unusedPort());
    await migrate(
      OFFLINE_ACCOUNT,
      'offline-access-token',
      'offline-refresh-token',
      endpoint.href,
    );

    expect(
      await refreshTokens(OFFLINE_ACCOUNT, 'offline-access-token'),
    ).toEqual({ kind: 'transient' });
    expect(await currentTokens(OFFLINE_ACCOUNT)).toEqual({
      kind: 'current',
      accessToken: 'offline-access-token',
    });
  });
});
