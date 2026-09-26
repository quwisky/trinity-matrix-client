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
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  COMPOSER_MENTION_ASSERTION_RECORDS,
  COMPOSER_MENTION_SOURCES,
  composerMentionAssertions as assertions,
  composerMentionStageAssertions,
  type ComposerMentionAssertion,
} from './composer-mentions-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const AUTOCOMPLETE = '[data-testid="mention-autocomplete"]';
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
) as readonly ComposerMentionAssertion[];

type ComposerMentionCaseId = 'touch-selection' | 'keyboard-acceptance';

interface ComposerMentionStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly resources: MatrixTestResources;
  readonly secrets: Record<string, string>;
  readonly unique: Set<ComposerMentionAssertion>;
  readonly records: Set<ComposerMentionAssertion>;
  readonly stageRecords: Set<ComposerMentionAssertion>;
}

interface ComposerMentionCase {
  readonly id: ComposerMentionCaseId;
  readonly source: string;
  readonly expectedAssertionRecords: 4 | 8;
  run(context: ComposerMentionStageContext): Promise<void>;
}

interface MentionFixture {
  readonly reader: NodeWorkspaceAccount;
  readonly member: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
  readonly memberName: string;
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

function backgroundHasVisibleAlpha(background: string): boolean {
  const channels = background.match(/[\d.]+/gu) ?? [];
  return channels.length === 4 ? Number(channels[3]) > 0 : channels.length >= 3;
}

async function recordAssertion(
  context: ComposerMentionStageContext,
  identity: ComposerMentionAssertion,
  observation: unknown,
): Promise<void> {
  assert(!context.records.has(identity), `${identity} is recorded exactly once`);
  context.records.add(identity);
  context.stageRecords.add(identity);
  context.unique.add(identity);
  await context.client.record(identity, { assertion: identity, observation });
}

async function scanComposerMentionArtifacts(
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
      assert(entry.isFile(), `Composer mention artifact is a file: ${path}`);
      const extension = extname(path);
      assert(
        !imageArtifactExtensions.has(extension),
        `Composer mention raster diagnostics are removed: ${path}`,
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

async function seedMentionStage(
  context: ComposerMentionStageContext,
  tag: ComposerMentionCaseId,
): Promise<MentionFixture> {
  const accountTag =
    tag === 'touch-selection' ? 'mentions-touch' : 'mentions-key';
  const reader = await context.fixtures.account(`${accountTag}-reader`);
  const member = await context.fixtures.account(`${accountTag}-member`);
  const memberName = `Bobby ${context.resources.roomName(`${tag}-member`)}`;
  const roomName = `Mentions ${context.resources.roomName(`${tag}-room`)}`;
  await context.fixtures.setDisplayName(member, memberName);
  const room = await context.fixtures.createRoom(reader, {
    name: roomName,
    preset: 'private_chat',
    invite: [member.userId],
  });
  await context.fixtures.join(member, room.id);

  const secretPrefix = tag.replaceAll('-', '_').toUpperCase();
  Object.assign(context.secrets, {
    [`SECRET_${secretPrefix}_READER_USER`]: reader.username,
    [`SECRET_${secretPrefix}_READER_ID`]: reader.userId,
    [`SECRET_${secretPrefix}_MEMBER_USER`]: member.username,
    [`SECRET_${secretPrefix}_MEMBER_ID`]: member.userId,
    [`SECRET_${secretPrefix}_MEMBER_NAME`]: memberName,
    [`SECRET_${secretPrefix}_ROOM_NAME`]: roomName,
  });

  await context.client.login(reader);
  await openRoom(context.client, roomName);
  return { reader, member, room, memberName };
}

async function exactComposer(
  client: AccountWorkspaceClient,
  expectedValue: string,
): Promise<AccountElement> {
  const elements = await client.waitElements(
    COMPOSER,
    (candidates) =>
      candidates.length === 1 &&
      candidates[0]?.visible === true &&
      candidates[0].value === expectedValue,
    `exact composer value with ${expectedValue.length} characters`,
    {},
    30_000,
  );
  return elements[0]!;
}

async function recordComposerReadiness(
  context: ComposerMentionStageContext,
  identity: ComposerMentionAssertion,
): Promise<void> {
  const composer = await context.client.visible(COMPOSER, {}, 60_000);
  await recordAssertion(context, identity, {
    visible: composer.visible,
    measured: composer.rect.width > 0 && composer.rect.height > 0,
  });
}

async function fillMentionPrefix(
  context: ComposerMentionStageContext,
  memberName: string,
  tag: ComposerMentionCaseId,
): Promise<{ readonly prefix: string; readonly inserted: string }> {
  const prefix = `@${memberName.slice(0, 5)}`;
  const inserted = `@${memberName} `;
  const secretPrefix = tag.replaceAll('-', '_').toUpperCase();
  context.secrets[`SECRET_${secretPrefix}_PREFIX`] = prefix;
  context.secrets[`SECRET_${secretPrefix}_INSERTED`] = inserted;
  await context.client.focusCurrent(COMPOSER);
  await context.client.fillFocused(COMPOSER, prefix);
  const [composer] = await context.client.waitElements(
    COMPOSER,
    (elements) =>
      elements.length === 1 &&
      elements[0]?.value === prefix &&
      elements[0].selectionStart === prefix.length &&
      elements[0].selectionEnd === prefix.length,
    'mention query with native caret at its exact end',
    {},
    30_000,
  );
  await context.client.record(`${tag}-native-query`, {
    valueLength: prefix.length,
    selectionStart: composer?.selectionStart,
    selectionEnd: composer?.selectionEnd,
  });
  return { prefix, inserted };
}

function mentionSelector(expectedHref: string): string {
  return `.scroll a[href=${JSON.stringify(expectedHref)}]`;
}

function mentionMessageSelector(expectedHref: string): string {
  return `.scroll .msg[data-mid]:has(a[href=${JSON.stringify(expectedHref)}])`;
}

async function runTouchSelection(
  context: ComposerMentionStageContext,
): Promise<void> {
  const { client, fixtures } = context;
  const { reader, member, room, memberName } = await seedMentionStage(
    context,
    'touch-selection',
  );
  await recordComposerReadiness(context, assertions.touchComposerReady);
  const { prefix, inserted } = await fillMentionPrefix(
    context,
    memberName,
    'touch-selection',
  );

  const menu = await client.visible(AUTOCOMPLETE, {}, 30_000);
  await recordAssertion(context, assertions.touchAutocompleteVisible, {
    visible: menu.visible,
  });
  const memberOption = await client.visible(
    `${AUTOCOMPLETE} button`,
    { exactText: memberName },
    30_000,
  );
  await recordAssertion(context, assertions.touchMemberVisible, {
    visible: memberOption.visible,
  });

  await client.hideKeyboard();

  await client.tapCurrentExposed('[data-testid="mention-autocomplete"] button', {
    exactText: memberName,
  });
  const composer = await exactComposer(client, inserted);
  assert.equal(composer.value, inserted);
  await recordAssertion(context, assertions.touchInsertedValue, {
    matches: true,
    length: inserted.length,
    prefixLength: prefix.length,
  });
  // The emulated viewport maps points only while the WebView is full height;
  // the on-screen keyboard shrinks it, so dismiss it before the native Send tap.
  await client.hideKeyboard();
  await client.tapCurrent('[data-testid="composer-send"]');

  const expectedHref = `https://matrix.to/#/${member.userId}`;
  context.secrets.SECRET_TOUCH_SELECTION_HREF = expectedHref;
  const pill = await client.visible(mentionSelector(expectedHref), {}, 30_000);
  assert.equal(pill.attributes.href, expectedHref);
  const [message] = await client.waitElements(
    mentionMessageSelector(expectedHref),
    (candidates) =>
      candidates.length === 1 &&
      candidates[0]?.visible === true &&
      candidates[0].attributes['data-mid']?.startsWith('$') === true,
    'rendered mention reconciled to a Matrix event id',
    {},
    30_000,
  );
  assert(message);
  const eventId = message.attributes['data-mid'];
  assert(eventId?.startsWith('$'), 'Rendered mention has a Matrix event id');
  context.secrets.SECRET_TOUCH_SELECTION_EVENT_ID = eventId;
  const event = await fixtures.roomEvent(reader, room.id, eventId);
  const content = matrixRecord(event['content'], 'Mention event content');
  const mentions = matrixRecord(
    content['m.mentions'],
    'Mention event m.mentions content',
  );
  const userIds = mentions['user_ids'];
  assert(
    Array.isArray(userIds) && userIds.every((id) => typeof id === 'string'),
    'Mention event user ids are strings',
  );
  assert(userIds.includes(member.userId));
  await recordAssertion(context, assertions.touchSentMention, {
    linkVisible: pill.visible,
    hrefMatches: true,
    eventIdShape: eventId.startsWith('$'),
    serverMentioned: true,
    mentionCount: userIds.length,
  });

  const hasMentionClass = pill.attributes.class.split(/\s+/u).includes('mention');
  assert(hasMentionClass);
  await recordAssertion(context, assertions.touchMentionClass, {
    hasMentionClass,
  });

  const fontWeight = Number(pill.style.fontWeight);
  assert(Number(pill.style.fontWeight) >= 600);
  await recordAssertion(context, assertions.touchFontWeight, {
    atLeast600: true,
    fontWeight,
  });

  assert(backgroundHasVisibleAlpha(pill.style.backgroundColor));
  const styledBackground = true;
  await recordAssertion(context, assertions.touchBackground, {
    styledBackground,
  });
}

async function runKeyboardAcceptance(
  context: ComposerMentionStageContext,
): Promise<void> {
  const { client } = context;
  const { member, memberName } = await seedMentionStage(
    context,
    'keyboard-acceptance',
  );
  await recordComposerReadiness(context, assertions.keyboardComposerReady);
  const { inserted } = await fillMentionPrefix(
    context,
    memberName,
    'keyboard-acceptance',
  );

  const menu = await client.visible(AUTOCOMPLETE, {}, 30_000);
  await client.visible(
    `${AUTOCOMPLETE} button[aria-selected="true"]`,
    { exactText: memberName },
    30_000,
  );
  await recordAssertion(context, assertions.keyboardAutocompleteVisible, {
    visible: menu.visible,
    exactMemberHighlighted: true,
  });

  await client.key('enter');
  const composer = await exactComposer(client, inserted);
  assert.equal(composer.value, inserted);
  await recordAssertion(context, assertions.keyboardInsertedValue, {
    matches: true,
    length: inserted.length,
  });
  // The emulated viewport maps points only while the WebView is full height;
  // the on-screen keyboard shrinks it, so dismiss it before the native Send tap.
  await client.hideKeyboard();
  await client.tapCurrent('[data-testid="composer-send"]');

  const expectedHref = `https://matrix.to/#/${member.userId}`;
  context.secrets.SECRET_KEYBOARD_ACCEPTANCE_HREF = expectedHref;
  const pill = await client.visible(mentionSelector(expectedHref), {}, 30_000);
  assert.equal(pill.attributes.href, expectedHref);
  await recordAssertion(context, assertions.keyboardSentLinkVisible, {
    visible: pill.visible,
    hrefMatches: true,
  });
}

const cases: readonly ComposerMentionCase[] = [
  {
    id: 'touch-selection',
    source: `${COMPOSER_MENTION_SOURCES.touch}; ${COMPOSER_MENTION_SOURCES.helpers}; ${COMPOSER_MENTION_SOURCES.app}; ${COMPOSER_MENTION_SOURCES.account}`,
    expectedAssertionRecords: 8,
    run: runTouchSelection,
  },
  {
    id: 'keyboard-acceptance',
    source: `${COMPOSER_MENTION_SOURCES.keyboard}; ${COMPOSER_MENTION_SOURCES.helpers}; ${COMPOSER_MENTION_SOURCES.app}; ${COMPOSER_MENTION_SOURCES.account}`,
    expectedAssertionRecords: 4,
    run: runKeyboardAcceptance,
  },
];

assert.equal(cases.length, 2, 'Exactly two composer mention stages exist');
assert.equal(allAssertionIds.length, 12);
assert.equal(COMPOSER_MENTION_ASSERTION_RECORDS, 12);
assert.deepEqual(
  cases.map((entry) => entry.expectedAssertionRecords),
  [8, 4],
);
assert.deepEqual(
  Object.values(composerMentionStageAssertions).map((ids) => ids.length),
  [8, 4],
);

void test(
  'Android composer mention journeys',
  { timeout: 900_000 },
  async (testContext) => {
    await withNodeTestResources(
      { testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'composer-mentions',
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
        matrixResources.cleanup('Scan composer mention diagnostics', () =>
          scanComposerMentionArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact composer mention diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<ComposerMentionAssertion>();
        const records = new Set<ComposerMentionAssertion>();
        const stages: Array<{
          readonly id: ComposerMentionCaseId;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 4 | 8;
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
                sources: COMPOSER_MENTION_SOURCES,
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
        matrixResources.cleanup('Composer mentions Android device', () =>
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
          const stageRecords = new Set<ComposerMentionAssertion>();
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
          console.info(`[composer-mentions] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await entry.run({
              client,
              fixtures,
              resources: matrixResources,
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
              `[composer-mentions] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Composer mention journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 12);
        assert.equal(records.size, COMPOSER_MENTION_ASSERTION_RECORDS);
      },
    );
  },
);
