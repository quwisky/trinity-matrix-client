import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountViewportProfile,
} from './account-workspace-client.mts';
import {
  legacySsoAssertions as assertions,
  LEGACY_SSO_SOURCES,
  type LegacySsoAssertion,
} from './legacy-sso-contract.mts';
import {
  openLegacySsoProvider,
  type LegacySsoProvider,
} from './legacy-sso-provider.mts';
import {
  openMaestroDevice,
  redactMaestroArtifacts,
  type MaestroDevice,
} from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const TRINITY_PACKAGE = 'eu.qwky.trinity';
const TOKEN_LOGIN_PATH = '/_matrix/client/v3/login';
const VERIFICATION_ERROR =
  'This sign-in could not be verified. Please sign in again.';

interface SsoIdentity {
  readonly user: string;
  readonly email: string;
  readonly pass: string;
}

interface TokenLoginObserver {
  readonly count: number;
  close(): Promise<void>;
}

interface RedeemedSession {
  readonly status: 200;
  readonly userId: string;
  readonly accessToken: string;
}

interface LegacySsoCaseContext {
  readonly client: AccountWorkspaceClient;
  readonly device: MaestroDevice;
  readonly homeserver: string;
  readonly applicationOrigin: string;
  readonly sso: SsoIdentity;
  readonly secrets: Record<string, string>;
  readonly resources: MatrixTestResources;
  readonly signal: AbortSignal;
}

interface LegacySsoCase {
  readonly id: string;
  readonly source: string;
  readonly profile: AccountViewportProfile;
  run(context: LegacySsoCaseContext): Promise<void>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
}

function requestMetadata(
  value: Readonly<Record<string, unknown>>,
):
  | { readonly method: string; readonly requestId: string; readonly url: URL }
  | undefined {
  const requestId = value['requestId'];
  const request = value['request'];
  if (
    typeof requestId !== 'string' ||
    !request ||
    typeof request !== 'object'
  ) {
    return undefined;
  }
  const method = (request as { readonly method?: unknown }).method;
  const rawUrl = (request as { readonly url?: unknown }).url;
  if (typeof method !== 'string' || typeof rawUrl !== 'string') return undefined;
  try {
    return { method, requestId, url: new URL(rawUrl) };
  } catch {
    return undefined;
  }
}

async function closeNetworkConnection(
  connection: DevtoolsEventConnection,
  unsubscribes: readonly (() => void)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const unsubscribe of unsubscribes) {
    try {
      unsubscribe();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await connection.send('Network.disable');
  } catch (error) {
    failures.push(error);
  }
  try {
    connection.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, 'SSO network observer cleanup failed');
  }
}

async function armTokenLoginObserver(
  client: AccountWorkspaceClient,
  homeserver: string,
): Promise<TokenLoginObserver> {
  const connection = await client.webview.openSession();
  const origin = new URL(homeserver).origin;
  let appTokenLoginRequests = 0;
  let closed = false;
  const unsubscribe = connection.on('Network.requestWillBeSent', (value) => {
    const request = requestMetadata(value);
    if (
      request?.method === 'POST' &&
      request.url.origin === origin &&
      request.url.pathname === TOKEN_LOGIN_PATH
    ) {
      appTokenLoginRequests += 1;
    }
  });
  try {
    await connection.send('Network.enable');
  } catch (error) {
    await closeNetworkConnection(connection, [unsubscribe]).catch(
      () => undefined,
    );
    throw error;
  }
  return {
    get count() {
      return appTokenLoginRequests;
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeNetworkConnection(connection, [unsubscribe]);
    },
  };
}

