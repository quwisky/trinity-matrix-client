import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  openDevtoolsConnection,
  type DevtoolsEventConnection,
} from '../support/devtools-connection.mts';
import type { MaestroDevice } from './maestro-session.mts';

const CHROME_PACKAGE = 'com.android.chrome';
const TRINITY_COMPONENT =
  'eu.qwky.trinity/eu.qwky.trinity.MainActivity';
const CHROME_COMMAND_LINE = '/data/local/tmp/chrome-command-line';
const CHROME_DEVTOOLS_SOCKET = 'localabstract:chrome_devtools_remote';
const CALLBACK_URI = 'eu.qwky.trinity:/sso-callback';
const CLIENT_ID = 'e2e-client-id';
const AUTHORIZATION_CODE = 'E2E_CODE';
const ACCESS_TOKEN = 'e2e-access';
const REFRESH_TOKEN = 'e2e-refresh';
const CLIENT_SCOPE = 'urn:matrix:client:api:*';
const DEVICE_SCOPE = 'urn:matrix:client:device:';

const ENDPOINTS = {
  wellKnown: 'https://oidc.example/.well-known/matrix/client',
  versions: 'https://hs.oidc.example/_matrix/client/versions',
  login: 'https://hs.oidc.example/_matrix/client/v3/login',
  authMetadata:
    'https://hs.oidc.example/_matrix/client/v1/auth_metadata',
  authIssuer:
    'https://hs.oidc.example/_matrix/client/unstable/org.matrix.msc2965',
  whoami:
    'https://hs.oidc.example/_matrix/client/v3/account/whoami',
  registration: 'https://provider.oidc.example/register',
  authorize: 'https://provider.oidc.example/authorize',
  token: 'https://provider.oidc.example/token',
} as const;

const AUTH_METADATA = {
  issuer: 'https://provider.oidc.example/',
  authorization_endpoint: ENDPOINTS.authorize,
  token_endpoint: ENDPOINTS.token,
  revocation_endpoint: 'https://provider.oidc.example/revoke',
  registration_endpoint: ENDPOINTS.registration,
  account_management_uri: 'https://provider.oidc.example/account',
  response_modes_supported: ['query', 'fragment'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  prompt_values_supported: ['create'],
} as const;

const CORS_HEADERS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Methods', value: '*' },
  { name: 'Access-Control-Allow-Headers', value: '*' },
] as const;

const APP_PATTERNS = [
  ENDPOINTS.wellKnown,
  ENDPOINTS.versions,
  ENDPOINTS.login,
  ENDPOINTS.authMetadata,
  ENDPOINTS.authIssuer,
  ENDPOINTS.whoami,
  ENDPOINTS.registration,
  ENDPOINTS.token,
] as const;

export type OidcLoginFixtureMode =
  | 'classification'
  | 'provider-error'
  | 'redemption'
  | 'fallback';

export interface OidcAuthorizeObservation {
  readonly requestPresent: true;
  readonly clientId: string;
  readonly responseType: string;
  readonly challengeMethod: string;
  readonly challengePresent: boolean;
  readonly statePresent: boolean;
  readonly callbackUri: string;
  readonly registrationApplicationType: string | null;
  readonly scopeClientApi: boolean;
  readonly scopeDevice: boolean;
  readonly responseMode: string;
}

export interface OidcTokenObservation {
  readonly requestPresent: true;
  readonly grantType: string;
  readonly codeExact: boolean;
  readonly clientId: string;
  readonly verifierPresent: boolean;
  readonly pkceMatches: boolean;
}

export interface OidcLoginObservations {
  readonly registrationApplicationType: string | null;
  readonly authorize?: OidcAuthorizeObservation;
  readonly token?: OidcTokenObservation;
  readonly completedEndpoints: readonly string[];
}

export interface OidcLoginFixture {
  readonly observations: OidcLoginObservations;
  prepareChrome(): Promise<void>;
  waitForAuthorization(
    signal: AbortSignal,
  ): Promise<OidcAuthorizeObservation>;
  waitForToken(signal: AbortSignal): Promise<OidcTokenObservation>;
  assertComplete(): void;
  close(): Promise<void>;
}

