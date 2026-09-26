import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountViewportProfile,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  securitySettingsAssertions as assertions,
  SECURITY_SETTINGS_SOURCES,
  type SecuritySettingsAssertion,
} from './security-settings-contract.mts';

const NARROW_SECURITY_PROFILE: AccountViewportProfile = {
  width: 700,
  height: 760,
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
};

interface NavigationAssertions {
  readonly rooms: SecuritySettingsAssertion;
  readonly navigation: SecuritySettingsAssertion;
  readonly detail: SecuritySettingsAssertion;
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
  recorded: Set<SecuritySettingsAssertion>,
  identity: SecuritySettingsAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function observedElements(
  client: AccountWorkspaceClient,
  recorded: Set<SecuritySettingsAssertion>,
  identity: SecuritySettingsAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  let observation: readonly AccountElement[] | null = null;
  try {
    const elements = await waitForNativeShellState(
      async () => {
        const latest = await client.elements(selector, filter);
        observation = latest;
        return latest;
      },
      accepts,
      identity,
      client.signal,
      timeoutMs,
    );
    await recordAssertion(client, recorded, identity, elements);
    return elements;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(identity, {
        assertion: identity,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${identity}: ${describeFailure(error)}`,
    );
  }
}

function oneVisible(elements: readonly AccountElement[]): boolean {
  return elements.length === 1 && elements[0]!.visible;
}

function oneVisibleFocused(elements: readonly AccountElement[]): boolean {
  return oneVisible(elements) && elements[0]!.focused;
}

async function openSecuritySettings(
  client: AccountWorkspaceClient,
  recorded: Set<SecuritySettingsAssertion>,
  accountId: string,
  owned: NavigationAssertions,
): Promise<void> {
  const rooms = await waitForNativeShellState(
    () => client.surface(),
    (surface) => {
      const url = new URL(surface.url);
      return (
        url.pathname.startsWith('/rooms') &&
        url.searchParams.get('account') === accountId
      );
    },
    owned.rooms,
    client.signal,
    60_000,
  );
  const roomsUrl = new URL(rooms.url);
  await recordAssertion(client, recorded, owned.rooms, {
    pathname: roomsUrl.pathname,
    accountQualified: roomsUrl.searchParams.get('account') === accountId,
  });

  await client.tapCurrent('[data-testid="open-settings"]');
  await observedElements(
    client,
    recorded,
    owned.navigation,
    '[aria-label="Settings sections"]',
    oneVisible,
  );
  await client.tapCurrent('[data-testid="settings-nav-security"]');
  const detail = await waitForNativeShellState(
    async () => {
      const surface = await client.surface();
      const elements = await client.elements('[data-testid="settings-detail"]');
      return { surface, elements };
    },
    ({ surface, elements }) =>
      new URL(surface.url).pathname === '/settings/security' &&
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text.trim().length > 0,
    owned.detail,
    client.signal,
    30_000,
  );
  await recordAssertion(client, recorded, owned.detail, {
    pathname: new URL(detail.surface.url).pathname,
    nonEmpty: detail.elements[0]!.text.trim().length > 0,
  });
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'fresh-posture-setup',
    source: SECURITY_SETTINGS_SOURCES.posture,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures }) {
      const recorded = new Set<SecuritySettingsAssertion>();
      const account = await fixtures.account('security-posture');
      await client.login(account);
      await openSecuritySettings(client, recorded, account.userId, {
        rooms: assertions.postureRoomsAccountQualified,
        navigation: assertions.postureSettingsNavigationVisible,
        detail: assertions.postureSettingsDetailNonEmpty,
      });

      await observedElements(
        client,
        recorded,
        assertions.postureRootVisible,
        '[data-testid="security-settings"]',
        oneVisible,
      );
      await observedElements(
        client,
        recorded,
        assertions.postureSessionVisible,
        '[data-testid="security-session"]',
        oneVisible,
      );
      await observedElements(
        client,
        recorded,
        assertions.postureBackupVisible,
        '[data-testid="security-backup"]',
        oneVisible,
      );
      await observedElements(
        client,
        recorded,
        assertions.postureVerifyVisible,
        '[data-testid="security-verify"]',
        oneVisible,
      );

      const setup = await client.waitElements(
        '[data-testid="security-setup"]',
        oneVisible,
        'visible Set up recovery action',
        {},
        20_000,
      );
      await client.tapCurrent('[data-testid="security-setup"]');
      const setupRoute = await waitForNativeShellState(
        () => client.surface(),
        (surface) => {
          const url = new URL(surface.url);
          return (
            url.pathname === '/encryption/setup' &&
            url.searchParams.get('returnTo') === '/settings/security'
          );
        },
        assertions.postureSetupVisibleAndRoute,
        client.signal,
        20_000,
      );
      const setupUrl = new URL(setupRoute.url);
      await recordAssertion(
        client,
        recorded,
        assertions.postureSetupVisibleAndRoute,
        {
          visible: setup[0]!.visible,
          pathname: setupUrl.pathname,
          returnTo: setupUrl.searchParams.get('returnTo'),
        },
      );

      assert.deepEqual(
        [...recorded].sort(),
        [
          assertions.postureRoomsAccountQualified,
          assertions.postureSettingsNavigationVisible,
          assertions.postureSettingsDetailNonEmpty,
          assertions.postureRootVisible,
          assertions.postureSessionVisible,
          assertions.postureBackupVisible,
          assertions.postureVerifyVisible,
          assertions.postureSetupVisibleAndRoute,
        ].sort(),
      );
    },
  },
  {
    id: 'narrow-verification-return',
    source: SECURITY_SETTINGS_SOURCES.narrow,
    profile: NARROW_SECURITY_PROFILE,
    async run({ client, fixtures }) {
      const recorded = new Set<SecuritySettingsAssertion>();
      const account = await fixtures.account('security-narrow');
      await client.login(account);
      await openSecuritySettings(client, recorded, account.userId, {
        rooms: assertions.narrowRoomsAccountQualified,
        navigation: assertions.narrowSettingsNavigationVisible,
        detail: assertions.narrowSettingsDetailNonEmpty,
      });

      await observedElements(
        client,
        recorded,
        assertions.narrowVerifyVisible,
        '[data-testid="security-verify"]',
        oneVisible,
      );
      await client.tapCurrent('[data-testid="security-verify"]');
      const verification = await waitForNativeShellState(
        async () => ({
          surface: await client.surface(),
          page: await client.elements('[data-testid="verify-page"]'),
        }),
        ({ surface, page }) => {
          const url = new URL(surface.url);
          return url.pathname === '/encryption/verify' && oneVisible(page);
        },
        assertions.narrowVerifyPageVisible,
        client.signal,
        20_000,
      );
      await recordAssertion(
        client,
        recorded,
        assertions.narrowVerifyPageVisible,
        {
          pathname: new URL(verification.surface.url).pathname,
          visible: verification.page[0]!.visible,
        },
      );
      await observedElements(
        client,
        recorded,
        assertions.narrowVerifyHeadingFocused,
        'h1, h2',
        oneVisibleFocused,
        { exactText: 'Verify device' },
      );

      await client.tapCurrent('button', { exactText: 'Close' });
      const returned = await waitForNativeShellState(
        async () => ({
          surface: await client.surface(),
          headings: await client.elements('h2', { exactText: 'Security' }),
        }),
        ({ surface, headings }) => {
          const url = new URL(surface.url);
          return (
            url.pathname === '/settings/security' &&
            oneVisibleFocused(headings)
          );
        },
        assertions.narrowSecurityHeadingFocused,
        client.signal,
        20_000,
      );
      await recordAssertion(
        client,
        recorded,
        assertions.narrowSecurityHeadingFocused,
        {
          pathname: new URL(returned.surface.url).pathname,
          text: returned.headings[0]!.text,
          focused: returned.headings[0]!.focused,
        },
      );

      assert.deepEqual(
        [...recorded].sort(),
        [
          assertions.narrowRoomsAccountQualified,
          assertions.narrowSettingsNavigationVisible,
          assertions.narrowSettingsDetailNonEmpty,
          assertions.narrowVerifyVisible,
          assertions.narrowVerifyPageVisible,
          assertions.narrowVerifyHeadingFocused,
          assertions.narrowSecurityHeadingFocused,
        ].sort(),
      );
    },
  },
];

assert.equal(cases.length, 2, 'Exactly two Security settings stages exist');
assert.equal(
  Object.keys(assertions).length,
  15,
  'Exactly 15 Security settings assertions are required',
);

void test(
  'Android Security settings journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'security-settings',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets[account.userId] = account.password;
            return account;
          },
        };
        matrixResources.cleanup('Redact Security settings diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
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
                expectedAssertions: Object.keys(assertions).length,
                attempt: 1,
                retries: 0,
                sources: SECURITY_SETTINGS_SOURCES,
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
        matrixResources.cleanup('Security settings Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup('Security settings Android WebView', async () =>
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
          console.info(`[security-settings] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? DESKTOP_ACCOUNT_PROFILE);
            await entry.run({
              client,
              fixtures,
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
              `[security-settings] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Security settings journey ${entry.id} failed`,
            );
          }
        }
        await writeFile(
          join(output, 'suite-summary.json'),
          `${JSON.stringify(
            {
              attempt: 1,
              retries: 0,
              expectedStages: cases.length,
              passedStages: stages.filter((stage) => stage.status === 'passed')
                .length,
              expectedAssertions: Object.keys(assertions).length,
            },
            null,
            2,
          )}\n`,
        );
      },
    );
  },
);
