import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountViewportProfile,
} from './account-workspace-client.mts';
import {
  oidcLoginAssertions as assertions,
  OIDC_LOGIN_SOURCES,
  type OidcLoginAssertion,
} from './oidc-login-contract.mts';
import {
  installOidcLoginFixture,
  type OidcAuthorizeObservation,
  type OidcLoginFixture,
  type OidcLoginFixtureMode,
  type OidcTokenObservation,
} from './oidc-login-fixture.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import type { MaestroDevice } from './maestro-session.mts';

const HS_DOMAIN = 'oidc.example';
const CLIENT_ID = 'e2e-client-id';
const CALLBACK_URI = 'eu.qwky.trinity:/sso-callback';
const OIDC_CONTINUE = '[data-testid="oidc-continue"]';
const OIDC_REGISTER = '[data-testid="oidc-register"]';

interface OidcCaseContext {
  readonly client: AccountWorkspaceClient;
  readonly device: MaestroDevice;
  readonly workspaceRoot: string;
  readonly directory: string;
  readonly secrets: Record<string, string>;
  readonly signal: AbortSignal;
}

interface OidcCase {
  readonly id: string;
  readonly source: string;
  readonly profile: AccountViewportProfile;
  readonly mode: OidcLoginFixtureMode;
  run(context: OidcCaseContext): Promise<void>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  recorded: Set<OidcLoginAssertion>,
  identity: OidcLoginAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function discover(client: AccountWorkspaceClient): Promise<void> {
  await client.focusCurrent('#homeserver');
  await client.fillFocused('#homeserver', HS_DOMAIN);
  await client.tapCurrent('button', { exactText: 'Continue' });
}

async function closeFixture(
  fixture: OidcLoginFixture | undefined,
  failures: unknown[],
): Promise<void> {
  if (!fixture) return;
  try {
    await fixture.close();
  } catch (error) {
    failures.push(error);
  }
}

async function openFixture(
  mode: OidcLoginFixtureMode,
  stageId: string,
  context: OidcCaseContext,
): Promise<OidcLoginFixture> {
  const connection = await context.client.webview.openSession();
  return installOidcLoginFixture({
    mode,
    app: connection,
    device: context.device,
    workspaceRoot: context.workspaceRoot,
    artifactDirectory: context.directory,
    signal: context.signal,
    registerSecret(name, value) {
      context.secrets[`${stageId}_${name}`] = value;
    },
  });
}

async function recordAuthorizeAssertions(
  client: AccountWorkspaceClient,
  recorded: Set<OidcLoginAssertion>,
  authorize: OidcAuthorizeObservation,
): Promise<void> {
  assert(authorize.requestPresent);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.authorizeRequestPresent,
    { present: true },
  );
  assert.equal(authorize.clientId, CLIENT_ID);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.clientIdExact,
    { clientId: authorize.clientId },
  );
  assert.equal(authorize.responseType, 'code');
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.responseTypeCode,
    { responseType: authorize.responseType },
  );
  assert.equal(authorize.challengeMethod, 'S256');
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.challengeMethodS256,
    { challengeMethod: authorize.challengeMethod },
  );
  assert(authorize.challengePresent);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.challengeNonempty,
    { present: true },
  );
  assert(authorize.statePresent);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.stateNonempty,
    { present: true },
  );
  assert.equal(authorize.callbackUri, CALLBACK_URI);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.callbackUriExact,
    { callbackUri: authorize.callbackUri },
  );
  assert.equal(authorize.registrationApplicationType, 'native');
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.registrationApplicationTypeNative,
    { applicationType: authorize.registrationApplicationType },
  );
  assert(authorize.scopeClientApi);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.scopeClientApi,
    { present: true },
  );
  assert(authorize.scopeDevice);
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.scopeDevice,
    { present: true },
  );
  assert.equal(authorize.responseMode, 'query');
  await recordAssertion(
    client,
    recorded,
    assertions.providerError.responseModeQuery,
    { responseMode: authorize.responseMode },
  );
}

