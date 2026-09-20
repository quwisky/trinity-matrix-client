import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountViewportProfile,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  COMPOSER_TYPING_ASSERTION_RECORDS,
  COMPOSER_TYPING_SOURCES,
  composerTypingAssertions as assertions,
  composerTypingStageAssertions,
  type ComposerTypingAssertion,
} from './composer-typing-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const INDICATOR = '[data-testid="typing-indicator"]';
const LONG_MEMBER_NAME =
  'Alexandra Wellington-Fitzgerald the Third of Northumberland and Wessex';
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
) as readonly ComposerTypingAssertion[];

type ComposerTypingCaseId =
  | 'show-clear'
  | 'reserved-slot'
  | 'long-name'
  | 'live-animation'
  | 'reduced-motion'
  | 'sidebar-projection';
type Fixtures = ReturnType<typeof createAccountFixtures>;
type ExpectedAssertionRecords = 3 | 4 | 5;

interface ComposerTypingStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: Fixtures;
  readonly resources: MatrixTestResources;
  readonly signal: AbortSignal;
  readonly secrets: Record<string, string>;
  readonly unique: Set<ComposerTypingAssertion>;
  readonly records: Set<ComposerTypingAssertion>;
  readonly stageRecords: Set<ComposerTypingAssertion>;
}

interface ComposerTypingCase {
  readonly id: ComposerTypingCaseId;
  readonly source: string;
  readonly expectedAssertionRecords: ExpectedAssertionRecords;
  readonly profile?: AccountViewportProfile;
  run(context: ComposerTypingStageContext): Promise<void>;
}

interface TypingFixture {
  readonly reader: NodeWorkspaceAccount;
  readonly member: NodeWorkspaceAccount & { readonly displayName: string };
  readonly room: WorkspaceRoom;
}

interface TypingSlotObservation {
  readonly height: number;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  context: ComposerTypingStageContext,
  identity: ComposerTypingAssertion,
  observation: unknown,
): Promise<void> {
  assert(!context.records.has(identity), `${identity} is recorded exactly once`);
  context.records.add(identity);
  context.stageRecords.add(identity);
  context.unique.add(identity);
  await context.client.record(identity, { assertion: identity, observation });
}

