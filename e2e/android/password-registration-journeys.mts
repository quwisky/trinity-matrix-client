import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  PASSWORD_REGISTRATION_SOURCES,
  passwordRegistrationAssertions as assertions,
  type PasswordRegistrationAssertion,
} from './password-registration-contract.mts';

const REGISTRATION_ACTION = '[data-testid="password-register"]';
const AVAILABILITY_PATH = '/_matrix/client/v3/register/available' as const;

interface AvailabilityObservation {
  readonly requestPath: typeof AVAILABILITY_PATH;
  readonly status: number;
  readonly success: true;
}

interface AvailabilityObserver {
  wait(): Promise<AvailabilityObservation>;
  close(): Promise<void>;
}

interface PasswordLoginObservation {
  readonly status: 200;
  readonly userId: string;
  readonly accessToken: string;
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
  | { readonly requestId: string; readonly method: string; readonly url: URL }
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
    return { requestId, method, url: new URL(rawUrl) };
  } catch {
    return undefined;
  }
}

function responseMetadata(
  value: Readonly<Record<string, unknown>>,
):
  | { readonly requestId: string; readonly status: number; readonly url: URL }
  | undefined {
  const requestId = value['requestId'];
  const response = value['response'];
  if (
    typeof requestId !== 'string' ||
    !response ||
    typeof response !== 'object'
  ) {
    return undefined;
  }
  const status = (response as { readonly status?: unknown }).status;
  const rawUrl = (response as { readonly url?: unknown }).url;
  if (typeof status !== 'number' || typeof rawUrl !== 'string') return undefined;
  try {
    return { requestId, status, url: new URL(rawUrl) };
  } catch {
    return undefined;
  }
}

async function closeAvailabilityConnection(
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
    throw new AggregateError(
      failures,
      'Password registration availability observer cleanup failed',
    );
  }
}

async function armAvailabilityObserver(
  client: AccountWorkspaceClient,
  homeserver: string,
): Promise<AvailabilityObserver> {
  const connection = await client.webview.openSession();
  const expectedOrigin = new URL(homeserver).origin;
  const matchingRequests = new Set<string>();
  let observation: AvailabilityObservation | undefined;
  let closed = false;
  const requestUnsubscribe = connection.on(
    'Network.requestWillBeSent',
    (value) => {
      const request = requestMetadata(value);
      if (
        request?.method === 'GET' &&
        request.url.pathname === AVAILABILITY_PATH &&
        request.url.origin === expectedOrigin
      ) {
        matchingRequests.add(request.requestId);
      }
    },
  );
  const responseUnsubscribe = connection.on(
    'Network.responseReceived',
    (value) => {
      const response = responseMetadata(value);
      if (
        response &&
        matchingRequests.has(response.requestId) &&
        response.url.pathname === AVAILABILITY_PATH &&
        response.url.origin === expectedOrigin &&
        response.status >= 200 &&
        response.status < 300
      ) {
        observation = {
          requestPath: AVAILABILITY_PATH,
          status: response.status,
          success: true,
        };
      }
    },
  );
  try {
    await connection.send('Network.enable');
  } catch (error) {
    await closeAvailabilityConnection(connection, [
      requestUnsubscribe,
      responseUnsubscribe,
    ]).catch(() => undefined);
    throw error;
  }
  return {
    async wait(): Promise<AvailabilityObservation> {
      const result = await waitForNativeShellState(
        async () => observation,
        (value) => value !== undefined,
        'successful exact password-registration availability probe',
        client.signal,
        30_000,
      );
      assert(result, 'Availability observation exists');
      return result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeAvailabilityConnection(connection, [
        requestUnsubscribe,
        responseUnsubscribe,
      ]);
    },
  };
}

async function verifyPasswordLogin(
  username: string,
  password: string,
  signal: AbortSignal,
): Promise<PasswordLoginObservation> {
  const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
      initial_device_display_name: 'Android password-registration probe',
    }),
    signal: requestSignal(signal),
  });
  assert.equal(response.status, 200, 'Password registration REST login status');
  const body: unknown = await response.json();
  assert(body && typeof body === 'object', 'Password login JSON response');
  assert(
    'user_id' in body && typeof body.user_id === 'string',
    'Password login returned a user ID',
  );
  assert(
    'access_token' in body && typeof body.access_token === 'string',
    'Password login returned an access token',
  );
  return {
    status: 200,
    userId: body.user_id,
    accessToken: body.access_token,
  };
}

async function revokeObservationSession(
  accessToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const logout = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: requestSignal(signal),
  });
  assert.equal(logout.status, 200, 'Password registration probe logout');
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  recorded: Set<PasswordRegistrationAssertion>,
  identity: PasswordRegistrationAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