async function mintUnspentLoginToken(
  homeserver: string,
  applicationOrigin: string,
  sso: SsoIdentity,
  signal: AbortSignal,
): Promise<string> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let operationFailure: unknown;
  let token: string | undefined;
  try {
    const executablePath = process.env['TRINITY_CHROME_BINARY'];
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
    });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const captured: { token: string | null } = { token: null };
    page.on('request', (request) => {
      const match = /[?&]loginToken=([^&]+)/u.exec(request.url());
      if (match?.[1]) captured.token = decodeURIComponent(match[1]);
    });
    const redirectUrl = encodeURIComponent(
      new URL('/sso-harness-callback', applicationOrigin).href,
    );
    await page.goto(
      `${homeserver}/_matrix/client/v3/login/sso/redirect?redirectUrl=${redirectUrl}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.locator('#login').fill(sso.email);
    await page.locator('#password').fill(sso.pass);
    await page.locator('#submit-login').click();
    const observedToken = await waitForNativeShellState(
      async () => captured.token,
      (value): value is string => typeof value === 'string' && value.length > 0,
      'isolated fixture SSO login token',
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      60_000,
    );
    assert(observedToken, 'Isolated SSO fixture captured a non-empty token');
    token = observedToken;
  } catch (error) {
    operationFailure = error;
  } finally {
    const failures: unknown[] = [];
    try {
      await context?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    if (operationFailure !== undefined) failures.unshift(operationFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Isolated SSO token fixture and cleanup failed',
      );
    }
  }
  assert(token, 'Isolated SSO fixture produced an unspent login token');
  return token;
}

async function redeemLoginToken(
  homeserver: string,
  loginToken: string,
  signal: AbortSignal,
): Promise<RedeemedSession> {
  const response = await fetch(`${homeserver}${TOKEN_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.token', token: loginToken }),
    signal: requestSignal(signal),
  });
  assert.equal(response.status, 200, 'Independent SSO token redemption status');
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof body['user_id'], 'string');
  assert.equal(typeof body['access_token'], 'string');
  return {
    status: 200,
    userId: body['user_id'] as string,
    accessToken: body['access_token'] as string,
  };
}

async function revokeMatrixSession(
  homeserver: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${homeserver}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: requestSignal(signal),
  });
  assert.equal(response.status, 200, 'Independent SSO session logout status');
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  recorded: Set<LegacySsoAssertion>,
  identity: LegacySsoAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function enterHomeserver(
  client: AccountWorkspaceClient,
  homeserver: string,
): Promise<void> {
  await client.tapCurrent('#homeserver');
  await client.fillFocused('#homeserver', homeserver);
  await client.tapCurrent('button', { exactText: 'Continue' });
  await client.visible('button', { exactText: 'Continue with SSO' }, 30_000);
}

async function waitForRooms(client: AccountWorkspaceClient): Promise<void> {
  await waitForNativeShellState(
    () => client.surface(),
    (surface) => new URL(surface.url).pathname.startsWith('/rooms'),
    'legacy SSO Rooms surface',
    client.signal,
    60_000,
  );
  await client.visible('[data-testid="rail-rooms"]', {}, 60_000);
}