async function scanComposerTypingArtifacts(
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
      assert(entry.isFile(), `Composer typing artifact is a file: ${path}`);
      const extension = extname(path);
      assert(
        !imageArtifactExtensions.has(extension),
        `Composer typing raster diagnostics are removed: ${path}`,
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
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible(COMPOSER, {}, 60_000);
}

async function seedStage(
  context: ComposerTypingStageContext,
  tag: ComposerTypingCaseId,
  displayName?: string,
): Promise<TypingFixture> {
  const reader = await context.fixtures.account(`typing-${tag}-reader`);
  const memberAccount = await context.fixtures.account(`typing-${tag}-member`);
  const memberName = displayName ?? `Tilly ${context.resources.roomName(tag)}`;
  const member = Object.assign(memberAccount, { displayName: memberName });
  const roomName = `Typing ${context.resources.roomName(`${tag}-room`)}`;
  await context.fixtures.setDisplayName(member, memberName);
  const room = await context.fixtures.createRoom(reader, {
    name: roomName,
    preset: 'private_chat',
  });
  await context.fixtures.invite(reader, room.id, member);
  await context.fixtures.join(member, room.id);
  Object.assign(context.secrets, {
    [`SECRET_${tag}_READER_USERNAME`]: reader.username,
    [`SECRET_${tag}_READER_USER_ID`]: reader.userId,
    [`SECRET_${tag}_MEMBER_USERNAME`]: member.username,
    [`SECRET_${tag}_MEMBER_USER_ID`]: member.userId,
    [`SECRET_${tag}_MEMBER_NAME`]: memberName,
    [`SECRET_${tag}_ROOM_NAME`]: roomName,
    [`SECRET_${tag}_ROOM_ID`]: room.id,
  });
  context.resources.cleanup(`Stop ${tag} counterpart typing`, () =>
    context.fixtures.setTyping(member, room.id, false),
  );
  await context.client.login(reader);
  await openRoom(context.client, roomName);
  return { reader, member, room };
}

async function recordComposerReadiness(
  context: ComposerTypingStageContext,
  identity: ComposerTypingAssertion,
): Promise<void> {
  const composer = await context.client.visible(COMPOSER, {}, 60_000);
  await recordAssertion(context, identity, {
    visible: composer.visible,
    measured: composer.rect.width > 0 && composer.rect.height > 0,
  });
}

async function waitForIndicator(
  client: AccountWorkspaceClient,
  exactCopy?: string,
): Promise<{ readonly visible: boolean; readonly text: string }> {
  const indicator = '[data-testid="typing-indicator"]';
  const element = await client.visible(
    indicator,
    exactCopy === undefined ? {} : { exactText: exactCopy },
    20_000,
  );
  return { visible: element.visible, text: element.text };
}

async function waitForIndicatorHidden(
  client: AccountWorkspaceClient,
): Promise<number> {
  const elements = await client.waitElements(
    INDICATOR,
    (entries) => entries.length === 0 || entries.every((entry) => !entry.visible),
    'typing indicator hidden after counterpart stop',
    {},
    20_000,
  );
  assert(elements.every((entry) => !entry.visible));
  return elements.length;
}

async function observeTypingSlot(
  client: AccountWorkspaceClient,
  selector: '.typing-slot',
): Promise<TypingSlotObservation> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
      const slot = document.querySelector(${JSON.stringify(selector)});
      if (!(slot instanceof HTMLElement)) throw new Error('typing slot missing');
      return { height: slot.getBoundingClientRect().height };
    })()`,
  );
  assert(value && typeof value === 'object' && 'height' in value);
  assert(typeof value.height === 'number');
  return { height: value.height };
}

async function runShowClear(
  context: ComposerTypingStageContext,
): Promise<void> {
  const { fixtures } = context;
  const { member, room } = await seedStage(context, 'show-clear');
  await recordComposerReadiness(context, assertions.showClearComposerReady);
  try {
    await fixtures.setTyping(member, room.id, true);
    const indicator = await waitForIndicator(context.client);
    await recordAssertion(context, assertions.showClearIndicatorVisible, {
      visible: indicator.visible,
    });
    assert.equal(indicator.text, `${member.displayName} is typing`);
    await recordAssertion(context, assertions.showClearExactCopy, {
      exactNamedCopy: true,
    });
  } finally {
    await fixtures.setTyping(member, room.id, false);
  }
  const remainingElements = await waitForIndicatorHidden(context.client);
  await recordAssertion(context, assertions.showClearHiddenAfterStop, {
    hidden: true,
    remainingElements,
  });
}

async function runReservedSlot(
  context: ComposerTypingStageContext,
): Promise<void> {
  const { client, fixtures } = context;
  const { member, room } = await seedStage(context, 'reserved-slot');
  await recordComposerReadiness(context, assertions.reservedSlotComposerReady);
  const slot = await observeTypingSlot(client, '.typing-slot');
  assert(slot.height > 0, 'The idle typing slot has positive height');
  await recordAssertion(context, assertions.reservedSlotIdleHeightPositive, {
    positive: true,
    height: slot.height,
  });
  try {
    await fixtures.setTyping(member, room.id, true);
    const indicator = await waitForIndicator(client);
    await recordAssertion(context, assertions.reservedSlotIndicatorVisible, {
      visible: indicator.visible,
    });
    const occupied = await observeTypingSlot(client, '.typing-slot');
    assert(
      Math.abs(occupied.height - slot.height) < 1,
      'The occupied typing slot stays within one CSS pixel of idle',
    );
    await recordAssertion(context, assertions.reservedSlotHeightStable, {
      idleHeight: slot.height,
      occupiedHeight: occupied.height,
      difference: Math.abs(occupied.height - slot.height),
    });
  } finally {
    await fixtures.setTyping(member, room.id, false);
  }
}

async function runLongName(
  context: ComposerTypingStageContext,
): Promise<void> {
  const { fixtures } = context;
  const { member, room } = await seedStage(
    context,
    'long-name',
    'Alexandra Wellington-Fitzgerald the Third of Northumberland and Wessex',
  );
  await recordComposerReadiness(context, assertions.longNameComposerReady);
  const idle = await observeTypingSlot(context.client, '.typing-slot');
  assert(idle.height > 0, 'The long-name idle typing slot has positive height');
  await recordAssertion(context, assertions.longNameIdleHeightPositive, {
    positive: true,
    height: idle.height,
  });
  try {
    await fixtures.setTyping(member, room.id, true);
    const indicator = await waitForIndicator(context.client);
    await recordAssertion(context, assertions.longNameIndicatorVisible, {
      visible: indicator.visible,
    });
    const occupied = await observeTypingSlot(context.client, '.typing-slot');
    assert(
      Math.abs(occupied.height - idle.height) < 1,
      'The long-name typing slot stays within one CSS pixel of idle',
    );
    await recordAssertion(context, assertions.longNameHeightStable, {
      idleHeight: idle.height,
      occupiedHeight: occupied.height,
      difference: Math.abs(occupied.height - idle.height),
    });
    const overflows = await evaluateNative(
      context.client.webview,
      `(() => {
        const text = document.querySelector('.typing-indicator__text');
        if (!(text instanceof HTMLElement)) throw new Error('typing text missing');
        return text.scrollWidth > text.clientWidth;
      })()`,
    );
    assert.equal(overflows, true);
    await recordAssertion(context, assertions.longNameTextOverflows, {
      exactLongName: LONG_MEMBER_NAME,
      overflows: true,
    });
  } finally {
    await fixtures.setTyping(member, room.id, false);
  }
}

async function runLiveAnimation(
  context: ComposerTypingStageContext,
): Promise<void> {
  const { fixtures } = context;
  const { member, room } = await seedStage(context, 'live-animation');
  await recordComposerReadiness(context, assertions.liveAnimationComposerReady);
  try {
    await fixtures.setTyping(member, room.id, true);
    const indicator = await waitForIndicator(context.client);
    await recordAssertion(context, assertions.liveAnimationIndicatorVisible, {
      visible: indicator.visible,
    });
    const observation = await evaluateNative(
      context.client.webview,
      `(() => {
        const element = document.querySelector('.typing-dots__dot');
        if (!(element instanceof HTMLElement)) throw new Error('typing dot missing');
        const animations = element.getAnimations();
        const timing = animations[0]?.effect?.getComputedTiming();
        if (!timing) throw new Error('typing animation timing missing');
        return {
          count: animations.length,
          duration1000: timing.duration === 1000,
          infinite: timing.iterations === Infinity,
        };
      })()`,
    );
    assert(observation && typeof observation === 'object');
    assert('count' in observation && observation.count === 1);
    await recordAssertion(context, assertions.liveAnimationOneAnimation, {
      count: 1,
    });
    assert('duration1000' in observation && observation.duration1000 === true);
    await recordAssertion(context, assertions.liveAnimationDuration1000ms, {
      durationMs: 1000,
    });
    assert('infinite' in observation && observation.infinite === true);
    await recordAssertion(
      context,
      assertions.liveAnimationInfiniteIterations,
      { iterations: 'Infinity' },
    );
  } finally {
    await fixtures.setTyping(member, room.id, false);
  }
}

async function restoreAnimatorDurationScale(
  client: AccountWorkspaceClient,
  previous: string,
): Promise<void> {
  if (previous === 'null' || previous === '') {
    await client.device.adb(
      'shell',
      'settings',
      'delete',
      'global',
      'animator_duration_scale',
    );
  } else {
    await client.device.adb(
      'shell',
      'settings',
      'put',
      'global',
      'animator_duration_scale',
      previous,
    );
  }
  await client.relaunch(DESKTOP_ACCOUNT_PROFILE);
  const restored = await evaluateNative(
    client.webview,
    `matchMedia('(prefers-reduced-motion: reduce)').matches`,
  );
  assert.equal(restored, previous === '0');
  await client.record('animator-duration-scale-restored', {
    restoredValue: previous,
    reducedMotion: restored,
  });
}

async function runReducedMotion(
  context: ComposerTypingStageContext,
): Promise<void> {
  const { client, fixtures } = context;
  const { member, room } = await seedStage(context, 'reduced-motion');
  const previous = await client.device.adb(
    'shell',
    'settings',
    'get',
    'global',
    'animator_duration_scale',
  );
  const reducedBefore = await evaluateNative(
    client.webview,
    `matchMedia('(prefers-reduced-motion: reduce)').matches`,
  );
  assert.equal(reducedBefore, false, 'Baseline Android motion is not reduced');
  let settingApplied = false;
  try {
    await client.device.adb(
      'shell',
      'settings',
      'put',
      'global',
      'animator_duration_scale',
      '0',
    );
    settingApplied = true;
    await client.relaunch(DESKTOP_ACCOUNT_PROFILE);
    await openRoom(client, room.name);
    await recordComposerReadiness(
      context,
      assertions.reducedMotionComposerReady,
    );
    const reduced = await waitForNativeShellState(
      () =>
        evaluateNative(
          client.webview,
          `matchMedia('(prefers-reduced-motion: reduce)').matches`,
        ),
      (value) => value === true,
      'Android animator scale projected as reduced motion',
      context.signal,
      20_000,
    );
    assert.equal(reduced, true);
    await client.record('animator-duration-scale-applied', {
      previousValue: previous,
      appliedValue: '0',
      reducedMotion: reduced,
    });
    await fixtures.setTyping(member, room.id, true);
    const indicator = await waitForIndicator(client);
    await recordAssertion(context, assertions.reducedMotionIndicatorVisible, {
      visible: indicator.visible,
      reducedMotion: true,
    });
    const opacities = await evaluateNative(
      client.webview,
      `[...document.querySelectorAll('.typing-dots__dot')].map((element) => getComputedStyle(element).opacity)`,
    );
    assert.deepEqual(opacities, ['1', '1', '1']);
    await recordAssertion(context, assertions.reducedMotionFullOpacityDots, {
      opacities,
    });
  } finally {
    const failures: unknown[] = [];
    await fixtures
      .setTyping(member, room.id, false)
      .catch((error: unknown) => failures.push(error));
    if (settingApplied) {
      await restoreAnimatorDurationScale(client, previous).catch(
        (error: unknown) => failures.push(error),
      );
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Reduced-motion typing cleanup failed',
      );
    }
  }
}

async function runSidebarProjection(
  context: ComposerTypingStageContext,
): Promise<void> {
  const { client, fixtures } = context;
  const { member, room } = await seedStage(
    context,
    'sidebar-projection',
  );
  await recordComposerReadiness(
    context,
    assertions.sidebarProjectionComposerReady,
  );
  const preview = '.channel.active .channel__preview--typing';
  try {
    await fixtures.setTyping(member, room.id, true);
    const projected = await client.visible(
      preview,
      { exactText: `${member.displayName} is typing` },
      20_000,
    );
    await recordAssertion(context, assertions.sidebarProjectionExactCopy, {
      exactNamedCopy: true,
      visible: projected.visible,
    });

    await fixtures.setTyping(member, room.id, false);
    const cleared = await client.waitElements(
      preview,
      (elements) => elements.length === 0,
      'sidebar typing projection removed after counterpart stop',
      {},
      20_000,
    );
    assert.equal(cleared.length, 0);
    await recordAssertion(context, assertions.sidebarProjectionClears, {
      count: 0,
    });

    const localDraft = 'Writing something';
    context.secrets.SECRET_SIDEBAR_LOCAL_DRAFT = localDraft;
    await client.fill('[data-testid="composer-input"]', localDraft);
    await fixtures.setTyping(member, room.id, true);
    const projectedWhileLocal = await client.visible(
      preview,
      { exactText: `${member.displayName} is typing` },
      20_000,
    );
    await recordAssertion(
      context,
      assertions.sidebarProjectionLocalKeepsExactCopy,
      {
        exactNamedCopy: true,
        visible: projectedWhileLocal.visible,
      },
    );
  } finally {
    await fixtures.setTyping(member, room.id, false);
  }
}

const cases: readonly ComposerTypingCase[] = [
  {
    id: 'show-clear',
    source: `${COMPOSER_TYPING_SOURCES.showClear}; ${COMPOSER_TYPING_SOURCES.helpers}; ${COMPOSER_TYPING_SOURCES.app}; ${COMPOSER_TYPING_SOURCES.account}`,
    expectedAssertionRecords: 4,
    run: runShowClear,
  },
  {
    id: 'reserved-slot',
    source: `${COMPOSER_TYPING_SOURCES.reservedSlot}; ${COMPOSER_TYPING_SOURCES.helpers}; ${COMPOSER_TYPING_SOURCES.app}; ${COMPOSER_TYPING_SOURCES.account}`,
    expectedAssertionRecords: 4,
    run: runReservedSlot,
  },
  {
    id: 'long-name',
    source: `${COMPOSER_TYPING_SOURCES.longName}; ${COMPOSER_TYPING_SOURCES.helpers}; ${COMPOSER_TYPING_SOURCES.app}; ${COMPOSER_TYPING_SOURCES.account}`,
    expectedAssertionRecords: 5,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    run: runLongName,
  },
  {
    id: 'live-animation',
    source: `${COMPOSER_TYPING_SOURCES.liveAnimation}; ${COMPOSER_TYPING_SOURCES.helpers}; ${COMPOSER_TYPING_SOURCES.app}; ${COMPOSER_TYPING_SOURCES.account}`,
    expectedAssertionRecords: 5,
    run: runLiveAnimation,
  },
  {
    id: 'reduced-motion',
    source: `${COMPOSER_TYPING_SOURCES.reducedMotion}; ${COMPOSER_TYPING_SOURCES.helpers}; ${COMPOSER_TYPING_SOURCES.app}; ${COMPOSER_TYPING_SOURCES.account}`,
    expectedAssertionRecords: 3,
    run: runReducedMotion,
  },
  {
    id: 'sidebar-projection',
    source: `${COMPOSER_TYPING_SOURCES.sidebarProjection}; ${COMPOSER_TYPING_SOURCES.helpers}; ${COMPOSER_TYPING_SOURCES.app}; ${COMPOSER_TYPING_SOURCES.account}`,
    expectedAssertionRecords: 4,
    run: runSidebarProjection,
  },
];

assert.equal(cases.length, 6, 'Exactly six composer typing stages exist');
assert.equal(allAssertionIds.length, 25);
assert.equal(COMPOSER_TYPING_ASSERTION_RECORDS, 25);
assert.deepEqual(
  cases.map((entry) => entry.expectedAssertionRecords),
  [4, 4, 5, 5, 3, 4],
);
assert.deepEqual(
  Object.values(composerTypingStageAssertions).map((ids) => ids.length),
  [4, 4, 5, 5, 3, 4],
);

void test(
  'Android composer typing-indicator journeys',
  { timeout: 900_000 },
  async (testContext) => {
    await withNodeTestResources(
      { testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'composer-typing',
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
        matrixResources.cleanup('Scan composer typing diagnostics', () =>
          scanComposerTypingArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact composer typing diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<ComposerTypingAssertion>();
        const records = new Set<ComposerTypingAssertion>();
        const stages: Array<{
          readonly id: ComposerTypingCaseId;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: ExpectedAssertionRecords;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 6,
                expectedUniqueAssertions: 25,
                expectedAssertionRecords: 25,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                profiles: {
                  default: DESKTOP_ACCOUNT_PROFILE,
                  longName: PIXEL_5_ACCOUNT_PROFILE,
                },
                sources: COMPOSER_TYPING_SOURCES,
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
        matrixResources.cleanup('Composer typing Android device', () =>
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
          const stageRecords = new Set<ComposerTypingAssertion>();
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
          console.info(`[composer-typing] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? DESKTOP_ACCOUNT_PROFILE);
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
              `[composer-typing] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Composer typing journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 25);
        assert.equal(records.size, COMPOSER_TYPING_ASSERTION_RECORDS);
      },
    );
  },
);