async function recordTokenAssertions(
  client: AccountWorkspaceClient,
  recorded: Set<OidcLoginAssertion>,
  token: OidcTokenObservation,
): Promise<void> {
  assert(token.requestPresent);
  await recordAssertion(
    client,
    recorded,
    assertions.redemption.tokenRequestPresent,
    { present: true },
  );
  assert.equal(token.grantType, 'authorization_code');
  await recordAssertion(
    client,
    recorded,
    assertions.redemption.grantTypeAuthorizationCode,
    { grantType: token.grantType },
  );
  assert(token.codeExact);
  await recordAssertion(
    client,
    recorded,
    assertions.redemption.authorizationCodeExact,
    { exact: true },
  );
  assert.equal(token.clientId, CLIENT_ID);
  await recordAssertion(
    client,
    recorded,
    assertions.redemption.tokenClientIdExact,
    { clientId: token.clientId },
  );
  assert(token.verifierPresent);
  await recordAssertion(
    client,
    recorded,
    assertions.redemption.verifierNonempty,
    { present: true },
  );
  assert(token.pkceMatches);
  await recordAssertion(
    client,
    recorded,
    assertions.redemption.pkceS256Match,
    { matches: true },
  );
}

function createCases(): readonly OidcCase[] {
  return [
    {
      id: 'delegated-classification',
      source: OIDC_LOGIN_SOURCES.classification,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      mode: 'classification',
      async run(context) {
        const recorded = new Set<OidcLoginAssertion>();
        let fixture: OidcLoginFixture | undefined;
        const failures: unknown[] = [];
        try {
          fixture = await openFixture('classification', this.id, context);
          await discover(context.client);
          const delegated = await context.client.visible(
            OIDC_CONTINUE,
            {},
            30_000,
          );
          await recordAssertion(
            context.client,
            recorded,
            assertions.classification.delegatedContinueVisible,
            { visible: delegated.visible },
          );
          const create = await context.client.visible(
            OIDC_REGISTER,
            {},
            30_000,
          );
          await recordAssertion(
            context.client,
            recorded,
            assertions.classification.createAccountVisible,
            { visible: create.visible },
          );
          await context.client.expectCount('button', 0, {
            exactText: 'Sign in',
          });
          await recordAssertion(
            context.client,
            recorded,
            assertions.classification.passwordActionAbsent,
            { count: 0 },
          );
          await context.client.expectCount('button', 0, {
            exactText: 'Continue with SSO',
          });
          await recordAssertion(
            context.client,
            recorded,
            assertions.classification.legacySsoActionAbsent,
            { count: 0 },
          );
          fixture.assertComplete();
          assert.deepEqual(
            [...recorded].sort(),
            Object.values(assertions.classification).sort(),
          );
        } catch (error) {
          failures.push(error);
        } finally {
          await closeFixture(fixture, failures);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(
            failures,
            'OIDC delegated classification stage failed',
          );
        }
      },
    },
    {
      id: 'provider-error-callback',
      source: OIDC_LOGIN_SOURCES.providerError,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      mode: 'provider-error',
      async run(context) {
        const recorded = new Set<OidcLoginAssertion>();
        let fixture: OidcLoginFixture | undefined;
        const failures: unknown[] = [];
        try {
          fixture = await openFixture('provider-error', this.id, context);
          await discover(context.client);
          await context.client.visible(OIDC_CONTINUE, {}, 30_000);
          await fixture.prepareChrome();
          await context.client.tapCurrent(OIDC_CONTINUE);
          const authorize = await fixture.waitForAuthorization(context.signal);
          const callbackBody = await context.client.visible(
            '[data-testid="sso-callback-body"]',
            {},
            60_000,
          );
          assert(callbackBody.text.includes('E2E declined'));
          await recordAssertion(
            context.client,
            recorded,
            assertions.providerError.providerErrorVisible,
            { text: 'E2E declined', visible: true },
          );
          const back = await context.client.visible('button', {
            exactText: 'Back to sign in',
          });
          await recordAssertion(
            context.client,
            recorded,
            assertions.providerError.backToSignInVisible,
            { visible: back.visible },
          );
          await recordAuthorizeAssertions(
            context.client,
            recorded,
            authorize,
          );
          fixture.assertComplete();
          assert.deepEqual(
            [...recorded].sort(),
            Object.values(assertions.providerError).sort(),
          );
        } catch (error) {
          failures.push(error);
        } finally {
          await closeFixture(fixture, failures);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(
            failures,
            'OIDC provider-error callback stage failed',
          );
        }
      },
    },
    {
      id: 'durable-pkce-redemption',
      source: OIDC_LOGIN_SOURCES.redemption,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      mode: 'redemption',
      async run(context) {
        const recorded = new Set<OidcLoginAssertion>();
        let fixture: OidcLoginFixture | undefined;
        const failures: unknown[] = [];
        try {
          fixture = await openFixture('redemption', this.id, context);
          await discover(context.client);
          await context.client.visible(OIDC_CONTINUE, {}, 30_000);
          await fixture.prepareChrome();
          await context.client.tapCurrent(OIDC_CONTINUE);
          await fixture.waitForAuthorization(context.signal);
          const token = await fixture.waitForToken(context.signal);
          await recordTokenAssertions(context.client, recorded, token);
          const verificationErrors = await context.client.elements(
            '[data-testid="sso-callback-body"], [data-testid="sso-callback-body"] *',
            { text: 'could not be verified' },
          );
          const detailErrors = await context.client.elements(
            '[data-testid="sso-callback-body"], [data-testid="sso-callback-body"] *',
            { text: 'Missing sign-in details' },
          );
          assert.equal(
            verificationErrors.some((element) => element.visible),
            false,
          );
          assert.equal(
            detailErrors.some((element) => element.visible),
            false,
          );
          await recordAssertion(
            context.client,
            recorded,
            assertions.redemption.callbackErrorsAbsent,
            { verificationErrorCount: 0, missingDetailCount: 0 },
          );
          fixture.assertComplete();
          assert.deepEqual(
            [...recorded].sort(),
            Object.values(assertions.redemption).sort(),
          );
        } catch (error) {
          failures.push(error);
        } finally {
          await closeFixture(fixture, failures);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(
            failures,
            'OIDC durable PKCE redemption stage failed',
          );
        }
      },
    },
    {
      id: 'password-fallback',
      source: OIDC_LOGIN_SOURCES.fallback,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      mode: 'fallback',
      async run(context) {
        const recorded = new Set<OidcLoginAssertion>();
        let fixture: OidcLoginFixture | undefined;
        const failures: unknown[] = [];
        try {
          fixture = await openFixture('fallback', this.id, context);
          await discover(context.client);
          const password = await context.client.visible(
            'button',
            { exactText: 'Sign in' },
            30_000,
          );
          await recordAssertion(
            context.client,
            recorded,
            assertions.fallback.passwordActionVisible,
            { visible: password.visible },
          );
          await context.client.expectCount(OIDC_CONTINUE, 0);
          await recordAssertion(
            context.client,
            recorded,
            assertions.fallback.delegatedContinueAbsent,
            { count: 0 },
          );
          fixture.assertComplete();
          assert.deepEqual(
            [...recorded].sort(),
            Object.values(assertions.fallback).sort(),
          );
        } catch (error) {
          failures.push(error);
        } finally {
          await closeFixture(fixture, failures);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) {
          throw new AggregateError(
            failures,
            'OIDC password fallback stage failed',
          );
        }
      },
    },
  ];
}