function decodeXml(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readPersistedSsoState(
  device: MaestroDevice,
  signal: AbortSignal,
): Promise<string> {
  const state = await waitForNativeShellState(
    async () => {
      const preferences = await device
        .adb(
          'exec-out',
          'run-as',
          TRINITY_PACKAGE,
          'cat',
          'shared_prefs/CapacitorStorage.xml',
        )
        .catch(() => '');
      const match = /<string name="sso\.state">([^<]+)<\/string>/u.exec(
        preferences,
      );
      return match?.[1] ? decodeXml(match[1]) : null;
    },
    (value): value is string => typeof value === 'string' && value.length > 0,
    'persisted SSO state nonce',
    signal,
    15_000,
  );
  assert(state, 'Installed app persisted a non-empty SSO state nonce');
  return state;
}

async function startLegitimateSso(
  client: AccountWorkspaceClient,
  provider: LegacySsoProvider,
  homeserver: string,
): Promise<void> {
  await enterHomeserver(client, homeserver);
  await client.hideKeyboard();
  await provider.prepare();
  await client.tapCurrent('button', { exactText: 'Continue with SSO' });
  await provider.waitForDex();
}

async function injectSsoCallback(
  device: MaestroDevice,
  loginToken: string,
  state: string,
): Promise<void> {
  const callback = new URL('eu.qwky.trinity://sso-callback');
  callback.searchParams.set('loginToken', loginToken);
  callback.searchParams.set('sso_state', state);
  await device.adb(
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    shellQuote(callback.href),
    '-p',
    TRINITY_PACKAGE,
  );
}

async function redeemAndRevoke(
  homeserver: string,
  token: string,
  expectedUserId: string,
  secrets: Record<string, string>,
  accessTokenKey: 'ACCESS_TOKEN_1' | 'ACCESS_TOKEN_2',
  signal: AbortSignal,
): Promise<RedeemedSession> {
  let redeemed: RedeemedSession | undefined;
  const failures: unknown[] = [];
  try {
    redeemed = await redeemLoginToken(homeserver, token, signal);
    secrets[accessTokenKey] = redeemed.accessToken;
    assert.equal(redeemed.userId, expectedUserId);
  } catch (error) {
    failures.push(error);
  } finally {
    if (redeemed) {
      try {
        await revokeMatrixSession(homeserver, redeemed.accessToken, signal);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(
      failures,
      'SSO token redemption and session revocation failed',
    );
  }
  assert(redeemed, 'SSO token was redeemed before revocation');
  return redeemed;
}

function createCases(): readonly LegacySsoCase[] {
  return [
    {
      id: 'provider-sign-in-and-persistence',
      source: LEGACY_SSO_SOURCES.signIn,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      async run({
        client,
        device,
        homeserver,
        sso,
        secrets,
        signal,
      }) {
        const recorded = new Set<LegacySsoAssertion>();
        await enterHomeserver(client, homeserver);
        const passwordAction = await client.visible('button', {
          exactText: 'Sign in',
        });
        await recordAssertion(
          client,
          recorded,
          assertions.signIn.passwordActionVisible,
          { visible: passwordAction.visible },
        );
        const ssoAction = await client.visible('button', {
          exactText: 'Continue with SSO',
        });
        await recordAssertion(
          client,
          recorded,
          assertions.signIn.ssoActionVisible,
          { visible: ssoAction.visible },
        );
        await client.expectCount('[data-testid="oidc-continue"]', 0);
        await recordAssertion(
          client,
          recorded,
          assertions.signIn.delegatedActionAbsent,
          { count: 0 },
        );

        await client.hideKeyboard();
        const provider = await openLegacySsoProvider(
          device,
          client.workspaceRoot,
          client.output,
          signal,
        );
        const failures: unknown[] = [];
        try {
          await provider.prepare();
          await client.tapCurrent('button', { exactText: 'Continue with SSO' });
          await provider.waitForDex();
          secrets.SSO_STATE_SECRET_1 = await readPersistedSsoState(
            device,
            signal,
          );
          await provider.completeDexSignIn(sso.email, sso.pass);
          await waitForRooms(client);
          await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
          const rail = await client.visible(
            '[data-testid="rail-rooms"]',
            {},
            60_000,
          );
          await client.expectCount('#homeserver', 0);
          const surface = await client.surface();
          assert(new URL(surface.url).pathname.startsWith('/rooms'));
          await recordAssertion(
            client,
            recorded,
            assertions.signIn.persistedRoomsVisible,
            {
              visible: rail.visible,
              loginCount: 0,
              pathname: new URL(surface.url).pathname,
              hostRelaunch: true,
            },
          );
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            await provider.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(failures, 'Provider sign-in stage failed');
        }
        assert.deepEqual(
          [...recorded].sort(),
          Object.values(assertions.signIn).sort(),
        );
      },
    },
    {
      id: 'unverifiable-callback-unspent-token',
      source: LEGACY_SSO_SOURCES.unverified,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      async run({
        client,
        device,
        homeserver,
        applicationOrigin,
        sso,
        secrets,
        signal,
      }) {
        const recorded = new Set<LegacySsoAssertion>();
        const expectedUserId = `@${sso.user}:localhost`;
        const token = await mintUnspentLoginToken(
          homeserver,
          applicationOrigin,
          sso,
          signal,
        );
        secrets.LOGIN_TOKEN_1 = token;
        const forgedState = `forged-${Date.now()}`;
        secrets.SSO_STATE_SECRET_FORGED_1 = forgedState;
        const tokenObserver = await armTokenLoginObserver(client, homeserver);
        const failures: unknown[] = [];
        try {
          await injectSsoCallback(device, token, forgedState);
          const error = await client.visible(
            '[role="alert"]',
            { exactText: VERIFICATION_ERROR },
            30_000,
          );
          await recordAssertion(
            client,
            recorded,
            assertions.unverified.verificationErrorVisible,
            { visible: error.visible, text: error.text },
          );
          const back = await client.visible('button', {
            exactText: 'Back to sign in',
          });
          await recordAssertion(
            client,
            recorded,
            assertions.unverified.backToSignInVisible,
            { visible: back.visible, text: back.text },
          );
          const surface = await client.surface();
          assert(!new URL(surface.url).pathname.startsWith('/rooms'));
          await recordAssertion(
            client,
            recorded,
            assertions.unverified.roomsRouteAbsent,
            { pathname: new URL(surface.url).pathname },
          );
          const appTokenLoginRequests = tokenObserver.count;
          assert.equal(appTokenLoginRequests, 0);
          const redeemed = await redeemAndRevoke(
            homeserver,
            token,
            expectedUserId,
            secrets,
            'ACCESS_TOKEN_1',
            signal,
          );
          assert.equal(redeemed.userId, expectedUserId);
          await recordAssertion(
            client,
            recorded,
            assertions.unverified.unspentTokenExactMxid,
            { status: redeemed.status, userId: redeemed.userId },
          );
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            await tokenObserver.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(
            failures,
            'Unverifiable callback stage failed',
          );
        }
        assert.deepEqual(
          [...recorded].sort(),
          Object.values(assertions.unverified).sort(),
        );
      },
    },
    {
      id: 'inflight-forged-callback-recovery',
      source: LEGACY_SSO_SOURCES.inFlight,
      profile: DESKTOP_ACCOUNT_PROFILE,
      async run({
        client,
        device,
        homeserver,
        applicationOrigin,
        sso,
        secrets,
        signal,
      }) {
        const recorded = new Set<LegacySsoAssertion>();
        const expectedUserId = `@${sso.user}:localhost`;
        const forgedState = `forged-inflight-${Date.now()}`;
        secrets.SSO_STATE_SECRET_FORGED_2 = forgedState;
        const firstProvider = await openLegacySsoProvider(
          device,
          client.workspaceRoot,
          client.output,
          signal,
        );
        let secondProvider: LegacySsoProvider | undefined;
        let tokenObserver: TokenLoginObserver | undefined;
        const failures: unknown[] = [];
        try {
          await startLegitimateSso(
            client,
            firstProvider,
            homeserver,
          );
          secrets.SSO_STATE_SECRET_2 = await readPersistedSsoState(
            device,
            signal,
          );
          const token = await mintUnspentLoginToken(
            homeserver,
            applicationOrigin,
            sso,
            signal,
          );
          secrets.LOGIN_TOKEN_2 = token;
          tokenObserver = await armTokenLoginObserver(client, homeserver);
          await injectSsoCallback(device, token, forgedState);

          const completing = await client.visible(
            'p',
            { exactText: 'Completing sign in…' },
            30_000,
          );
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.completingCopyVisible,
            { visible: completing.visible, text: completing.text },
          );
          const wordmark = await client.visible('.login-card__wordmark');
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.wordmarkVisible,
            { visible: wordmark.visible },
          );
          assert.equal(wordmark.text, 'Trinity');
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.wordmarkText,
            { text: wordmark.text },
          );
          await client.expectCount('h1, h2, h3, h4, h5, h6', 1);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.headingCount,
            { count: 1 },
          );
          await client.expectCount('h1', 1, {
            exactText: 'Completing sign in',
          });
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.completingHeadingCount,
            { count: 1, level: 1, text: 'Completing sign in' },
          );
          const card = await client.visible('.login-card');
          assert(card.rect);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.cardBoundsPresent,
            { present: true },
          );
          assert(card.rect.width >= 400);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.cardMinWidth,
            { width: card.rect.width, minimum: 400 },
          );
          assert(card.rect.width <= 480);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.cardMaxWidth,
            { width: card.rect.width, maximum: 480 },
          );
          assert(card.rect.x >= 0);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.cardNonnegativeX,
            { x: card.rect.x },
          );
          const viewport = await client.visible('html');
          assert(card.rect.right <= viewport.rect.width);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.cardWithinViewport,
            { right: card.rect.right, viewportWidth: viewport.rect.width },
          );
          await client.expectCount('main', 1);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.mainCount,
            { count: 1 },
          );
          const body = await client.visible(
            '[data-testid="sso-callback-body"]',
          );
          assert(body.rect);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.bodyBoundsPresent,
            { present: true },
          );
          assert(body.rect.x > card.rect.x + 8);
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.bodyInset,
            { bodyX: body.rect.x, cardX: card.rect.x, minimumInset: 8 },
          );
          await client.expectCount('[role="alert"]', 0, {
            text: 'could not be verified',
          });
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.verificationErrorAbsent,
            { count: 0 },
          );
          const surface = await client.surface();
          assert(!new URL(surface.url).pathname.startsWith('/rooms'));
          await recordAssertion(
            client,
            recorded,
            assertions.inFlight.roomsRouteAbsent,
            { pathname: new URL(surface.url).pathname },
          );
          const appTokenLoginRequests = tokenObserver.count;
          assert.equal(appTokenLoginRequests, 0);
          await tokenObserver.close();
          tokenObserver = undefined;
          await redeemAndRevoke(
            homeserver,
            token,
            expectedUserId,
            secrets,
            'ACCESS_TOKEN_2',
            signal,
          );
          await firstProvider.close();

          await device.runFlow(
            join(
              client.workspaceRoot,
              'e2e/android/flows/native-shell-back.yaml',
            ),
            { APP_ID: TRINITY_PACKAGE },
          );
          await client.visible('#homeserver', {}, 30_000);
          secondProvider = await openLegacySsoProvider(
            device,
            client.workspaceRoot,
            client.output,
            signal,
          );
          await startLegitimateSso(client, secondProvider, homeserver);
          secrets.SSO_STATE_SECRET_3 = await readPersistedSsoState(
            device,
            signal,
          );
          await secondProvider.completeDexSignIn(sso.email, sso.pass);
          await waitForRooms(client);
        } catch (error) {
          failures.push(error);
        } finally {
          if (tokenObserver) {
            try {
              await tokenObserver.close();
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            await secondProvider?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await firstProvider.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(
            failures,
            'In-flight forged callback recovery stage failed',
          );
        }
        assert.deepEqual(
          [...recorded].sort(),
          Object.values(assertions.inFlight).sort(),
        );
      },
    },
  ];
}

