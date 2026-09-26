import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  COMPOSER_REACTION_ASSERTION_RECORDS,
  COMPOSER_REACTION_SOURCES,
  composerReactionAssertions as assertions,
  composerReactionStageAssertions,
  type ComposerReactionAssertion,
} from './composer-reactions-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const COMPOSER_TRIGGER = 'button[aria-label="Insert emoji"]';
const COMPOSER_PICKER = 'trn-emoji-picker[data-testid="emoji-picker"]';
const REACTION_DIALOG = '[role="dialog"][aria-label="Pick a reaction"]';
// Selectors reach the job log, so they never carry the target's event id: the
// exact row is scoped by its unique body and proven by read-only observation.
const MESSAGE = '.scroll .msg[data-mid^="$"]';
const MESSAGE_AVATAR = `${MESSAGE} trn-avatar`;
const MESSAGE_REACTION_KEY = `${MESSAGE} .reaction .reaction__key`;
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const imageArtifactExtensions = new Set(['.jpeg', '.jpg', '.png', '.webp']);
const allAssertionIds = Object.values(
  assertions,
) as readonly ComposerReactionAssertion[];

type ComposerReactionCaseId = 'composer-toggle' | 'message-reaction';
type Fixtures = ReturnType<typeof createAccountFixtures>;

interface ComposerReactionStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: Fixtures;
  readonly resources: MatrixTestResources;
  readonly signal: AbortSignal;
  readonly secrets: Record<string, string>;
  readonly unique: Set<ComposerReactionAssertion>;
  readonly records: Set<ComposerReactionAssertion>;
  readonly stageRecords: Set<ComposerReactionAssertion>;
}

interface ComposerReactionCase {
  readonly id: ComposerReactionCaseId;
  readonly source: string;
  readonly expectedAssertionRecords: 5 | 7;
  run(context: ComposerReactionStageContext): Promise<void>;
}

interface ReactionFixture {
  readonly account: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function matrixRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, unknown>> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    description,
  );
  return value as Readonly<Record<string, unknown>>;
}

async function recordAssertion(
  context: ComposerReactionStageContext,
  identity: ComposerReactionAssertion,
  observation: unknown,
): Promise<void> {
  assert(!context.records.has(identity), `${identity} is recorded exactly once`);
  context.records.add(identity);
  context.stageRecords.add(identity);
  context.unique.add(identity);
  await context.client.record(identity, { assertion: identity, observation });
}

