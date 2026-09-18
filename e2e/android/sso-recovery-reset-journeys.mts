import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  ssoRecoveryResetAssertions as assertions,
  SSO_RECOVERY_RESET_SOURCES,
  type SsoRecoveryResetAssertion,
} from './sso-recovery-reset-contract.mts';
import { captureSecretSafe } from './recovery-reset-diagnostics.mts';
import {
  closeSsoApiSession,
  ensureSsoRecoveryState,
  openSsoApiSession,
  readSsoRecoveryState,
  type SsoApiSession,
} from './sso-recovery-reset-fixture.mts';
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
const REFUSAL_COPY =
  'Your identity provider has to reset encryption for this account';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const imageArtifactExtensions = new Set(['.jpeg', '.jpg', '.png', '.webp']);
const assertionCountObservers = new WeakMap<
  Set<SsoRecoveryResetAssertion>,
  (count: number) => void
>();

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function redactFailure(
  error: unknown,
  secrets: Readonly<Record<string, string>>,
): string {
  return Object.values(secrets)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (message, secret) => message.replaceAll(secret, '[REDACTED]'),
      describeFailure(error),
    );
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  recorded: Set<SsoRecoveryResetAssertion>,
  identity: SsoRecoveryResetAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
  assertionCountObservers.get(recorded)?.(recorded.size);
}

async function waitForRooms(client: AccountWorkspaceClient): Promise<void> {
  await waitForNativeShellState(
    () => client.surface(),
    (surface) => new URL(surface.url).pathname.startsWith('/rooms'),
    'SSO recovery-reset Rooms surface',
    client.signal,
    60_000,
  );
  await client.visible('[data-testid="rail-rooms"]', {}, 60_000);
}

async function openSecuritySettings(
  client: AccountWorkspaceClient,
): Promise<void> {
  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[aria-label="Settings sections"]', {}, 30_000);
  await client.tapCurrent('[data-testid="settings-nav-security"]');
  await client.visible('[data-testid="security-settings"]', {}, 30_000);
}

async function runRefusalStage(
  client: AccountWorkspaceClient,
  provider: LegacySsoProvider,
  homeserver: string,
  identity: { readonly email: string; readonly pass: string },
  apiSession: SsoApiSession,
  secrets: Record<string, string>,
  onAssertionCount: (count: number) => void,
): Promise<number> {
  const recorded = new Set<SsoRecoveryResetAssertion>();
  assertionCountObservers.set(recorded, onAssertionCount);
  const before = await ensureSsoRecoveryState(
    homeserver,
    apiSession,
    client.signal,
  );
  secrets.MASTER_KEY_SECRET = before.masterKey;
  assert(before.masterKey.length > 0);
  await recordAssertion(
    client,
    recorded,
    assertions.masterKeyBeforeNonempty,
    { nonEmpty: true },
  );
  assert(before.backupVersion.length > 0);
  await recordAssertion(
    client,
    recorded,
    assertions.backupVersionBeforeNonempty,
    { nonEmpty: true },
  );

  await client.focusCurrent('#homeserver');
  await client.fillFocused('#homeserver', homeserver);
  await client.tapCurrent('button', { exactText: 'Continue' });
  await client.visible('button', { exactText: 'Continue with SSO' }, 30_000);
  await client.hideKeyboard();
  await provider.prepare();
  await client.tapCurrent('button', { exactText: 'Continue with SSO' });
  await provider.completeDexSignIn(identity.email, identity.pass);
  await waitForRooms(client);

  await openSecuritySettings(client);
  await client.visible('[data-testid="security-unlock"]', {
    exactText: 'Enter recovery key',
  }, 60_000);
  await client.tapCurrent('[data-testid="security-unlock"]');
  const reset = await client.visible(
    '[data-testid="reset-recovery"]',
    { exactText: "I've lost my recovery key" },
    30_000,
  );
  await recordAssertion(client, recorded, assertions.resetActionVisible, {
    visible: reset.visible,
  });
  await client.tapCurrent('[data-testid="reset-recovery"]');
  const gate = await client.visible('trn-alert-dialog h2', {
    exactText: 'Reset encryption',
  });
  await recordAssertion(client, recorded, assertions.resetGateVisible, {
    visible: gate.visible,
  });
  await client.tapCurrent('trn-alert-dialog input');
  await client.fillFocused('trn-alert-dialog input', 'RESET');
  await client.tapCurrent('[data-testid="alert-confirm"]');

  const refusal = await client.visible(
    '[data-testid="unlock-error"]',
    { text: REFUSAL_COPY },
    60_000,
  );
  assert(refusal.text.includes(REFUSAL_COPY));
  await recordAssertion(
    client,
    recorded,
    assertions.identityProviderRefusalCopy,
    { exactRequiredCopy: true },
  );
  await client.expectCount('[data-testid="recovery-key"]', 0);
  await recordAssertion(client, recorded, assertions.recoveryKeyAbsent, {
    count: 0,
  });
  await client.expectCount('body *', 0, {
    exactText: 'Confirm your password',
  });
  await recordAssertion(client, recorded, assertions.passwordPromptAbsent, {
    count: 0,
  });

  const after = await readSsoRecoveryState(
    homeserver,
    apiSession,
    client.signal,
  );
  assert.equal(after.masterKey, before.masterKey);
  await recordAssertion(client, recorded, assertions.masterKeyUnchanged, {
    unchanged: true,
  });
  assert(
    after.backupVersion === before.backupVersion,
    'SSO recovery key-backup version is unchanged',
  );
  await recordAssertion(client, recorded, assertions.backupVersionUnchanged, {
    unchanged: true,
  });
  assert.deepEqual(
    [...recorded].sort(),
    Object.values(assertions).sort(),
  );
  return recorded.size;
}

export async function scanSsoRecoveryResetArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `SSO recovery-reset artifact is a file: ${path}`);
      if (!textArtifactExtensions.has(extname(path))) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of values) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      assert(!/\bBearer\s+\S+/u.test(text), `Bearer token is absent from ${path}`);
      assert(
        !/\bsyt_[A-Za-z0-9._~-]+/u.test(text),
        `Matrix access token is absent from ${path}`,
      );
    }
  }
  await scan(output);
}

export async function removeSsoRecoveryResetMaestroImages(
  output: string,
): Promise<void> {
  async function remove(directory: string, insideFlow: boolean): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const ownsFlow =
      insideFlow ||
      entries.some((entry) => entry.isFile() && entry.name === 'maestro.log');
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await remove(path, ownsFlow);
      } else if (
        ownsFlow &&
        entry.isFile() &&
        imageArtifactExtensions.has(extname(path))
      ) {
        await unlink(path);
      }
    }
  }
  await remove(output, false);
}

void test(
  'Android SSO recovery-reset refusal journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        assert(
          session.synapse?.available &&
            session.synapse.hs &&
            session.synapse.ssoReset,
          'SSO recovery-reset requires disposable Synapse and Dex',
        );
        const homeserver = session.synapse.hs;
        const identity = session.synapse.ssoReset;
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'sso-recovery-reset',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {
          DEX_EMAIL_SECRET: identity.email,
          DEX_PASSWORD: identity.pass,
        };
        matrixResources.cleanup('Scan SSO recovery-reset diagnostics', () =>
          scanSsoRecoveryResetArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact SSO recovery-reset diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        matrixResources.cleanup('Remove SSO recovery-reset images', () =>
          removeSsoRecoveryResetMaestroImages(output),
        );

        const stages: Array<{
          readonly id: 'sso-recovery-reset-refusal';
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionCount: 9;
          assertionCount: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 1,
                expectedAssertions: 9,
                attempt: 1,
                retries: 0,
                sources: SSO_RECOVERY_RESET_SOURCES,
                stages,
              },
              null,
              2,
            )}\n`,
          );
        await save();

        let device: MaestroDevice | undefined;
        let client: AccountWorkspaceClient | undefined;
        let provider: LegacySsoProvider | undefined;
        let apiSession: SsoApiSession | undefined;
        const failures: unknown[] = [];
        const stage: (typeof stages)[number] = {
          id: 'sso-recovery-reset-refusal',
          source: SSO_RECOVERY_RESET_SOURCES.refusal,
          status: 'running',
          durationMs: 0,
          artifact: 'sso-recovery-reset-refusal/**',
          attempt: 1,
          retries: 0,
          expectedAssertionCount: 9,
          assertionCount: 0,
        };
        stages.push(stage);
        await save();
        const started = performance.now();
        try {
          device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          await device.install(
            join(
              session.workspaceRoot,
              'android/app/build/outputs/apk/debug/app-debug.apk',
            ),
          );
          const stageOutput = join(output, stage.id);
          await mkdir(stageOutput, { recursive: true });
          client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            stageOutput,
            signal,
          );
          await client.reset(PIXEL_5_ACCOUNT_PROFILE);
          apiSession = await openSsoApiSession({
            homeserver,
            applicationOrigin: session.endpoints.application,
            identity,
            signal,
          });
          secrets.LOGIN_TOKEN = apiSession.loginToken;
          secrets.ACCESS_TOKEN = apiSession.accessToken;
          provider = await openLegacySsoProvider(
            device,
            session.workspaceRoot,
            stageOutput,
            signal,
          );
          stage.assertionCount = await runRefusalStage(
            client,
            provider,
            homeserver,
            identity,
            apiSession,
            secrets,
            (count) => {
              stage.assertionCount = count;
            },
          );
          await captureSecretSafe(client, 'passed');
        } catch (error) {
          failures.push(error);
          if (client) {
            try {
              await captureSecretSafe(client, 'failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          }
        } finally {
          if (provider) {
            try {
              await provider.close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (apiSession) {
            try {
              await closeSsoApiSession(homeserver, apiSession);
            } catch (error) {
              failures.push(error);
            }
          }
          if (client) {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (device) {
            try {
              await device.clearApplicationData(TRINITY_PACKAGE);
            } catch (error) {
              failures.push(error);
            }
            try {
              await device.close();
            } catch (error) {
              failures.push(error);
            }
          }
          stage.status = failures.length ? 'failed' : 'passed';
          stage.failureCount = failures.length;
          stage.durationMs = performance.now() - started;
          if (failures.length) {
            stage.error = failures
              .map((error) => redactFailure(error, secrets))
              .join('\n');
          }
          try {
            await save();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            'SSO recovery-reset refusal journey failed',
          );
        }
        assert.equal(stage.assertionCount, 9);
      },
    );
  },
);
