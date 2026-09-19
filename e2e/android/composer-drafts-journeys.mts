import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  COMPOSER_DRAFT_ASSERTION_RECORDS,
  COMPOSER_DRAFT_SOURCES,
  composerDraftAssertions as assertions,
  type ComposerDraftAssertion,
} from './composer-drafts-contract.mts';
import { readNativeComposerDraft } from './composer-drafts-preference.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const DRAFTS_KEY = 'trinity.composer.drafts';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const allAssertionIds = Object.values(
  assertions,
) as readonly ComposerDraftAssertion[];

interface ComposerDraftCase {
  readonly id: 'per-room-draft-persistence';
  readonly source: string;
}

interface ComposerDraftStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly resources: MatrixTestResources;
  readonly secrets: Record<string, string>;
  readonly unique: Set<ComposerDraftAssertion>;
  readonly records: Set<ComposerDraftAssertion>;
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
  unique: Set<ComposerDraftAssertion>,
  records: Set<ComposerDraftAssertion>,
  identity: ComposerDraftAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function observeComposer(
  client: AccountWorkspaceClient,
  unique: Set<ComposerDraftAssertion>,
  records: Set<ComposerDraftAssertion>,
  identity: ComposerDraftAssertion,
  accepts: (value: string) => boolean,
): Promise<void> {
  const elements = await waitForNativeShellState(
    () => client.elements('[data-testid="composer-input"]'),
    (candidates) =>
      candidates.length === 1 &&
      candidates[0]!.visible &&
      candidates[0]!.value !== null &&
      accepts(candidates[0]!.value),
    identity,
    client.signal,
    30_000,
  );
  const composer = elements[0] as AccountElement & { readonly value: string };
  await recordAssertion(client, unique, records, identity, {
    visible: composer.visible,
    empty: composer.value.length === 0,
    valueLength: composer.value.length,
    matchesExpected: true,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  readinessIdentity: ComposerDraftAssertion,
  unique: Set<ComposerDraftAssertion>,
  records: Set<ComposerDraftAssertion>,
): Promise<void> {
  const backToRooms = await client.elements('[data-testid="back-to-rooms"]');
  if (backToRooms.length === 1 && backToRooms[0]!.visible) {
    await client.tapCurrent('[data-testid="back-to-rooms"]');
  } else {
    await client.tapCurrent('[data-testid="rail-rooms"]');
  }
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  await observeComposer(
    client,
    unique,
    records,
    readinessIdentity,
    () => true,
  );
}

async function scanComposerDraftArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const secretValues = [
    ...new Set(Object.values(secrets).filter(Boolean)),
  ].sort((left, right) => right.length - left.length);
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Composer draft artifact is a file: ${path}`);
      if (!textArtifactExtensions.has(extname(path))) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of secretValues) {
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

async function runComposerDraftStage(
  context: ComposerDraftStageContext,
): Promise<void> {
  const { client, fixtures, resources, secrets, unique, records } = context;
  const account: NodeWorkspaceAccount = await fixtures.account(
    'composer-draft-reader',
  );
  const roomA = await fixtures.createRoom(account, {
    name: `Drafts A ${resources.roomName('composer-draft-a')}`,
    preset: 'private_chat',
  });
  const roomB = await fixtures.createRoom(account, {
    name: `Drafts B ${resources.roomName('composer-draft-b')}`,
    preset: 'private_chat',
  });
  assert.notEqual(roomA.id, roomB.id, 'Composer draft Rooms are distinct');
  const draft = `Unsent draft ${resources.roomName('composer-draft')}`;
  secrets.SECRET_COMPOSER_DRAFT = draft;
  secrets.SECRET_COMPOSER_DRAFT_LOWERCASE = `${draft.charAt(0).toLowerCase()}${draft.slice(1)}`;

  await client.login(account);
  await openRoom(
    client,
    roomA.name,
    assertions.roomAInitialReady,
    unique,
    records,
  );
  await client.fill('[data-testid="composer-input"]', draft);
  await client.hideKeyboard();

  await openRoom(
    client,
    roomB.name,
    assertions.roomBReady,
    unique,
    records,
  );
  await observeComposer(
    client,
    unique,
    records,
    assertions.roomBEmpty,
    (value) => value === '',
  );

  await openRoom(
    client,
    roomA.name,
    assertions.roomAReturnReady,
    unique,
    records,
  );
  await observeComposer(
    client,
    unique,
    records,
    assertions.roomARestored,
    (value) => value === draft,
  );

  const conversationKey = `conversation:${JSON.stringify([account.userId, roomA.id])}`;
  const preference = await readNativeComposerDraft(
    client,
    DRAFTS_KEY,
    conversationKey,
    draft,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.nativePreferencePersisted,
    preference,
  );

  await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
  await client.activeAccountRooms(account);
  await openRoom(
    client,
    roomA.name,
    assertions.roomARelaunchReady,
    unique,
    records,
  );
  await observeComposer(
    client,
    unique,
    records,
    assertions.coldRelaunchRestored,
    (value) => value === draft,
  );
}

const cases: readonly ComposerDraftCase[] = [
  {
    id: 'per-room-draft-persistence',
    source: `${COMPOSER_DRAFT_SOURCES.definition}; ${COMPOSER_DRAFT_SOURCES.helpers}; ${COMPOSER_DRAFT_SOURCES.app}; ${COMPOSER_DRAFT_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one composer draft stage exists');
assert.equal(allAssertionIds.length, 8);
assert.equal(COMPOSER_DRAFT_ASSERTION_RECORDS, 8);

void test(
  'Android composer draft persistence journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'composer-drafts',
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
        matrixResources.cleanup('Scan composer draft diagnostics', () =>
          scanComposerDraftArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact composer draft diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<ComposerDraftAssertion>();
        const records = new Set<ComposerDraftAssertion>();
        const stages: Array<{
          readonly id: ComposerDraftCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 8;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 1,
                expectedUniqueAssertions: 8,
                expectedAssertionRecords: 8,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: COMPOSER_DRAFT_SOURCES,
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
        matrixResources.cleanup('Composer draft Android device', () =>
          device.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
          APPLICATION_ID,
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          const client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
            APPLICATION_ID,
          );
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: 8,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[composer-drafts] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runComposerDraftStage({
              client,
              fixtures,
              resources: matrixResources,
              secrets,
              unique,
              records,
            });
            stage.assertionRecords = records.size;
            assert.equal(stage.assertionRecords, 8);
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
            try {
              await device.clearApplicationData(APPLICATION_ID);
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
              `[composer-drafts] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Composer draft journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 8);
        assert.equal(records.size, COMPOSER_DRAFT_ASSERTION_RECORDS);
      },
    );
  },
);
