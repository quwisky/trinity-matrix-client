import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { browser, expect } from '@wdio/globals';
import type { MasAccount } from '../../support/mas-account.mts';
import {
  APP_PACKAGE,
  keyboardShown,
  native,
  shell,
  webview,
} from './session.mts';

/** The app registers this on Android, and MAS redirects to it with the code. */
const REDIRECT_URI = 'dev.trinityproject.trinity:/sso-callback';
/** The default key prefix of @aparajita/capacitor-secure-storage. */
const SECURE_KEY_PREFIX = 'capacitor-storage_';
const REGISTRY_KEY = 'matrix.accounts';
const refreshTokenKey = (userId: string): string =>
  `matrix.refreshToken:${userId}`;

/** A registry record's non-secret fields, all a test needs to call the plugin for it. */
export interface StoredAccount {
  readonly baseUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly lineage: string;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
}

/** The vault's answer. The access token stays on the device: only its digest comes back. */
export interface VaultAnswer {
  readonly kind: string;
  readonly accessTokenDigest?: string;
  readonly accessTokenExpiresAt?: number;
}

export interface WhoAmI {
  readonly status: number;
  readonly userId?: string;
  readonly deviceId?: string;
}

/** A token pair from MAS, in memory on the host only until it is seeded and never printed. */
export interface MasTokenPair {
  readonly clientId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly issuer: string;
}

interface AppWindow {
  Capacitor: {
    Plugins: {
      PushHandoff: {
        currentTokens(options: { userId: string; lineage: string }): Promise<{
          kind: string;
          accessToken?: string;
          accessTokenExpiresAt?: number;
        }>;
      };
      Preferences: {
        get(options: { key: string }): Promise<{ value: string | null }>;
        set(options: { key: string; value: string }): Promise<void>;
      };
      SecureStorage: {
        get(key: string, convertDate: boolean, sync: boolean): Promise<unknown>;
        set(
          key: string,
          value: string,
          convertDate: boolean,
          sync: boolean,
        ): Promise<void>;
      };
    };
  };
}

/** The app's only stored account. Run in the WebView context. */
export async function storedAccount(): Promise<StoredAccount> {
  const account = await browser.execute(
    async (key: string): Promise<StoredAccount | null> => {
      const { Preferences } = (window as unknown as AppWindow).Capacitor
        .Plugins;
      const { value } = await Preferences.get({ key });
      const record = (
        JSON.parse(value ?? '{"accounts":[]}') as {
          accounts: (Omit<
            StoredAccount,
            'clientId' | 'tokenEndpoint' | 'revocationEndpoint'
          > & {
            oidc: Pick<
              StoredAccount,
              'clientId' | 'tokenEndpoint' | 'revocationEndpoint'
            >;
          })[];
        }
      ).accounts[0];
      return record
        ? {
            baseUrl: record.baseUrl,
            userId: record.userId,
            deviceId: record.deviceId,
            lineage: record.lineage,
            clientId: record.oidc.clientId,
            tokenEndpoint: record.oidc.tokenEndpoint,
            revocationEndpoint: record.oidc.revocationEndpoint,
          }
        : null;
    },
    REGISTRY_KEY,
  );
  if (!account) throw new Error('the app has no stored account');
  return account;
}

/** What `PushHandoff.currentTokens` answers. Run in the WebView context. */
export function vaultAnswer(
  account: Pick<StoredAccount, 'userId' | 'lineage'>,
): Promise<VaultAnswer> {
  return browser.execute(
    async (userId: string, lineage: string): Promise<VaultAnswer> => {
      const { PushHandoff } = (window as unknown as AppWindow).Capacitor
        .Plugins;
      const answer = await PushHandoff.currentTokens({ userId, lineage });
      if (!answer.accessToken) return { kind: answer.kind };
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(answer.accessToken),
      );
      return {
        kind: answer.kind,
        accessTokenDigest: btoa(String.fromCharCode(...new Uint8Array(digest))),
        accessTokenExpiresAt: answer.accessTokenExpiresAt,
      };
    },
    account.userId,
    account.lineage,
  );
}

/** {@link VaultAnswer.accessTokenDigest} of a token the host holds. */
export const accessTokenDigest = (accessToken: string): string =>
  createHash('sha256').update(accessToken).digest('base64');

/** Whether the JS secure store holds a refresh token. Run in the WebView context. */
export function jsStoreHasRefreshToken(userId: string): Promise<boolean> {
  return browser.execute(async (key: string): Promise<boolean> => {
    const { SecureStorage } = (window as unknown as AppWindow).Capacitor
      .Plugins;
    return (await SecureStorage.get(key, false, false)) !== null;
  }, refreshTokenKey(userId));
}