async function scanComposerReactionArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const secretValues = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Composer reaction artifact is a file: ${path}`);
      const extension = extname(path);
      assert(
        !imageArtifactExtensions.has(extension),
        `Composer reaction raster diagnostics are removed: ${path}`,
      );
      if (!textArtifactExtensions.has(extension)) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of secretValues) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      assert(!/\bBearer\s+\S+/u.test(text), `Bearer token is absent from ${path}`);
      assert(
        !/\bsyt_[A-Za-z0-9._~-]+/u.test(text),
        `Matrix access token is absent from ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'Preferences'),
        `Preferences method data is redacted in ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'SecureStorage'),
        `SecureStorage method data is redacted in ${path}`,
      );
    }
  }
  await scan(output);
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<AccountElement> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  return client.visible(COMPOSER, {}, 60_000);
}

async function seedStage(
  context: ComposerReactionStageContext,
  tag: ComposerReactionCaseId,
): Promise<ReactionFixture> {
  const account = await context.fixtures.account(`reactions-${tag}`);
  const roomName = `Reactions ${context.resources.roomName(`${tag}-room`)}`;
  const room = await context.fixtures.createRoom(account, {
    name: roomName,
    preset: 'private_chat',
  });
  const secretPrefix = tag.replaceAll('-', '_').toUpperCase();
  Object.assign(context.secrets, {
    [`SECRET_${secretPrefix}_USERNAME`]: account.username,
    [`SECRET_${secretPrefix}_USER_ID`]: account.userId,
    [`SECRET_${secretPrefix}_ROOM_NAME`]: roomName,
    [`SECRET_${secretPrefix}_ROOM_ID`]: room.id,
  });
  await context.client.login(account);
  await openRoom(context.client, roomName);
  return { account, room };
}

async function recordComposerReadiness(
  context: ComposerReactionStageContext,
  identity: ComposerReactionAssertion,
): Promise<void> {
  const composer = await context.client.visible(COMPOSER, {}, 60_000);
  await recordAssertion(context, identity, {
    visible: composer.visible,
    measured: composer.rect.width > 0 && composer.rect.height > 0,
  });
}

function withinMessage(body: string): AccountElementFilter {
  return { within: { selector: '.msg', text: body } };
}

async function exactReactionEvent(
  fixtures: Fixtures,
  account: NodeWorkspaceAccount,
  roomId: string,
  targetEventId: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const deadline = performance.now() + 20_000;
  do {
    const events = await fixtures.reactionEvents(account, roomId, targetEventId);
    const match = events.find((event) => {
      const content = matrixRecord(event['content'], 'Reaction event content');
      const relation = matrixRecord(
        content['m.relates_to'],
        'Reaction event relation',
      );
      return (
        event['type'] === 'm.reaction' &&
        event['sender'] === account.userId &&
        relation['rel_type'] === 'm.annotation' &&
        relation['event_id'] === targetEventId &&
        relation['key'] === '🚀'
      );
    });
    if (match) return match;
    await delay(250, undefined, { signal });
  } while (performance.now() < deadline);
  throw new Error('Exact Matrix rocket reaction relation did not appear');
}

async function runComposerToggle(
  context: ComposerReactionStageContext,
): Promise<void> {
  const { client } = context;
  await seedStage(context, 'composer-toggle');
  await recordComposerReadiness(context, assertions.toggleComposerReady);

  await client.tapCurrent('button[aria-label="Insert emoji"]');
  const picker = await client.visible(COMPOSER_PICKER, {}, 20_000);
  await recordAssertion(context, assertions.togglePickerVisible, {
    visible: picker.visible,
  });
  let trigger = await client.visible(COMPOSER_TRIGGER);
  assert.equal(trigger.attributes['aria-expanded'], 'true');
  await recordAssertion(context, assertions.toggleTriggerExpanded, {
    expanded: true,
  });

  await client.tapCurrent('button[aria-label="Insert emoji"]');
  const hidden = await client.waitElements(
    COMPOSER_PICKER,
    (elements) => elements.length === 0 || elements.every((entry) => !entry.visible),
    'composer emoji picker hidden after its trigger is activated again',
    {},
    10_000,
  );
  assert(hidden.every((entry) => !entry.visible));
  await recordAssertion(context, assertions.togglePickerHidden, {
    hidden: true,
    remainingElements: hidden.length,
  });
  trigger = await client.visible(COMPOSER_TRIGGER);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  await recordAssertion(context, assertions.toggleTriggerCollapsed, {
    expanded: false,
  });
}

async function runMessageReaction(
  context: ComposerReactionStageContext,
): Promise<void> {
  const { client, fixtures, resources } = context;
  const { account, room } = await seedStage(context, 'message-reaction');
  await recordComposerReadiness(context, assertions.messageComposerReady);
  const positioner = await fixtures.account('reactions-positioner');
  Object.assign(context.secrets, {
    SECRET_REACTION_POSITIONER_USERNAME: positioner.username,
    SECRET_REACTION_POSITIONER_USER_ID: positioner.userId,
  });
  await fixtures.invite(account, room.id, positioner);
  await fixtures.join(positioner, room.id);

  const fillerTag = resources.roomName('reaction-fillers');
  const body = `react to me ${resources.roomName('reaction-target')}`;
  const bodies = [
    `one ${fillerTag}`,
    `two ${fillerTag}`,
    `three ${fillerTag}`,
    body,
  ] as const;
  Object.assign(context.secrets, {
    SECRET_REACTION_FILLER_ONE: bodies[0],
    SECRET_REACTION_FILLER_TWO: bodies[1],
    SECRET_REACTION_FILLER_THREE: bodies[2],
    SECRET_REACTION_TARGET_BODY: body,
  });
  let targetEventId = '';
  for (const [index, text] of bodies.entries()) {
    const sender = index === bodies.length - 1 ? account : positioner;
    const eventId = await fixtures.sendMessage(
      sender,
      room.id,
      text,
      `composer-reaction-${index}-${resources.roomName('event')}`,
    );
    if (index === bodies.length - 1) targetEventId = eventId;
  }
  assert(targetEventId.startsWith('$'), 'Reaction target has a Matrix event id');
  context.secrets.SECRET_REACTION_TARGET_EVENT_ID = targetEventId;

  const target = await client.visible(MESSAGE, { text: body }, 30_000);
  const binding = await client.eventIdentity(
    MESSAGE,
    { text: body },
    targetEventId,
  );
  assert(
    binding.matches === 1 && binding.exactEvent,
    'Reaction target row is the exact seeded event',
  );
  await recordAssertion(context, assertions.messageTargetVisible, {
    visible: target.visible,
    exactEventBinding: binding.exactEvent,
  });

  const avatar = withinMessage(body);
  await client.visible(MESSAGE_AVATAR, avatar, 10_000);
  await client.scrollIntoViewIfNeeded(MESSAGE_AVATAR, '.scroll', avatar);
  const avatarBinding = await client.eventIdentity(
    MESSAGE_AVATAR,
    avatar,
    targetEventId,
  );
  assert(
    avatarBinding.matches === 1 && avatarBinding.exactEvent,
    'Long-press avatar belongs to the exact target event',
  );
  await client.longPressCurrent(MESSAGE_AVATAR, avatar);
  const more = await client.visible('[data-testid="sheet-react-more"]');
  await client.tapCurrent('[data-testid="sheet-react-more"]');
  const dialog = await client.visible(REACTION_DIALOG, {}, 10_000);
  await recordAssertion(context, assertions.messageDialogVisible, {
    moreActionVisible: more.visible,
    dialogVisible: dialog.visible,
    accessibleName: 'Pick a reaction',
  });

  const picker = await client.visible(
    `${REACTION_DIALOG} [data-testid="emoji-picker"]`,
    {},
    20_000,
  );
  await recordAssertion(context, assertions.messagePickerVisible, {
    visible: picker.visible,
  });

  const searchSelector = `${REACTION_DIALOG} .emoji-mart-search input`;
  await client.fill(searchSelector, 'rocket');
  const rocketSelector = `${REACTION_DIALOG} [data-testid="emoji-picker"] .emoji-mart-category[aria-label="Search Results"] .emoji-mart-emoji[aria-label*="rocket" i]`;
  const rocket = await client.visible(rocketSelector, {}, 15_000);
  await recordAssertion(context, assertions.messageRocketVisible, {
    visible: rocket.visible,
    filteredByRocket: true,
  });
  await client.tapCurrent(rocketSelector);

  const rocketKey = { exactText: '🚀', ...withinMessage(body) };
  const reaction = await client.visible(MESSAGE_REACTION_KEY, rocketKey, 20_000);
  const reactionBinding = await client.eventIdentity(
    MESSAGE_REACTION_KEY,
    rocketKey,
    targetEventId,
  );
  assert(
    reactionBinding.matches === 1 && reactionBinding.exactEvent,
    'Rocket reaction key renders inside the exact target event',
  );
  await recordAssertion(context, assertions.messageExactTargetReaction, {
    visible: reaction.visible,
    exactTarget: reactionBinding.exactEvent,
    key: '🚀',
  });

  const event = await exactReactionEvent(
    fixtures,
    account,
    room.id,
    targetEventId,
    context.signal,
  );
  assert(
    typeof event['event_id'] === 'string' && event['event_id'].startsWith('$'),
    'Matrix reaction has an event id',
  );
  context.secrets.SECRET_REACTION_EVENT_ID = event['event_id'];
  await recordAssertion(context, assertions.messageMatrixRelation, {
    exactType: true,
    exactSender: true,
    exactTarget: true,
    exactKey: true,
  });
}

const cases: readonly ComposerReactionCase[] = [
  {
    id: 'composer-toggle',
    source: `${COMPOSER_REACTION_SOURCES.toggle}; ${COMPOSER_REACTION_SOURCES.helpers}; ${COMPOSER_REACTION_SOURCES.app}; ${COMPOSER_REACTION_SOURCES.account}`,
    expectedAssertionRecords: 5,
    run: runComposerToggle,
  },
  {
    id: 'message-reaction',
    source: `${COMPOSER_REACTION_SOURCES.reaction}; ${COMPOSER_REACTION_SOURCES.android}; excludes ${COMPOSER_REACTION_SOURCES.desktopExcluded}; ${COMPOSER_REACTION_SOURCES.helpers}; ${COMPOSER_REACTION_SOURCES.app}; ${COMPOSER_REACTION_SOURCES.account}`,
    expectedAssertionRecords: 7,
    run: runMessageReaction,
  },
];

assert.equal(cases.length, 2, 'Exactly two composer reaction stages exist');
assert.equal(allAssertionIds.length, 12);
assert.equal(COMPOSER_REACTION_ASSERTION_RECORDS, 12);
assert.deepEqual(
  cases.map((entry) => entry.expectedAssertionRecords),
  [5, 7],
);
assert.deepEqual(
  Object.values(composerReactionStageAssertions).map((ids) => ids.length),
  [5, 7],
);

void test(
  'Android composer reaction-picker journeys',
  { timeout: 900_000 },
  async (testContext) => {
    await withNodeTestResources(
      { testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'composer-reactions',
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
        matrixResources.cleanup('Scan composer reaction diagnostics', () =>
          scanComposerReactionArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact composer reaction diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<ComposerReactionAssertion>();
        const records = new Set<ComposerReactionAssertion>();
        const stages: Array<{
          readonly id: ComposerReactionCaseId;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 5 | 7;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 2,
                expectedUniqueAssertions: 12,
                expectedAssertionRecords: 12,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: COMPOSER_REACTION_SOURCES,
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
        matrixResources.cleanup('Composer reactions Android device', () =>
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
          const stageRecords = new Set<ComposerReactionAssertion>();
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: entry.expectedAssertionRecords,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[composer-reactions] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await entry.run({
              client,
              fixtures,
              resources: matrixResources,
              signal,
              secrets,
              unique,
              records,
              stageRecords,
            });
            stage.assertionRecords = stageRecords.size;
            assert.equal(
              stage.assertionRecords,
              entry.expectedAssertionRecords,
            );
            await client.record('passed', {
              stage: entry.id,
              assertionRecords: stage.assertionRecords,
            });
          } catch (error) {
            failures.push(error);
            try {
              await client.record('failed', {
                stage: entry.id,
                error: describeFailure(error),
              });
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
              `[composer-reactions] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Composer reaction journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 12);
        assert.equal(records.size, COMPOSER_REACTION_ASSERTION_RECORDS);
      },
    );
  },
);
