import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  ACCOUNT_PASSWORD_CHANGE_SOURCES,
  accountPasswordChangeAssertions as assertions,
  type AccountPasswordChangeAssertion,
} from './account-password-change-contract.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

const SETTINGS_DETAIL = '[data-testid="settings-detail"]';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  identity: AccountPasswordChangeAssertion,
  observation: unknown,
): Promise<void> {
  await client.record(identity, { assertion: identity, observation });
}

async function observedElements(
  client: AccountWorkspaceClient,
  identity: AccountPasswordChangeAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  let observation: readonly AccountElement[] | null = null;
  try {
    const elements = await waitForNativeShellState(
      async () => {
        const latest = await client.elements(selector);
        observation = latest;
        return latest;
      },
      accepts,
      identity,
      client.signal,
      timeoutMs,
    );
    await recordAssertion(client, identity, elements);
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

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
}

async function probeLoginStatus(
  username: string,
  password: string,
  signal: AbortSignal,
): Promise<number> {
  let accessToken: string | undefined;
  const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
      initial_device_display_name: 'Android password-change probe',
    }),
    signal: requestSignal(signal),
  });
  const status = response.status;
  try {
    if (status === 200) {
      const body: unknown = await response.json();
      assert(body && typeof body === 'object');
      assert('access_token' in body && typeof body.access_token === 'string');
      accessToken = body.access_token;
    }
    return status;
  } finally {
    if (accessToken !== undefined) {
      const logout = await fetch(
        `${SYNAPSE_HTTP}/_matrix/client/v3/logout`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: requestSignal(),
        },
      );
      assert.equal(logout.status, 200, 'Password probe session logout');
    }
  }
}

async function passwordFieldsMatch(
  client: AccountWorkspaceClient,
  expectedHash: string,
): Promise<{ readonly newPassword: boolean; readonly confirmation: boolean }> {
  const value = await evaluateNative(
    client.webview,
    `(async()=>{const hex=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');const newField=document.querySelector('#new-password'),confirmation=document.querySelector('#confirm-password');if(!(newField instanceof HTMLInputElement)||!(confirmation instanceof HTMLInputElement))return null;const expected=${JSON.stringify(expectedHash)};return {newPassword:(await hex(newField.value))===expected,confirmation:(await hex(confirmation.value))===expected}})()`,
  );
  assert(value && typeof value === 'object');
  assert('newPassword' in value && typeof value.newPassword === 'boolean');
  assert('confirmation' in value && typeof value.confirmation === 'boolean');
  return value as { readonly newPassword: boolean; readonly confirmation: boolean };
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'password-change',
    source: ACCOUNT_PASSWORD_CHANGE_SOURCES.journey,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures }) {
      const account = await fixtures.account('account-password-change');
      const oldPassword = account.password;
      const newPassword = `${account.password}-new`;
      const wrongPassword = `${account.password}-wrong`;
      assert.notEqual(newPassword, oldPassword);
      assert.notEqual(wrongPassword, oldPassword);
      assert.notEqual(wrongPassword, newPassword);

      await client.login(account);
      const rooms = await waitForNativeShellState(
        () => client.surface(),
        (surface) => {
          const url = new URL(surface.url);
          return (
            url.pathname.startsWith('/rooms') &&
            url.searchParams.get('account') === account.userId
          );
        },
        assertions.roomsAccountQualified,
        client.signal,
        60_000,
      );
      const roomsUrl = new URL(rooms.url);
      await recordAssertion(client, assertions.roomsAccountQualified, {
        pathname: roomsUrl.pathname,
        accountQualified: roomsUrl.searchParams.get('account') === account.userId,
      });

      await client.tapCurrent('[data-testid="open-settings"]');
      await observedElements(
        client,
        assertions.settingsNavigationVisible,
        '[aria-label="Settings sections"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="settings-nav-account"]');
      await waitForNativeShellState(
        () => client.surface(),
        (surface) => new URL(surface.url).pathname === '/settings/account',
        'Account settings route',
        client.signal,
      );
      await observedElements(
        client,
        assertions.settingsDetailNonEmpty,
        SETTINGS_DETAIL,
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.text.trim().length > 0,
      );
      await observedElements(
        client,
        assertions.formReady,
        '#current-password',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          !elements[0]!.disabled,
      );

      await client.scrollIntoViewIfNeeded('#current-password', SETTINGS_DETAIL);
      await client.fill('#current-password', wrongPassword);
      await client.scrollIntoViewIfNeeded('#new-password', SETTINGS_DETAIL);
      await client.fill('#new-password', newPassword);
      await client.scrollIntoViewIfNeeded('#confirm-password', SETTINGS_DETAIL);
      await client.fill('#confirm-password', newPassword);
      await client.scrollIntoViewIfNeeded(
        '[data-testid="change-password"]',
        SETTINGS_DETAIL,
      );
      await client.tapCurrent('[data-testid="change-password"]');

      const expectedNewHash = createHash('sha256')
        .update(newPassword)
        .digest('hex');
      const error = await waitForNativeShellState(
        () => client.elements('[data-testid="account-error"]'),
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.text.includes('current password is incorrect'),
        assertions.wrongCurrentFeedback,
        client.signal,
        20_000,
      );
      const retained = await passwordFieldsMatch(client, expectedNewHash);
      assert.equal(retained.newPassword, true, 'New password remains exact');
      assert.equal(retained.confirmation, true, 'Confirmation remains exact');
      await recordAssertion(client, assertions.wrongCurrentFeedback, {
        feedback: error[0]!.text,
        newPasswordRetained: retained.newPassword,
        confirmationRetained: retained.confirmation,
      });

      await client.scrollIntoViewIfNeeded('#current-password', SETTINGS_DETAIL);
      await client.fill('#current-password', oldPassword);
      await client.scrollIntoViewIfNeeded(
        '[data-testid="change-password"]',
        SETTINGS_DETAIL,
      );
      await client.tapCurrent('[data-testid="change-password"]');
      await observedElements(
        client,
        assertions.successToast,
        '[aria-label="Notifications alt+T"] [data-sonner-toast]',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.text.includes('Password changed.'),
        20_000,
      );

      const newStatus = await probeLoginStatus(
        account.username,
        newPassword,
        client.signal,
      );
      assert.equal(newStatus, 200, 'New password login status');
      await recordAssertion(
        client,
        assertions.newPasswordLoginStatus,
        newStatus,
      );
      const oldStatus = await probeLoginStatus(
        account.username,
        oldPassword,
        client.signal,
      );
      assert(oldStatus === 403, 'Old password login status');
      await recordAssertion(
        client,
        assertions.oldPasswordLoginStatus,
        oldStatus,
      );
    },
  },
];

assert.equal(cases.length, 1, 'Exactly one password-change stage is required');
assert.equal(
  Object.keys(assertions).length,
  8,
  'Exactly eight password-change assertions are required',
);

void test(
  'Android account password-change journey',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'account-password-change',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets.PASSWORD_OLD = account.password;
            secrets.PASSWORD_NEW = `${account.password}-new`;
            secrets.PASSWORD_WRONG = `${account.password}-wrong`;
            return account;
          },
        };
        matrixResources.cleanup('Redact password-change diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
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
        matrixResources.cleanup('Password-change Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Password-change Android WebView',
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
          console.info(`[account-password-change] ${entry.id} start`);
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
              `[account-password-change] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Account password-change journey ${entry.id} failed`,
            );
          }
        }
      },
    );
  },
);
