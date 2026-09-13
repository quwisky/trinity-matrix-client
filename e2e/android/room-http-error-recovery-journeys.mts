import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountWorkspaceCase,
  type AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  installFirstMatrixHttpFailure,
  type MatrixHttpFault,
  type MatrixRequestKind,
} from './matrix-http-fault.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

const inviteSource =
  'e2e/browser/journeys/room-library/room-http-error-recovery.spec.mts:73-127';
const joinSource =
  'e2e/browser/journeys/room-library/room-http-error-recovery.spec.mts:129-192';
const failureMessage = 'The homeserver is unavailable. Try again.';

const assertions = {
  inviteFailureFeedback: 'invite.failure-feedback',
  inviteActionReenabled: 'invite.action-reenabled',
  inviteSuccessFeedback: 'invite.success-feedback',
  inviteTwoTransportAttempts: 'invite.two-transport-attempts',
  inviteRealMembership: 'invite.real-membership',
  joinInviteVisible: 'join.invite-visible',
  joinFailureFeedback: 'join.failure-feedback',
  joinActionReenabled: 'join.action-reenabled',
  joinRoomVisible: 'join.room-visible',
  joinTwoTransportAttempts: 'join.two-transport-attempts',
  joinRealMembership: 'join.real-membership',
} as const;

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  try {
    const elements = await client.waitElements(
      selector,
      accepts,
      assertion,
      filter,
      timeoutMs,
    );
    await client.record(assertion, { assertion, observation: elements });
    return elements;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: readonly AccountElement[] | null = null;
    try {
      observation = await client.elements(selector, filter);
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    try {
      await client.record(assertion, {
        assertion,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertion}: ${describeFailure(error)}`,
    );
  }
}

async function exactFeedbackDuringNativeAction(
  client: AccountWorkspaceClient,
  assertion: string,
  message: string,
  action: () => Promise<void>,
): Promise<void> {
  const capture = '__trinityE2eFeedbackCapture';
  await evaluateNative(client.webview, `(() => {
    const capture = ${JSON.stringify(capture)};
    window[capture]?.observer?.disconnect();
    const messages = [];
    const sample = () => {
      for (const element of document.querySelectorAll('[data-sonner-toast]')) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible') continue;
        const text = element.textContent?.trim() ?? '';
        if (text && !messages.includes(text)) messages.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    window[capture] = { messages, observer };
    sample();
    return true;
  })()`);
  const failures: unknown[] = [];
  let messages: readonly string[] = [];
  try {
    await action();
    messages = await waitForNativeShellState(
      async () => {
        const value = await evaluateNative(
          client.webview,
          `window[${JSON.stringify(capture)}]?.messages ?? []`,
        );
        assert(
          Array.isArray(value) &&
            value.every((entry) => typeof entry === 'string'),
          `${assertion}: captured feedback must be text`,
        );
        return value as string[];
      },
      (observed) => observed.includes(message),
      assertion,
      client.signal,
      15_000,
    );
    await client.record(assertion, { assertion, message, observed: messages });
  } catch (error) {
    failures.push(error);
    try {
      await client.record(assertion, {
        assertion,
        message,
        observed: messages,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  } finally {
    try {
      await evaluateNative(client.webview, `(() => {
        const capture = ${JSON.stringify(capture)};
        const observer = window[capture]?.observer;
        if (observer) observer.disconnect();
        delete window[capture];
        return true;
      })()`);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, `${assertion}: feedback capture failed`);
  }
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel__name', { exactText: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible('[data-testid="composer-input"]', {}, 30_000);
}

async function openInvitePicker(client: AccountWorkspaceClient): Promise<void> {
  await client.tapCurrent('[data-testid="room-actions-overflow"]');
  await client.tapCurrent('[data-testid="overflow-invite-people"]');
  await client.visible('[aria-label="@user:server or a name"]');
}

async function submitInvite(
  client: AccountWorkspaceClient,
  userId: string,
  assertion: string,
  message: string,
): Promise<void> {
  await client.fill('[aria-label="@user:server or a name"]', userId);
  await exactFeedbackDuringNativeAction(client, assertion, message, () =>
    client.tapCurrent('.picker button', { exactText: 'Invite' }),
  );
}

async function pressNativeBack(client: AccountWorkspaceClient): Promise<void> {
  await client.device.runFlow(
    join(client.workspaceRoot, 'e2e/android/flows/native-shell-back.yaml'),
    { APP_ID: 'eu.qwky.trinity' },
  );
}

async function withTransportFault<T>(
  context: AccountWorkspaceCaseContext,
  kind: MatrixRequestKind,
  status: number,
  operation: (fault: MatrixHttpFault) => Promise<T>,
): Promise<T> {
  const { client, resources } = context;
  const connection = await client.webview.openSession();
  let fault: MatrixHttpFault | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    try {
      await fault?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `${kind} transport instrumentation cleanup failed`,
      );
    }
  };
  resources.cleanup(`${kind} transport instrumentation`, cleanup);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    fault = await installFirstMatrixHttpFailure(connection, { kind, status });
    result = await operation(fault);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record('transport', {
        kind,
        injectedStatus: status,
        matchingAttempts: fault?.attempts ?? 0,
        firstOutcome: fault?.firstOutcome,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, `${kind} transport operation failed`);
  }
  return result as T;
}

async function realMembership(
  context: AccountWorkspaceCaseContext,
  assertion: string,
  observer: NodeWorkspaceAccount,
  roomId: string,
  member: NodeWorkspaceAccount,
  expected: 'invite' | 'join',
): Promise<void> {
  const membership = await waitForNativeShellState(
    () => context.fixtures.roomMembership(observer, roomId, member),
    (value) => value === expected,
    assertion,
    context.signal,
    30_000,
  );
  assert.equal(membership, expected, `${assertion}: real Matrix membership`);
  await context.client.record(assertion, { assertion, membership });
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'outbound-invite-retry',
    source: inviteSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('http-invite-owner');
      const target = await fixtures.account('http-invite-target');
      const room = await fixtures.createRoom(owner, {
        name: `Invite recovery ${resources.roomName('http-invite')}`,
        preset: 'private_chat',
      });

      await client.login(owner);
      await openRoom(client, room.name);
      await withTransportFault(context, 'invite', 503, async (fault) => {
        await openInvitePicker(client);
        await submitInvite(
          client,
          target.userId,
          assertions.inviteFailureFeedback,
          failureMessage,
        );

        await client.tapCurrent('[data-testid="room-actions-overflow"]');
        await observedElements(
          client,
          assertions.inviteActionReenabled,
          '[data-testid="overflow-invite-people"]',
          (elements) =>
            elements.length === 1 &&
            elements[0]!.visible &&
            !elements[0]!.disabled,
        );
        await client.tapCurrent('[data-testid="overflow-invite-people"]');
        await submitInvite(
          client,
          target.userId,
          assertions.inviteSuccessFeedback,
          `Invitation sent to ${target.userId}.`,
        );

        const attempts = await fault.waitForAttempts(2, signal);
        assert.equal(
          attempts,
          2,
          `${assertions.inviteTwoTransportAttempts}: exact request count`,
        );
        await client.record(assertions.inviteTwoTransportAttempts, {
          assertion: assertions.inviteTwoTransportAttempts,
          attempts,
        });
        await realMembership(
          context,
          assertions.inviteRealMembership,
          owner,
          room.id,
          target,
          'invite',
        );
        fixtures.trackRoomMembership(target, room.id);
      });
    },
  },
  {
    id: 'incoming-join-retry',
    source: joinSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('http-join-owner');
      const target = await fixtures.account('http-join-target');
      const room = await fixtures.createRoom(owner, {
        name: `Join recovery ${resources.roomName('http-join')}`,
        preset: 'private_chat',
        invite: [target.userId],
      });
      fixtures.trackRoomMembership(target, room.id);
      const acceptSelector = `button[aria-label=${JSON.stringify(
        `Accept invite to ${room.name}`,
      )}]`;

      await client.login(target);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await observedElements(
        client,
        assertions.joinInviteVisible,
        acceptSelector,
        (elements) => elements.length === 1 && elements[0]!.visible,
        {},
        30_000,
      );
      await withTransportFault(context, 'join', 502, async (fault) => {
        await exactFeedbackDuringNativeAction(
          client,
          assertions.joinFailureFeedback,
          failureMessage,
          () => client.tapCurrent(acceptSelector),
        );
        await observedElements(
          client,
          assertions.joinActionReenabled,
          acceptSelector,
          (elements) =>
            elements.length === 1 &&
            elements[0]!.visible &&
            !elements[0]!.disabled,
        );

        await client.tapCurrent(acceptSelector);
        await client.visible('[data-testid="composer-input"]', {}, 30_000);
        await pressNativeBack(client);
        await observedElements(
          client,
          assertions.joinRoomVisible,
          '.channel__name',
          (elements) => elements.length === 1 && elements[0]!.visible,
          { exactText: room.name },
          30_000,
        );

        const attempts = await fault.waitForAttempts(2, signal);
        assert.equal(
          attempts,
          2,
          `${assertions.joinTwoTransportAttempts}: exact request count`,
        );
        await client.record(assertions.joinTwoTransportAttempts, {
          assertion: assertions.joinTwoTransportAttempts,
          attempts,
        });
        await realMembership(
          context,
          assertions.joinRealMembership,
          owner,
          room.id,
          target,
          'join',
        );
      });
    },
  },
];

assert.equal(
  cases.length,
  2,
  'Exactly two room HTTP-error recovery stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  11,
  'Exactly eleven direct assertions are required',
);

void test(
  'Android room HTTP-error recovery journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-http-error-recovery',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets[`PASSWORD_${account.username}`] = account.password;
            return account;
          },
        };
        matrixResources.cleanup(
          'Redact room HTTP-error recovery diagnostics',
          () => redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup(
          'Room HTTP-error recovery Android device',
          () => device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room HTTP-error recovery Android WebView',
          async () => client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
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
            `${JSON.stringify({ expectedStages: cases.length, stages }, null, 2)}\n`,
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
          console.info(`[room-http-error-recovery] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? PIXEL_5_ACCOUNT_PROFILE);
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
            await save();
            console.info(
              `[room-http-error-recovery] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room HTTP-error recovery journey ${entry.id} failed`,
            );
          }
        }
        assert.equal(
          stages.filter((stage) => stage.status === 'passed').length,
          cases.length,
        );
      },
    );
  },
);