interface PausedRequest {
  readonly requestId: string;
  readonly method: string;
  readonly url: URL;
  readonly postData?: string;
}

interface DevtoolsTarget {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

interface FixtureOptions {
  readonly mode: OidcLoginFixtureMode;
  readonly app: DevtoolsEventConnection;
  readonly device: MaestroDevice;
  readonly workspaceRoot: string;
  readonly artifactDirectory: string;
  readonly signal: AbortSignal;
  readonly registerSecret: (name: string, value: string) => void;
}

function pausedRequest(value: unknown): PausedRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const request = record['request'];
  if (
    typeof record['requestId'] !== 'string' ||
    !request ||
    typeof request !== 'object'
  ) {
    return undefined;
  }
  const requestRecord = request as Record<string, unknown>;
  if (
    typeof requestRecord['method'] !== 'string' ||
    typeof requestRecord['url'] !== 'string'
  ) {
    return undefined;
  }
  try {
    return {
      requestId: record['requestId'],
      method: requestRecord['method'],
      url: new URL(requestRecord['url']),
      ...(typeof requestRecord['postData'] === 'string'
        ? { postData: requestRecord['postData'] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function endpointKey(url: URL): keyof typeof ENDPOINTS | undefined {
  return (Object.entries(ENDPOINTS) as Array<
    [keyof typeof ENDPOINTS, string]
  >).find(([, endpoint]) => {
    const expected = new URL(endpoint);
    return expected.origin === url.origin && expected.pathname === url.pathname;
  })?.[0];
}

function encodedJson(body: unknown): string {
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

function copyObservations(
  registrationApplicationType: string | null,
  authorize: OidcAuthorizeObservation | undefined,
  token: OidcTokenObservation | undefined,
  completedEndpoints: ReadonlySet<string>,
): OidcLoginObservations {
  return {
    registrationApplicationType,
    ...(authorize ? { authorize: { ...authorize } } : {}),
    ...(token ? { token: { ...token } } : {}),
    completedEndpoints: [...completedEndpoints].sort(),
  };
}

async function waitForObservation<T>(
  read: () => T | undefined,
  label: string,
  signal: AbortSignal,
): Promise<T> {
  while (!signal.aborted) {
    const value = read();
    if (value !== undefined) return value;
    await delay(25, undefined, { signal });
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`OIDC fixture cancelled while waiting for ${label}`);
}

/** Install the only network controller used by one OIDC-native login stage. */
export async function installOidcLoginFixture(
  options: FixtureOptions,
): Promise<OidcLoginFixture> {
  const {
    mode,
    app,
    device,
    workspaceRoot,
    artifactDirectory,
    signal,
    registerSecret,
  } = options;
  signal.throwIfAborted();
  let closed = false;
  let chromePrepared = false;
  let commandLinePresent = false;
  let chromePort: string | undefined;
  let eventFailure: unknown;
  let eventWork = Promise.resolve();
  let registrationApplicationType: string | null = null;
  let authorizeObservation: OidcAuthorizeObservation | undefined;
  let tokenObservation: OidcTokenObservation | undefined;
  let authorizeState: string | undefined;
  let authorizeChallenge: string | undefined;
  const completedEndpoints = new Set<string>();
  const connectionCleanup = new Map<
    DevtoolsEventConnection,
    () => void
  >();
  const attachedTargetEndpoints = new Set<string>();
  let pendingSequence = 0;
  const pending = new Map<
    string,
    { readonly connection: DevtoolsEventConnection; readonly requestId: string }
  >();

  const throwIfFailed = (): void => {
    if (eventFailure !== undefined) throw eventFailure;
  };

  const fulfillJson = async (
    connection: DevtoolsEventConnection,
    requestId: string,
    body: unknown,
    responseCode = 200,
  ): Promise<void> => {
    await connection.send('Fetch.fulfillRequest', {
      requestId,
      responseCode,
      responseHeaders: [
        ...CORS_HEADERS,
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: encodedJson(body),
    });
  };

  const fulfillPreflight = async (
    connection: DevtoolsEventConnection,
    requestId: string,
  ): Promise<void> => {
    await connection.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 204,
      responseHeaders: [...CORS_HEADERS],
    });
  };

  const fulfillRedirect = async (
    connection: DevtoolsEventConnection,
    requestId: string,
    location: string,
  ): Promise<void> => {
    await connection.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 302,
      responseHeaders: [
        { name: 'Location', value: location },
        { name: 'Cache-Control', value: 'no-store' },
      ],
    });
  };

  const handle = async (
    connection: DevtoolsEventConnection,
    value: unknown,
  ): Promise<void> => {
    const paused = pausedRequest(value);
    if (!paused) throw new Error('OIDC Fetch.requestPaused payload is malformed');
    const pendingKey = `${++pendingSequence}:${paused.requestId}`;
    pending.set(pendingKey, { connection, requestId: paused.requestId });
    try {
      const key = endpointKey(paused.url);
      if (!key) {
        await connection.send('Fetch.continueRequest', {
          requestId: paused.requestId,
        });
        return;
      }
      if (paused.url.hash) {
        throw new Error(`OIDC fixture refused fragment on ${key}`);
      }
      if (paused.method === 'OPTIONS') {
        await fulfillPreflight(connection, paused.requestId);
        return;
      }
      if (key !== 'authorize' && paused.url.search) {
        throw new Error(`OIDC fixture refused unexpected query on ${key}`);
      }

      switch (key) {
        case 'wellKnown':
          assert.equal(paused.method, 'GET');
          await fulfillJson(connection, paused.requestId, {
            'm.homeserver': { base_url: 'https://hs.oidc.example' },
          });
          break;
        case 'versions':
          assert.equal(paused.method, 'GET');
          await fulfillJson(connection, paused.requestId, {
            versions: mode === 'fallback' ? ['v1.1'] : ['v1.1', 'v1.15'],
            unstable_features: {},
          });
          break;
        case 'login':
          assert.equal(paused.method, 'GET');
          await fulfillJson(connection, paused.requestId, {
            flows:
              mode === 'fallback' ? [{ type: 'm.login.password' }] : [],
          });
          break;
        case 'authMetadata':
        case 'authIssuer':
          assert.equal(paused.method, 'GET');
          if (mode === 'fallback') {
            await connection.send('Fetch.fulfillRequest', {
              requestId: paused.requestId,
              responseCode: 404,
              responseHeaders: [
                ...CORS_HEADERS,
                { name: 'Content-Type', value: 'application/json' },
              ],
              body: encodedJson({
                errcode: 'M_UNRECOGNIZED',
                error: 'Unrecognized request',
              }),
            });
          } else {
            assert.equal(key, 'authMetadata');
            await fulfillJson(
              connection,
              paused.requestId,
              AUTH_METADATA,
            );
          }
          break;
        case 'registration': {
          assert(mode === 'provider-error' || mode === 'redemption');
          assert.equal(paused.method, 'POST');
          const body = JSON.parse(paused.postData ?? '{}') as {
            readonly application_type?: unknown;
          };
          const application_type = body.application_type;
          assert(
            application_type === 'native',
            'OIDC dynamic registration application type must be native',
          );
          registrationApplicationType = application_type;
          await fulfillJson(
            connection,
            paused.requestId,
            { client_id: CLIENT_ID },
            201,
          );
          break;
        }
        case 'authorize': {
          assert(mode === 'provider-error' || mode === 'redemption');
          assert.equal(paused.method, 'GET');
          const windows = await device.adb(
            'shell',
            'dumpsys',
            'window',
            'windows',
          );
          assert(
            windows.includes(CHROME_PACKAGE),
            'OIDC authorization is hosted by the native Chrome package',
          );
          const params = paused.url.searchParams;
          const state = params.get('state') ?? '';
          const challenge = params.get('code_challenge') ?? '';
          const redirectUri = params.get('redirect_uri') ?? '';
          assert(state, 'OIDC authorization state must be non-empty');
          assert(challenge, 'OIDC PKCE challenge must be non-empty');
          assert.equal(redirectUri, CALLBACK_URI);
          authorizeState = state;
          authorizeChallenge = challenge;
          registerSecret('PKCE_STATE_SECRET', state);
          registerSecret('PKCE_CHALLENGE_SECRET', challenge);
          authorizeObservation = {
            requestPresent: true,
            clientId: params.get('client_id') ?? '',
            responseType: params.get('response_type') ?? '',
            challengeMethod: params.get('code_challenge_method') ?? '',
            challengePresent: challenge.length > 0,
            statePresent: state.length > 0,
            callbackUri: redirectUri,
            registrationApplicationType,
            scopeClientApi: (params.get('scope') ?? '').includes(CLIENT_SCOPE),
            scopeDevice: (params.get('scope') ?? '').includes(DEVICE_SCOPE),
            responseMode: params.get('response_mode') ?? '',
          };
          const callback = new URL(CALLBACK_URI);
          const callbackParams = new URLSearchParams();
          if (mode === 'provider-error') {
            callbackParams.set('error', 'access_denied');
            callbackParams.set('error_description', 'E2E declined');
          } else {
            callbackParams.set('code', 'E2E_CODE');
          }
          callbackParams.set('state', state);
          callback.search = callbackParams.toString();
          if (mode === 'redemption') {
            registerSecret('AUTHORIZATION_CODE_SECRET', AUTHORIZATION_CODE);
          }
          await fulfillRedirect(connection, paused.requestId, callback.href);
          break;
        }
        case 'token': {
          assert.equal(mode, 'redemption');
          assert.equal(paused.method, 'POST');
          const body = new URLSearchParams(paused.postData ?? '');
          const grantType = body.get('grant_type') ?? '';
          const code = body.get('code') ?? '';
          const clientId = body.get('client_id') ?? '';
          const verifier = body.get('code_verifier') ?? '';
          assert(
            grantType === 'authorization_code',
            'OIDC token grant must be authorization_code',
          );
          assert.equal(code, AUTHORIZATION_CODE);
          assert.equal(clientId, CLIENT_ID);
          assert(verifier, 'OIDC token verifier must be non-empty');
          assert(authorizeState, 'OIDC authorization state was not observed');
          assert(
            authorizeChallenge,
            'OIDC authorization challenge was not observed',
          );
          registerSecret('PKCE_VERIFIER_SECRET', verifier);
          registerSecret('CAPTURED_TOKEN_BODY_SECRET', paused.postData ?? '');
          registerSecret('MOCK_ACCESS_TOKEN_SECRET', ACCESS_TOKEN);
          registerSecret('MOCK_REFRESH_TOKEN_SECRET', REFRESH_TOKEN);
          const digest = createHash('sha256')
            .update(verifier)
            .digest('base64url');
          const pkceMatches = digest === authorizeChallenge;
          assert(pkceMatches, 'OIDC token verifier must match the S256 challenge');
          tokenObservation = {
            requestPresent: true,
            grantType,
            codeExact: code === AUTHORIZATION_CODE,
            clientId,
            verifierPresent: verifier.length > 0,
            pkceMatches,
          };
          await fulfillJson(connection, paused.requestId, {
            token_type: 'Bearer',
            access_token: ACCESS_TOKEN,
            refresh_token: REFRESH_TOKEN,
            expires_in: 300,
          });
          break;
        }
        case 'whoami':
          assert.equal(mode, 'redemption');
          assert.equal(paused.method, 'GET');
          await fulfillJson(connection, paused.requestId, {
            user_id: '@e2e:oidc.example',
            device_id: 'E2EDEV',
          });
          break;
      }
      completedEndpoints.add(key);
    } finally {
      pending.delete(pendingKey);
    }
  };

  const arm = async (
    connection: DevtoolsEventConnection,
    patterns: readonly string[],
  ): Promise<void> => {
    assert(
      !connectionCleanup.has(connection),
      'OIDC connection is armed exactly once',
    );
    const unsubscribe = connection.on('Fetch.requestPaused', (value) => {
      if (closed) return;
      eventWork = eventWork
        .then(() => handle(connection, value))
        .catch((error: unknown) => {
          eventFailure ??= error;
        });
    });
    try {
      await connection.send('Fetch.enable', {
        patterns: patterns.map((urlPattern) => ({
          urlPattern,
          requestStage: 'Request',
        })),
      });
      connectionCleanup.set(connection, unsubscribe);
    } catch (error) {
      unsubscribe();
      throw error;
    }
  };

  const chromeTargets = async (): Promise<readonly DevtoolsTarget[]> => {
    assert(chromePort, 'Chrome DevTools forward is unavailable');
    const response = await fetch(`http://127.0.0.1:${chromePort}/json`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    });
    const value: unknown = await response.json();
    return Array.isArray(value)
      ? value.filter(
          (target): target is DevtoolsTarget =>
            Boolean(target) && typeof target === 'object',
        )
      : [];
  };

  const attachChromeTarget = async (
    target: DevtoolsTarget,
  ): Promise<boolean> => {
    if (
      target.type !== 'page' ||
      typeof target.webSocketDebuggerUrl !== 'string'
    ) {
      return false;
    }
    const connection = await openDevtoolsConnection(
      target.webSocketDebuggerUrl,
      { signal, timeoutMs: 5_000 },
    );
    try {
      await arm(connection, [`${ENDPOINTS.authorize}*`]);
      attachedTargetEndpoints.add(target.webSocketDebuggerUrl);
      await connection.send('Runtime.runIfWaitingForDebugger').catch(
        () => undefined,
      );
      return true;
    } catch (error) {
      connection.close(
        error instanceof Error ? error : new Error('Chrome attach failed'),
      );
      throw error;
    }
  };

  await arm(app, APP_PATTERNS);

  const removeCommandLine = async (): Promise<void> => {
    if (!commandLinePresent) return;
    await device.adb('shell', 'rm', '-f', CHROME_COMMAND_LINE);
    commandLinePresent = false;
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await eventWork;
      throwIfFailed();
    } catch (error) {
      failures.push(error);
    }
    for (const paused of pending.values()) {
      try {
        await paused.connection.send('Fetch.continueRequest', {
          requestId: paused.requestId,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    pending.clear();
    for (const [connection, unsubscribe] of connectionCleanup) {
      try {
        unsubscribe();
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Fetch.disable');
      } catch (error) {
        failures.push(error);
      }
      try {
        connection.close(new Error('OIDC fixture closed'));
      } catch (error) {
        failures.push(error);
      }
    }
    connectionCleanup.clear();
    try {
      await removeCommandLine();
    } catch (error) {
      failures.push(error);
    }
    if (chromePort) {
      try {
        await device.removeForward(`tcp:${chromePort}`);
      } catch (error) {
        failures.push(error);
      }
      chromePort = undefined;
    }
    try {
      await device.adb('shell', 'am', 'force-stop', CHROME_PACKAGE);
    } catch (error) {
      failures.push(error);
    }
    try {
      await device.adb('shell', 'pm', 'clear', CHROME_PACKAGE);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(failures, 'OIDC fixture cleanup failed');
    }
  };

  signal.addEventListener(
    'abort',
    () => {
      void close().catch(() => undefined);
    },
    { once: true },
  );

  return {
    get observations() {
      throwIfFailed();
      return copyObservations(
        registrationApplicationType,
        authorizeObservation,
        tokenObservation,
        completedEndpoints,
      );
    },
    async prepareChrome() {
      assert(!closed, 'Cannot prepare Chrome after OIDC fixture cleanup');
      assert(!chromePrepared, 'OIDC Chrome preparation is one-shot');
      assert(mode === 'provider-error' || mode === 'redemption');
      const failures: unknown[] = [];
      try {
        await device.adb('shell', 'am', 'force-stop', CHROME_PACKAGE);
        assert.equal(
          await device.adb('shell', 'pm', 'clear', CHROME_PACKAGE),
          'Success',
          'Disposable OIDC Chrome profile cleared',
        );
        const flags = [
          '_',
          '--disable-fre',
          '--no-default-browser-check',
          '--remote-debugging-port=9222',
          '--wait-for-debugger-children',
          '--ignore-certificate-errors',
        ].join(' ');
        const encoded = Buffer.from(flags).toString('base64');
        commandLinePresent = true;
        await device.adb(
          'shell',
          'sh',
          '-c',
          `echo ${encoded} | base64 -d > ${CHROME_COMMAND_LINE}`,
        );
        await device.adb(
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          'about:blank',
          CHROME_PACKAGE,
        );
        await device.runFlow(
          join(workspaceRoot, 'e2e/android/flows/oidc-login-chrome-setup.yaml'),
        );
        const allocated = (
          await device.adb('forward', 'tcp:0', CHROME_DEVTOOLS_SOCKET)
        ).trim();
        assert(/^\d+$/u.test(allocated), 'ADB allocated a Chrome DevTools port');
        chromePort = allocated;
        const readinessSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
        ]);
        let attached = false;
        while (!attached) {
          readinessSignal.throwIfAborted();
          for (const target of await chromeTargets()) {
            if (target.url === 'about:blank') {
              attached = await attachChromeTarget(target);
              if (attached) break;
            }
          }
          if (!attached) await delay(50, undefined, { signal: readinessSignal });
        }
        await removeCommandLine();
        await device.adb(
          'shell',
          'am',
          'start',
          '-W',
          '-n',
          TRINITY_COMPONENT,
        );
        chromePrepared = true;
        await writeFile(
          join(artifactDirectory, 'oidc-chrome.json'),
          `${JSON.stringify(
            {
              package: CHROME_PACKAGE,
              profileCleared: true,
              nativeFirstRunHandled: true,
              devtoolsControllerOwned: true,
              driverInstalled: false,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await removeCommandLine();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) {
        throw new AggregateError(failures, 'OIDC Chrome preparation failed');
      }
    },
    async waitForAuthorization(operationSignal) {
      assert(chromePrepared, 'Chrome must be prepared before OIDC authorization');
      const boundedSignal = AbortSignal.any([
        signal,
        operationSignal,
        AbortSignal.timeout(60_000),
      ]);
      while (!authorizeObservation && !boundedSignal.aborted) {
        await eventWork;
        throwIfFailed();
        if (authorizeObservation) break;
        for (const target of await chromeTargets()) {
          if (
            typeof target.url === 'string' &&
            target.url.startsWith(ENDPOINTS.authorize) &&
            typeof target.webSocketDebuggerUrl === 'string' &&
            !attachedTargetEndpoints.has(target.webSocketDebuggerUrl)
          ) {
            await attachChromeTarget(target);
          }
        }
        await delay(25, undefined, { signal: boundedSignal });
      }
      await eventWork;
      throwIfFailed();
      return waitForObservation(
        () => authorizeObservation,
        'authorization request',
        boundedSignal,
      );
    },
    async waitForToken(operationSignal) {
      const boundedSignal = AbortSignal.any([
        signal,
        operationSignal,
        AbortSignal.timeout(60_000),
      ]);
      const observation = await waitForObservation(
        () => tokenObservation,
        'token request',
        boundedSignal,
      );
      await waitForObservation(
        () => (completedEndpoints.has('whoami') ? true : undefined),
        'whoami response',
        boundedSignal,
      );
      await eventWork;
      throwIfFailed();
      return observation;
    },
    assertComplete() {
      throwIfFailed();
      const required: readonly (keyof typeof ENDPOINTS)[] =
        mode === 'classification'
          ? ['wellKnown', 'versions', 'login', 'authMetadata']
          : mode === 'fallback'
            ? ['wellKnown', 'versions', 'login', 'authMetadata', 'authIssuer']
            : mode === 'provider-error'
              ? [
                  'wellKnown',
                  'versions',
                  'login',
                  'authMetadata',
                  'registration',
                  'authorize',
                ]
              : [
                  'wellKnown',
                  'versions',
                  'login',
                  'authMetadata',
                  'registration',
                  'authorize',
                  'token',
                  'whoami',
                ];
      assert.deepEqual(
        [...completedEndpoints].sort(),
        [...required].sort(),
        `OIDC ${mode} completed the exact endpoint ledger`,
      );
    },
    close,
  };
}