/** Call `whoami` with the vault's access token, from the WebView, whose TLS the app uses. */
export function whoamiWithVaultToken(account: StoredAccount): Promise<WhoAmI> {
  return browser.execute(
    async (
      baseUrl: string,
      userId: string,
      lineage: string,
    ): Promise<WhoAmI> => {
      const { PushHandoff } = (window as unknown as AppWindow).Capacitor
        .Plugins;
      const { accessToken } = await PushHandoff.currentTokens({
        userId,
        lineage,
      });
      const response = await fetch(
        `${baseUrl}/_matrix/client/v3/account/whoami`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
      );
      if (!response.ok) return { status: response.status };
      const body = (await response.json()) as {
        user_id: string;
        device_id: string;
      };
      return {
        status: response.status,
        userId: body.user_id,
        deviceId: body.device_id,
      };
    },
    account.baseUrl,
    account.userId,
    account.lineage,
  );
}

/**
 * End the account's session at MAS's revocation endpoint with the vault's access token, the only
 * token native code hands out. MAS ends the whole session for either kind
 * (crates/handlers/src/oauth2/revoke.rs), so the refresh token dies too. Answers the HTTP status.
 */
export function revokeSessionAtMas(account: StoredAccount): Promise<number> {
  return browser.execute(
    async (
      userId: string,
      lineage: string,
      endpoint: string,
      clientId: string,
    ): Promise<number> => {
      const { PushHandoff } = (window as unknown as AppWindow).Capacitor
        .Plugins;
      const { accessToken } = await PushHandoff.currentTokens({
        userId,
        lineage,
      });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: accessToken ?? '',
          token_type_hint: 'access_token',
          client_id: clientId,
        }),
      });
      return response.status;
    },
    account.userId,
    account.lineage,
    account.revocationEndpoint,
    account.clientId,
  );
}

/** Keep every request of this document in Resource Timing, whose default buffer holds 250. */
export async function recordRequests(): Promise<void> {
  await browser.execute(() => performance.setResourceTimingBufferSize(10_000));
}

/**
 * How many requests this document sent to the token endpoint, whatever their outcome, read
 * after {@link recordRequests}. The WebView cannot see native's own, so a grant counted here
 * came from JS. It sees URLs and not bodies, so it counts the code exchange too.
 */
export function tokenEndpointRequests(endpoint: string): Promise<number> {
  return browser.execute(
    (url: string) => performance.getEntriesByName(url, 'resource').length,
    endpoint,
  );
}

/** Names of the IndexedDB databases that belong to an account. */
export function accountDatabases(userId: string): Promise<string[]> {
  return browser.execute(async (id: string): Promise<string[]> => {
    const databases = await indexedDB.databases();
    return databases
      .map(({ name }) => name ?? '')
      .filter((name) => name.includes(id))
      .sort();
  }, userId);
}

const PROVIDER_CONTINUE =
  '//android.widget.Button[@text="Continue" or @content-desc="Continue"]';

/** Tap the provider page's Continue, swiping up to it on a screen too short to show it. */
async function tapProviderContinue(): Promise<void> {
  const button = $(PROVIDER_CONTINUE);
  await browser.waitUntil(
    async () => {
      if (await button.isDisplayed()) return true;
      await shell('input', ['swipe', '540', '1600', '540', '800', '300']);
      return false;
    },
    {
      timeout: 60_000,
      interval: 2_000,
      timeoutMsg: 'the provider page never showed Continue',
    },
  );
  await button.click();
}

/**
 * From a page offering the provider step, sign in on MAS's real pages in the Custom Tab, read
 * through the accessibility tree: login.html and consent.html in MAS 1.28 both submit with
 * "Continue". MAS keeps its browser session in Chrome, so a later sign-in goes straight to
 * consent. Ends in the app's WebView, where the callback landed.
 */
export async function signInOnProviderPage(account: MasAccount): Promise<void> {
  const start = $('[data-testid="oidc-continue"]');
  await expect(start).toBeDisplayed({ wait: 30_000 });
  await start.click();
  await native();
  await $(PROVIDER_CONTINUE).waitForExist({ timeout: 60_000 });
  const username = $('//android.widget.EditText[@password="false"]');
  if (await username.isExisting()) {
    await username.addValue(account.user);
    await $('//android.widget.EditText[@password="true"]').addValue(
      account.pass,
    );
    if (await keyboardShown()) await browser.hideKeyboard();
    await tapProviderContinue();
    await username.waitForExist({ reverse: true, timeout: 30_000 });
  }
  await tapProviderContinue();
  await webview();
}

/** Wait for Rooms, passing the new-device check if the app shows it. */
export async function settleOnRooms(timeout = 90_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const url = new URL(await browser.getUrl());
      if (url.pathname === '/encryption/confirm') {
        const skip = $('[data-testid="device-confirmation-skip"]');
        if (await skip.isDisplayed()) await skip.click();
        return false;
      }
      return (
        url.pathname === '/rooms' &&
        (url.searchParams.get('account') ?? '') !== ''
      );
    },
    { timeout, interval: 1_000, timeoutMsg: 'sign-in never reached /rooms' },
  );
}

/** One fetch with a hand-kept cookie jar: MAS's session and CSRF live in a cookie. */
async function providerFetch(
  cookies: Map<string, string>,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      ...init.headers,
      cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [name, ...value] = (cookie.split(';')[0] ?? '').split('=');
    if (name) cookies.set(name, value.join('='));
  }
  return response;
}

