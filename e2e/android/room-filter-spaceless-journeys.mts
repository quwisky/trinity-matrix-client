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
import { waitForNativeShellState } from './native-shell-client.mts';

const source =
  'e2e/browser/journeys/room-library/room-filter-spaceless.spec.mts:147-230';

const assertions = {
  roomsFreestandingVisible: 'rooms.freestanding-visible',
  roomsChildAbsent: 'rooms.child-absent',
  spacePillVisible: 'space.pill-visible',
  spacePillCurrent: 'space.pill-current',
  spaceChildVisible: 'space.child-visible',
  spaceChildNameExact: 'space.child-name-exact',
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

async function assertExactRoomsRoute(
  client: AccountWorkspaceClient,
  username: string,
): Promise<void> {
  const surface = await waitForNativeShellState(
    () => client.surface(),
    (value) => {
      const url = new URL(value.url);
      return (
        url.pathname === '/rooms' &&
        url.searchParams.get('account') === `@${username}:localhost`
      );
    },
    'exact account-qualified /rooms pathname',
    client.signal,
    60_000,
  );
  await client.record('login.rooms-route', {
    assertion: 'login.rooms-route',
    pathname: new URL(surface.url).pathname,
    account: new URL(surface.url).searchParams.get('account'),
  });
}

async function visibleNamedRow(
  client: AccountWorkspaceClient,
  assertion: string,
  name: string,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '.channel__name',
    (elements) => elements.length === 1 && elements[0]!.visible,
    { exactText: name },
  );
}

async function absentNamedRow(
  client: AccountWorkspaceClient,
  assertion: string,
  name: string,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '.channel__name',
    (elements) => elements.length === 0,
    { exactText: name },
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'spaceless-room-filter',
    source,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('spaceless-reader');
      const freestandingName = `Freestanding ${resources.roomName('spaceless-free')}`;
      const spaceName = `Team ${resources.roomName('spaceless-space')}`;
      const childName = `Team Chat ${resources.roomName('spaceless-child')}`;
      await fixtures.createRoom(reader, {
        name: freestandingName,
        preset: 'private_chat',
      });
      const space = await fixtures.createRoom(reader, {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const child = await fixtures.createRoom(reader, {
        name: childName,
        preset: 'private_chat',
      });
      await fixtures.setSpaceChild(reader, space.id, child.id, {
        suggested: true,
      });

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await visibleNamedRow(
        client,
        assertions.roomsFreestandingVisible,
        freestandingName,
      );
      await absentNamedRow(client, assertions.roomsChildAbsent, childName);

      const spaceSelector = `button[aria-label="${spaceName}"]`;
      await observedElements(
        client,
        assertions.spacePillVisible,
        spaceSelector,
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent(spaceSelector);
      await observedElements(
        client,
        assertions.spacePillCurrent,
        spaceSelector,
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.attributes['aria-current'] === 'true',
      );
      await observedElements(
        client,
        assertions.spaceChildVisible,
        '.channel',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { text: childName },
      );
      await visibleNamedRow(
        client,
        assertions.spaceChildNameExact,
        childName,
      );
    },
  },
];

assert.equal(
  cases.length,
  1,
  'Exactly one spaceless room-filter stage is required',
);
assert.equal(
  Object.keys(assertions).length,
  6,
  'Exactly six direct assertions are required',
);

void test(
  'Android spaceless room-filter journey',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-filter-spaceless',
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
        matrixResources.cleanup('Redact spaceless room-filter diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Spaceless room-filter Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Spaceless room-filter Android WebView',
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
          console.info(`[room-filter-spaceless] ${entry.id} start`);
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
              `[room-filter-spaceless] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Spaceless room-filter journey ${entry.id} failed`,
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
