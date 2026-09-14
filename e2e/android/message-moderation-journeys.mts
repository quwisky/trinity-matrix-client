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
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import {
  MESSAGE_MODERATION_SOURCES,
  messageModerationAssertions as assertions,
  type MessageModerationAssertion,
} from './message-moderation-contract.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: MessageModerationAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  let observation: readonly AccountElement[] | null = null;
  let value: readonly AccountElement[];
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await client.elements(selector, filter);
        observation = latest;
        return latest;
      },
      accepts,
      assertionIdentity,
      client.signal,
      timeoutMs,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertionIdentity}: ${describeFailure(error)}`,
    );
  }
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    observation: value,
  });
  return value;
}

async function exactFeedbackDuringNativeAction(
  client: AccountWorkspaceClient,
  assertionIdentity: MessageModerationAssertion,
  message: string,
  action: () => Promise<void>,
): Promise<void> {
  const capture = '__trinityMessageModerationFeedback';
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
          `${assertionIdentity}: captured feedback must be text`,
        );
        return value as string[];
      },
      (observed) => observed.includes(message),
      assertionIdentity,
      client.signal,
      15_000,
    );
    await client.record(assertionIdentity, {
      assertion: assertionIdentity,
      message,
      observation: messages,
    });
  } catch (error) {
    failures.push(error);
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        message,
        observation: messages,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  } finally {
    try {
      await evaluateNative(client.webview, `(() => {
        const capture = ${JSON.stringify(capture)};
        window[capture]?.observer?.disconnect();
        delete window[capture];
        return true;
      })()`);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${assertionIdentity}: feedback capture failed`,
    );
  }
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'report-message',
    source: MESSAGE_MODERATION_SOURCES.report.definition,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const account = await fixtures.account('message-report');
      const room = await fixtures.createRoom(account, {
        name: `Report ${resources.roomName('message-report-room')}`,
        preset: 'private_chat',
      });
      const body = `report ${resources.roomName('message-report-body')}`;
      await fixtures.sendMessage(
        account,
        room.id,
        body,
        resources.roomName('message-report-event'),
      );

      await client.login(account);
      await openRoom(client, room.name);
      await observedElements(
        client,
        assertions.reportTimelineVisible,
        '.scroll',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.visible('.scroll .msg[data-mid]', { text: body }, 20_000);
      await client.longPressCurrent('.scroll .msg[data-mid]', { text: body });
      await client.visible('[data-testid="sheet-report"]');
      await client.scrollIntoViewIfNeeded(
        '[data-testid="sheet-report"]',
        '[data-testid="action-sheet-surface"] .overflow-y-auto',
      );
      await client.tapCurrent('[data-testid="sheet-report"]');
      await client.visible('[data-testid="alert-confirm"]');
      await exactFeedbackDuringNativeAction(
        client,
        assertions.reportSuccessToastVisible,
        'Reported to the server admins.',
        () => client.tapCurrent('[data-testid="alert-confirm"]'),
      );
    },
  },
  {
    id: 'redact-others',
    source: MESSAGE_MODERATION_SOURCES.redact.definition,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const admin = await fixtures.account('message-redact-admin');
      const member = await fixtures.account('message-redact-member');
      const room = await fixtures.createRoom(admin, {
        name: `Redact ${resources.roomName('message-redact-room')}`,
        preset: 'private_chat',
        invite: [member.userId],
      });
      await fixtures.join(member, room.id);
      const memberBody = `member ${resources.roomName('message-redact-body')}`;
      await fixtures.sendMessage(
        member,
        room.id,
        memberBody,
        resources.roomName('message-redact-event'),
      );

      await client.login(admin);
      await openRoom(client, room.name);
      await observedElements(
        client,
        assertions.redactTimelineVisible,
        '.scroll',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.visible(
        '.scroll .msg[data-mid]',
        { text: memberBody },
        20_000,
      );
      await client.longPressCurrent('.scroll .msg[data-mid]', {
        text: memberBody,
      });
      await client.visible('[data-testid="sheet-delete"]');
      await client.scrollIntoViewIfNeeded(
        '[data-testid="sheet-delete"]',
        '[data-testid="action-sheet-surface"] .overflow-y-auto',
      );
      await client.tapCurrent('[data-testid="sheet-delete"]');
      await client.visible('[data-testid="alert-confirm"]');
      await client.tapCurrent('[data-testid="alert-confirm"]');
      await observedElements(
        client,
        assertions.redactDeletedMarkerVisible,
        '.scroll .msg',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { text: '(message deleted)' },
      );
      await observedElements(
        client,
        assertions.redactOriginalBodyAbsent,
        '.scroll .msg',
        (elements) => elements.length === 0,
        { text: memberBody },
      );
    },
  },
];

assert.equal(
  cases.length,
  2,
  'Exactly two message moderation stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  5,
  'Exactly five message moderation assertions are required',
);

void test(
  'Android message moderation journeys',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'message-moderation',
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
        matrixResources.cleanup('Redact message moderation diagnostics', () =>
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
            `${JSON.stringify({ expectedStages: cases.length, stages }, null, 2)}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Message moderation Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Message moderation Android WebView',
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
          console.info(`[message-moderation] ${entry.id} start`);
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
              `[message-moderation] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Message moderation journey ${entry.id} failed`,
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