assert.equal(
  Object.values(assertions).flatMap((group) => Object.values(group)).length,
  23,
  'Exactly 23 legacy SSO assertion identities are required',
);

void test(
  'Android legacy SSO journeys',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        assert(
          session.synapse?.available &&
            session.synapse.hs &&
            session.synapse.sso,
          'Legacy SSO requires disposable Synapse and Dex',
        );
        const homeserver = session.synapse.hs;
        const sso = session.synapse.sso;
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'legacy-sso',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        secrets.DEX_EMAIL_SECRET = sso.email;
        secrets.DEX_PASSWORD = sso.pass;
        matrixResources.cleanup('Redact legacy SSO diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const cases = createCases();
        assert.equal(cases.length, 3, 'Exactly three legacy SSO stages exist');
        const stages: Array<{
          readonly id: string;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: cases.length,
                expectedAssertions: 23,
                attempt: 1,
                retries: 0,
                sources: LEGACY_SSO_SOURCES,
                stages,
              },
              null,
              2,
            )}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Legacy SSO Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup('Legacy SSO Android WebView', async () =>
          client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
          );
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/*`,
            attempt: 1,
            retries: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[legacy-sso] ${entry.id} start`);
          try {
            await client.reset(entry.profile);
            await entry.run({
              client,
              device,
              homeserver,
              applicationOrigin: session.endpoints.application,
              sso,
              secrets,
              resources: matrixResources,
              signal,
            });
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          } finally {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            try {
              await save();
            } catch (error) {
              failures.push(error);
            }
            console.info(
              `[legacy-sso] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Legacy SSO journey ${entry.id} failed`,
            );
          }
        }
        await writeFile(
          join(output, 'suite-summary.json'),
          `${JSON.stringify(
            {
              attempt: 1,
              retries: 0,
              expectedStages: 3,
              passedStages: stages.filter((stage) => stage.status === 'passed')
                .length,
              expectedAssertions: 23,
            },
            null,
            2,
          )}\n`,
        );
      },
    );
  },
);