/**
 * The authorization-code flow against MAS from the host, as a build older than the vault ran
 * it in the app: dynamic registration, MAS's HTML login and consent forms, code exchange.
 * Nothing of the app is involved.
 */
export async function masTokenPair(account: MasAccount): Promise<MasTokenPair> {
  const metadata = (await (
    await fetch(`${account.hs}/_matrix/client/v1/auth_metadata`)
  ).json()) as Record<string, string>;
  const endpoint = (key: string): string => {
    const value = metadata[key];
    if (!value) throw new Error(`MAS does not advertise ${key}`);
    return value;
  };
  const registration = await fetch(endpoint('registration_endpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Trinity (seeded by e2e)',
      client_uri: 'https://trinity.trinityproject.dev',
      application_type: 'native',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (!registration.ok) {
    throw new Error(`MAS refused the registration: ${registration.status}`);
  }
  const { client_id: clientId } = (await registration.json()) as {
    client_id: string;
  };

  const deviceId = randomBytes(8).toString('hex').toUpperCase();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(endpoint('authorization_endpoint'));
  authorize.search = new URLSearchParams({
    response_type: 'code',
    response_mode: 'query',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`,
    state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const cookies = new Map<string, string>();
  let url = authorize.href;
  let response = await providerFetch(cookies, url);
  let code: string | null = null;
  // A login, a consent and the redirects between them: a loop this long found no callback.
  for (let step = 0; step < 12 && code === null; step += 1) {
    const location = response.headers.get('location');
    if (location?.startsWith(REDIRECT_URI)) {
      code = new URL(location).searchParams.get('code');
    } else if (location) {
      url = new URL(location, url).href;
      response = await providerFetch(cookies, url);
    } else {
      const page = await response.text();
      const csrf = /name="csrf" value="([^"]+)"/u.exec(page)?.[1];
      if (!csrf) {
        throw new Error(
          `MAS answered ${response.status} at ${new URL(url).pathname} with no form`,
        );
      }
      response = await providerFetch(cookies, url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf,
          ...(page.includes('name="username"')
            ? { username: account.user, password: account.pass }
            : {}),
        }),
      });
    }
  }
  if (!code) throw new Error('MAS never redirected with a code');

  const exchanged = await fetch(endpoint('token_endpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!exchanged.ok) {
    throw new Error(`MAS refused the code exchange: ${exchanged.status}`);
  }
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    clientId,
    deviceId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresInSeconds: tokens.expires_in,
    tokenEndpoint: endpoint('token_endpoint'),
    revocationEndpoint: endpoint('revocation_endpoint'),
    issuer: endpoint('issuer'),
  };
}

/**
 * Write what a build older than the vault left behind, through the plugins it wrote them with:
 * the registry record as SessionStorageService saved it, both tokens and the crypto store's key
 * in the secure store, and no vault record. Answers the record's lineage once it is on disk,
 * because both stores write with `SharedPreferences.apply()`. Run in the WebView context, with
 * the app on the sign-in page, so no client is running.
 */
export async function seedAccountFromOlderBuild(
  account: MasAccount,
  pair: MasTokenPair,
): Promise<string> {
  const userId = `@${account.user}:${account.serverName}`;
  const lineage = randomUUID();
  const cryptoPrefix = `trinity-crypto:${userId}:${pair.deviceId}`;
  const secrets = {
    [`matrix.accessToken:${userId}`]: pair.accessToken,
    [refreshTokenKey(userId)]: pair.refreshToken,
    [`matrix.cryptoStoreKey:${cryptoPrefix}`]:
      randomBytes(32).toString('base64'),
  };
  const registry = {
    activeUserId: userId,
    accounts: [
      {
        baseUrl: account.hs,
        userId,
        deviceId: pair.deviceId,
        accessTokenExpiresAt: Date.now() + pair.expiresInSeconds * 1000,
        oidc: {
          issuer: pair.issuer,
          clientId: pair.clientId,
          redirectUri: REDIRECT_URI,
          tokenEndpoint: pair.tokenEndpoint,
          revocationEndpoint: pair.revocationEndpoint,
        },
        cryptoPrefix,
        cryptoStoreKeyed: true,
        lineage,
      },
    ],
  };
  await browser.execute(
    async (
      entries: Record<string, string>,
      key: string,
      value: string,
    ): Promise<void> => {
      const { Preferences, SecureStorage } = (window as unknown as AppWindow)
        .Capacitor.Plugins;
      for (const [name, secret] of Object.entries(entries)) {
        await SecureStorage.set(name, secret, false, false);
      }
      await Preferences.set({ key, value });
    },
    secrets,
    REGISTRY_KEY,
    JSON.stringify(registry),
  );
  await browser.waitUntil(
    async () => {
      const onDisk = await shell('run-as', [
        APP_PACKAGE,
        'cat',
        'shared_prefs/WSSecureStorageSharedPreferences.xml',
      ]);
      return Object.keys(secrets).every((name) =>
        onDisk.includes(`${SECURE_KEY_PREFIX}${name}`),
      );
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the seeded secrets never reached the disk',
    },
  );
  return lineage;
}