assert.equal(
  Object.values(assertions).flatMap((group) => Object.values(group)).length,
  26,
  'Exactly 26 OIDC-native login assertion identities are required',
);

void test(
  'Android OIDC-native login journeys',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'oidc-login',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        matrixResources.cleanup('Redact OIDC-login diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const cases = createCases();
        assert.equal(cases.length, 4, 'Exactly four OIDC stages exist');
        const stages: Array<{
          readonly id: string;
          readonly source: string;
          readonly mode: OidcLoginFixtureMode;
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
                expectedStages: 4,
                expectedAssertions: 26,
                attempt: 1,
                retries: 0,
                sources: OIDC_LOGIN_SOURCES,
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
        matrixResources.cleanup('OIDC-login Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup('OIDC-login Android WebView', async () =>
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
            mode: entry.mode,
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
          console.info(`[oidc-login] ${entry.id} start`);
          try {
            await client.reset(entry.profile);
            await entry.run({
              client,
              device,
              workspaceRoot: session.workspaceRoot,
              directory,
              secrets,
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
              `[oidc-login] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `OIDC login journey ${entry.id} failed`,
            );
          }
        }
        await writeFile(
          join(output, 'suite-summary.json'),
          `${JSON.stringify(
            {
              attempt: 1,
              retries: 0,
              expectedStages: 4,
              passedStages: stages.filter((stage) => stage.status === 'passed')
                .length,
              expectedAssertions: 26,
            },
            null,
            2,
          )}\n`,
        );
      },
    );
  },
);