function createCases(
  homeserver: string,
  secrets: Record<string, string>,
): readonly {
  readonly id: string;
  readonly source: string;
  readonly profile: typeof PIXEL_5_ACCOUNT_PROFILE;
  run(context: {
    readonly client: AccountWorkspaceClient;
    readonly resources: MatrixTestResources;
    readonly signal: AbortSignal;
  }): Promise<void>;
}[] {
  return [
    {
      id: 'password-registration',
      source: PASSWORD_REGISTRATION_SOURCES.journey,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      async run({ client, resources, signal }) {
        const recorded = new Set<PasswordRegistrationAssertion>();
        const username = `signup-${resources.namespace.id}`;
        const password = `Trinity-registration-${resources.namespace.id}`;
        secrets.PASSWORD = password;

        const initialActions = await client.elements(REGISTRATION_ACTION);
        assert.equal(
          initialActions.some((action) => action.visible),
          false,
          'Registration action starts absent before the availability probe',
        );
        const availabilityObserver = await armAvailabilityObserver(
          client,
          homeserver,
        );
        const stageFailures: unknown[] = [];
        try {
          await client.tapCurrent('#homeserver');
          await client.fillFocused('#homeserver', homeserver);
          await client.tapCurrent('button', { exactText: 'Continue' });
          const availability = await availabilityObserver.wait();
          assert(availability.status >= 200);
          assert(availability.status < 300);
          const registrationAction = await client.visible(
            '[data-testid="password-register"]',
            {},
            30_000,
          );
          await recordAssertion(
            client,
            recorded,
            assertions.availabilityActionVisible,
            {
              initiallyAbsent: true,
              requestPath: availability.requestPath,
              status: availability.status,
              visible: registrationAction.visible,
            },
          );

          await client.tapCurrent('[data-testid="password-register"]');
          const registrationSurface = await waitForNativeShellState(
            () => client.surface(),
            (surface) => new URL(surface.url).pathname === '/register',
            'password registration route',
            client.signal,
            30_000,
          );
          const registration = new URL(registrationSurface.url);
          assert.equal(registration.pathname, '/register');
          assert.equal(registration.searchParams.get('homeserver'), homeserver);
          await recordAssertion(
            client,
            recorded,
            assertions.registrationRoute,
            {
              pathname: registration.pathname,
              homeserver: registration.searchParams.get('homeserver'),
            },
          );

          await client.tapCurrent('#registration-username');
          await client.fillFocused('#registration-username', username);
          await client.tapCurrent('#registration-password');
          await client.fillFocused('#registration-password', password);
          await client.tapCurrent('#registration-confirm-password');
          await client.fillFocused('#registration-confirm-password', password);
          await client.hideKeyboard();
          await client.tapCurrent('[data-testid="register-submit"]');

          const encryptionSurface = await waitForNativeShellState(
            () => client.surface(),
            (surface) =>
              new URL(surface.url).pathname === '/encryption/setup',
            'first-device encryption setup route',
            client.signal,
            60_000,
          );
          const encryptionSetup = new URL(encryptionSurface.url);
          assert.equal(encryptionSetup.pathname, '/encryption/setup');
          await recordAssertion(
            client,
            recorded,
            assertions.encryptionSetupRoute,
            { pathname: encryptionSetup.pathname },
          );

          let login: PasswordLoginObservation | undefined;
          const loginFailures: unknown[] = [];
          try {
            login = await verifyPasswordLogin(username, password, signal);
            secrets.ACCESS_TOKEN = login.accessToken;
            assert.equal(login.userId, `@${username}:localhost`);
            await recordAssertion(client, recorded, assertions.exactMxid, {
              status: login.status,
              userId: login.userId,
            });
          } catch (error) {
            loginFailures.push(error);
          } finally {
            if (login?.accessToken !== undefined) {
              try {
                await revokeObservationSession(login.accessToken);
              } catch (error) {
                loginFailures.push(error);
              }
            }
          }
          if (loginFailures.length === 1) throw loginFailures[0];
          if (loginFailures.length) {
            throw new AggregateError(
              loginFailures,
              'Password registration login proof and revocation failed',
            );
          }

          assert.deepEqual(
            [...recorded].sort(),
            Object.values(assertions).sort(),
            'Every password-registration identity is recorded exactly once',
          );
        } catch (error) {
          stageFailures.push(error);
        } finally {
          try {
            await availabilityObserver.close();
          } catch (error) {
            stageFailures.push(error);
          }
        }
        if (stageFailures.length === 1) throw stageFailures[0];
        if (stageFailures.length) {
          throw new AggregateError(
            stageFailures,
            'Password registration stage and observer cleanup failed',
          );
        }
      },
    },
  ];
}

assert.equal(
  Object.keys(assertions).length,
  4,
  'Exactly four password-registration assertions are required',
);

void test(
  'Android password registration journey',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        assert(
          session.synapse?.available && session.synapse.hs,
          'Password registration requires disposable Synapse',
        );
        const homeserver = session.synapse.hs;
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'password-registration',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        matrixResources.cleanup('Redact password-registration diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const cases = createCases(homeserver, secrets);
        assert.equal(
          cases.length,
          1,
          'Exactly one registration stage is required',
        );
        const stages: Array<{
          readonly id: string;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: cases.length,
                expectedAssertions: Object.keys(assertions).length,
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
        matrixResources.cleanup('Password-registration Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Password-registration Android WebView',
          async () => client?.close(),
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
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[password-registration] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? PIXEL_5_ACCOUNT_PROFILE);
            await entry.run({
              client,
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
              `[password-registration] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Password registration journey ${entry.id} failed`,
            );
          }
        }
      },
    );
  },
);
