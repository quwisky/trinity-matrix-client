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
  type AccountViewportProfile,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  COMPOSER_FORMATTING_ASSERTION_RECORDS,
  COMPOSER_FORMATTING_SOURCES,
  composerFormattingAssertions as assertions,
  composerFormattingStageAssertions,
  type ComposerFormattingAssertion,
} from './composer-formatting-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const FORMAT = '[data-testid="composer-format"]';
const FORMAT_SHEET = '[data-testid="action-sheet-surface"]';
const COMPACT_LARGER_PROFILE: AccountViewportProfile = {
  ...PIXEL_5_ACCOUNT_PROFILE,
  width: 320,
  height: 720,
};
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
) as readonly ComposerFormattingAssertion[];

type ComposerFormattingCaseId =
  | 'apply-selected-italic'
  | 'cancel-and-preview'
  | 'compact-larger-text';

interface ComposerFormattingStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly resources: MatrixTestResources;
  readonly secrets: Record<string, string>;
  readonly unique: Set<ComposerFormattingAssertion>;
  readonly records: Set<ComposerFormattingAssertion>;
  readonly stageRecords: Set<ComposerFormattingAssertion>;
}

interface ComposerFormattingCase {
  readonly id: ComposerFormattingCaseId;
  readonly source: string;
  readonly expectedAssertionRecords: 11 | 12 | 16;
  run(context: ComposerFormattingStageContext): Promise<void>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  context: ComposerFormattingStageContext,
  identity: ComposerFormattingAssertion,
  observation: unknown,
): Promise<void> {
  assert(!context.records.has(identity), `${identity} is recorded exactly once`);
  context.records.add(identity);
  context.stageRecords.add(identity);
  context.unique.add(identity);
  await context.client.record(identity, { assertion: identity, observation });
}

async function scanComposerFormattingArtifacts(
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
      assert(entry.isFile(), `Composer formatting artifact is a file: ${path}`);
      if (!textArtifactExtensions.has(extname(path))) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of secretValues) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      for (const selectedWord of ['hello', 'bold'] as const) {
        const selectedWordJsonValue = JSON.stringify(selectedWord);
        assert(
          !new RegExp(`:\\s*${selectedWordJsonValue}\\s*[,}]`, 'u').test(text),
          `selected word is absent as an exact JSON value from ${path}`,
        );
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

async function captureSheetVisual(
  context: ComposerFormattingStageContext,
  name: string,
  sheet: AccountElement,
): Promise<void> {
  const response = await context.client.webview.diagnostics.send(
    'Page.captureScreenshot',
    {
      format: 'png',
    },
  );
  assert(response && typeof response === 'object' && 'data' in response);
  assert(typeof response.data === 'string');
  await writeFile(
    join(context.client.output, `${name}.png`),
    Buffer.from(response.data, 'base64'),
  );
  await context.client.record(`${name}-geometry`, {
    rect: sheet.rect,
    redaction:
      'the modal action sheet occludes the composer draft in the full viewport capture',
  });
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

async function seedStageRoom(
  context: ComposerFormattingStageContext,
  tag: string,
): Promise<{
  readonly account: NodeWorkspaceAccount;
  readonly roomName: string;
}> {
  const account = await context.fixtures.account(`composer-format-${tag}`);
  const room = await context.fixtures.createRoom(account, {
    name: `Format ${context.resources.roomName(tag)}`,
    preset: 'private_chat',
  });
  await context.client.login(account);
  return { account, roomName: room.name };
}

async function exactComposer(
  client: AccountWorkspaceClient,
  expectedValue: string,
  options: {
    readonly focused?: boolean;
    readonly selectionStart?: number;
    readonly selectionEnd?: number;
  } = {},
): Promise<AccountElement> {
  const elements = await client.waitElements(
    COMPOSER,
    (candidates) => {
      const composer = candidates[0];
      return (
        candidates.length === 1 &&
        composer?.visible === true &&
        composer.value === expectedValue &&
        (options.focused === undefined || composer.focused === options.focused) &&
        (options.selectionStart === undefined ||
          composer.selectionStart === options.selectionStart) &&
        (options.selectionEnd === undefined ||
          composer.selectionEnd === options.selectionEnd)
      );
    },
    `exact composer state with ${expectedValue.length} characters`,
    {},
    30_000,
  );
  return elements[0]!;
}

async function recordComposerReadiness(
  context: ComposerFormattingStageContext,
  identity: ComposerFormattingAssertion,
): Promise<AccountElement> {
  const composer = await context.client.visible(COMPOSER, {}, 60_000);
  await recordAssertion(context, identity, {
    visible: composer.visible,
    rect: composer.rect,
  });
  return composer;
}

async function runApplySelectedItalic(
  context: ComposerFormattingStageContext,
): Promise<void> {
  const { client, secrets } = context;
  const { roomName } = await seedStageRoom(context, 'apply');
  await openRoom(client, roomName);
  await recordComposerReadiness(context, assertions.applyComposerReady);

  const draft = 'say hello';
  const formatted = 'say *hello*';
  secrets.SECRET_APPLY_DRAFT = draft;
  secrets.SECRET_APPLY_FORMATTED = formatted;
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, 'say hello');
  await client.hideKeyboard();
  const selection = await client.selectWordCurrent(COMPOSER, draft, 'hello');
  await client.record('apply-native-selection', selection);

  const trigger = await client.visible(FORMAT);
  assert(trigger.rect.width >= 44);
  await recordAssertion(context, assertions.applyTargetWidth, {
    width: trigger.rect.width,
  });
  assert(trigger.rect.height >= 44);
  await recordAssertion(context, assertions.applyTargetHeight, {
    height: trigger.rect.height,
  });

  await client.hideKeyboard();
  await exactComposer(client, draft, {
    focused: true,
    selectionStart: 4,
    selectionEnd: 9,
  });
  await client.tapCurrent(FORMAT);
  const sheet = await client.visible(FORMAT_SHEET);
  await recordAssertion(context, assertions.applySheetVisible, {
    visible: sheet.visible,
  });
  assert(sheet.rect.width > 0 && sheet.rect.height > 0);
  await recordAssertion(context, assertions.applySheetMeasured, {
    measured: true,
    rect: sheet.rect,
  });
  const viewport = await client.visible('html');
  assert(sheet.rect.x >= 0);
  await recordAssertion(context, assertions.applySheetLeftBound, {
    x: sheet.rect.x,
  });
  assert(sheet.rect.right <= viewport.rect.width + 0.5);
  await recordAssertion(context, assertions.applySheetRightBound, {
    right: sheet.rect.right,
    viewportWidth: viewport.rect.width,
  });
  assert(sheet.rect.y >= 0);
  await recordAssertion(context, assertions.applySheetTopBound, {
    y: sheet.rect.y,
  });
  assert(sheet.rect.bottom <= viewport.rect.height + 0.5);
  await recordAssertion(context, assertions.applySheetBottomBound, {
    bottom: sheet.rect.bottom,
    viewportHeight: viewport.rect.height,
  });
  await captureSheetVisual(context, 'apply-sheet-visual', sheet);

  await client.tapCurrent('[data-testid="format-italic"]');
  const result = await exactComposer(client, formatted, { focused: true });
  await recordAssertion(context, assertions.applyFormattedValue, {
    matches: result.value === formatted,
    length: result.value?.length,
  });
  const hidden = await client.waitElements(
    FORMAT_SHEET,
    (elements) => elements.every((element) => !element.visible),
    'hidden Format action sheet',
  );
  await recordAssertion(context, assertions.applySheetHidden, {
    hidden: hidden.every((element) => !element.visible),
  });
  assert(result.focused);
  await recordAssertion(context, assertions.applyComposerFocused, {
    focused: result.focused,
  });
}

async function runCancelAndPreview(
  context: ComposerFormattingStageContext,
): Promise<void> {
  const { client, secrets } = context;
  const { roomName } = await seedStageRoom(context, 'preview');
  await openRoom(client, roomName);
  await recordComposerReadiness(context, assertions.previewComposerReady);

  const draft = '**bold** and plain';
  secrets.SECRET_PREVIEW_DRAFT = draft;
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, '**bold** and plain');
  await client.hideKeyboard();
  const selection = await client.selectWordCurrent(COMPOSER, draft, 'bold');
  await client.record('preview-native-selection', selection);
  await client.hideKeyboard();
  await exactComposer(client, draft, {
    focused: true,
    selectionStart: 2,
    selectionEnd: 6,
  });

  await client.tapCurrent(FORMAT);
  await client.visible(FORMAT_SHEET);
  await client.tapCurrent('[data-testid="format-cancel"]');
  const cancelledSheet = await client.waitElements(
    FORMAT_SHEET,
    (elements) => elements.every((element) => !element.visible),
    'cancelled Format action sheet',
  );
  await recordAssertion(context, assertions.previewCancelHidden, {
    hidden: cancelledSheet.every((element) => !element.visible),
  });
  const cancelled = await exactComposer(client, draft, {
    selectionStart: 2,
    selectionEnd: 6,
  });
  await recordAssertion(context, assertions.previewCancelValue, {
    matches: cancelled.value === draft,
    length: cancelled.value?.length,
  });
  await recordAssertion(context, assertions.previewCancelSelectionStart, {
    selectionStart: cancelled.selectionStart,
  });
  await recordAssertion(context, assertions.previewCancelSelectionEnd, {
    selectionEnd: cancelled.selectionEnd,
  });

  await client.hideKeyboard();
  await client.record('preview-format-after-cancel', await client.visible(FORMAT));
  await client.tapCurrentExposed(FORMAT);
  await client.tapCurrent('[data-testid="format-preview"]');
  const bold = await client.visible('[data-testid="composer-preview"] strong');
  assert.equal(bold.renderedText, 'bold');
  await recordAssertion(context, assertions.previewBoldContent, {
    matches: bold.renderedText === 'bold',
    length: bold.renderedText.length,
  });
  await client.hideKeyboard();
  await client.tapCurrentExposed(FORMAT);
  await client.tapCurrent('[data-testid="format-preview"]');
  const hiddenPreview = await client.waitElements(
    '[data-testid="composer-preview"]',
    (elements) => elements.every((element) => !element.visible),
    'hidden composer preview',
  );
  await recordAssertion(context, assertions.previewHidden, {
    hidden: hiddenPreview.every((element) => !element.visible),
  });
  const restored = await exactComposer(client, draft, {
    focused: true,
    selectionStart: 2,
    selectionEnd: 6,
  });
  await recordAssertion(context, assertions.previewComposerFocused, {
    focused: restored.focused,
  });
  await recordAssertion(context, assertions.previewSelectionStart, {
    selectionStart: restored.selectionStart,
  });
  await recordAssertion(context, assertions.previewSelectionEnd, {
    selectionEnd: restored.selectionEnd,
  });
  const send = await client.visible('[data-testid="composer-send"]');
  await recordAssertion(context, assertions.previewSendVisible, {
    visible: send.visible,
  });
}

async function runCompactLargerText(
  context: ComposerFormattingStageContext,
): Promise<void> {
  const { client, secrets } = context;
  const { account, roomName } = await seedStageRoom(context, 'compact');
  await openRoom(client, roomName);
  const draft = 'compact draft';
  secrets.SECRET_COMPACT_DRAFT = draft;
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, 'compact draft');
  await client.hideKeyboard();
  await client.tapCurrent('[data-testid="back-to-rooms"]');
  await client.activeAccountRooms(account);

  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[data-testid="settings-workspace"]', {}, 30_000);
  await client.tapCurrent('[data-testid="settings-nav-appearance"]');
  await client.visible('[data-testid="text-scale-select"]', {}, 30_000);
  await client.scrollIntoViewIfNeeded(
    '[data-testid="text-scale-select"]',
    '[data-testid="settings-detail"]',
  );
  await client.tapCurrent('[data-testid="text-scale-select"] button');
  await client.tapCurrent('[data-testid="text-scale-larger"]');
  await client.waitElements(
    'html',
    (elements) => elements.length === 1 && elements[0]!.style.fontSize === '20px',
    '20px root font after native Appearance selection',
  );

  await client.relaunch(COMPACT_LARGER_PROFILE);
  await client.activeAccountRooms(account);
  await openRoom(client, roomName);
  await recordComposerReadiness(context, assertions.compactComposerReady);
  const composer = await exactComposer(client, draft);
  await recordAssertion(context, assertions.compactComposerVisible, {
    visible: composer.visible,
  });
  const root = await client.visible('html');
  const fontSize = root.style.fontSize;
  assert(fontSize === '20px');
  await recordAssertion(context, assertions.compactRootFontSize, { fontSize });

  for (const [name, selector, identities] of [
    [
      'format',
      FORMAT,
      {
        visible: assertions.compactFormatVisible,
        width: assertions.compactFormatWidth,
        height: assertions.compactFormatHeight,
        left: assertions.compactFormatLeftBound,
        right: assertions.compactFormatRightBound,
      },
    ],
    [
      'send',
      '[data-testid="composer-send"]',
      {
        visible: assertions.compactSendVisible,
        width: assertions.compactSendWidth,
        height: assertions.compactSendHeight,
        left: assertions.compactSendLeftBound,
        right: assertions.compactSendRightBound,
      },
    ],
  ] as const) {
    const control = await client.visible(selector);
    await recordAssertion(context, identities.visible, {
      name,
      visible: control.visible,
    });
    assert(control.rect.width >= 44);
    await recordAssertion(context, identities.width, {
      name,
      width: control.rect.width,
    });
    assert(control.rect.height >= 44);
    await recordAssertion(context, identities.height, {
      name,
      height: control.rect.height,
    });
    assert(control.rect.x >= 0);
    await recordAssertion(context, identities.left, {
      name,
      x: control.rect.x,
    });
    assert(control.rect.right <= 320.5);
    await recordAssertion(context, identities.right, {
      name,
      right: control.rect.right,
    });
  }

  await client.hideKeyboard();
  await client.tapCurrent(FORMAT);
  await client.tapCurrent('[data-testid="format-preview"]');
  const preview = await client.visible('[data-testid="composer-preview"]');
  assert.equal(preview.renderedText, draft);
  await recordAssertion(context, assertions.compactPreviewContent, {
    matches: preview.renderedText === draft,
    length: preview.renderedText.length,
  });
  await client.hideKeyboard();
  await client.tapCurrent(FORMAT);
  await client.tapCurrent('[data-testid="format-preview"]');
  const restored = await exactComposer(client, draft, { focused: true });
  await recordAssertion(context, assertions.compactComposerFocused, {
    focused: restored.focused,
  });
  await recordAssertion(context, assertions.compactComposerValue, {
    matches: restored.value === draft,
    length: restored.value?.length,
  });
}

const cases: readonly ComposerFormattingCase[] = [
  {
    id: 'apply-selected-italic',
    source: `${COMPOSER_FORMATTING_SOURCES.apply}; ${COMPOSER_FORMATTING_SOURCES.helpers}; ${COMPOSER_FORMATTING_SOURCES.app}; ${COMPOSER_FORMATTING_SOURCES.account}`,
    expectedAssertionRecords: 12,
    run: runApplySelectedItalic,
  },
  {
    id: 'cancel-and-preview',
    source: `${COMPOSER_FORMATTING_SOURCES.preview}; ${COMPOSER_FORMATTING_SOURCES.helpers}; ${COMPOSER_FORMATTING_SOURCES.app}; ${COMPOSER_FORMATTING_SOURCES.account}`,
    expectedAssertionRecords: 11,
    run: runCancelAndPreview,
  },
  {
    id: 'compact-larger-text',
    source: `${COMPOSER_FORMATTING_SOURCES.compact}; ${COMPOSER_FORMATTING_SOURCES.helpers}; ${COMPOSER_FORMATTING_SOURCES.app}; ${COMPOSER_FORMATTING_SOURCES.account}; ${COMPOSER_FORMATTING_SOURCES.navigation}`,
    expectedAssertionRecords: 16,
    run: runCompactLargerText,
  },
];

assert.equal(cases.length, 3, 'Exactly three composer formatting stages exist');
assert.equal(allAssertionIds.length, 39);
assert.equal(COMPOSER_FORMATTING_ASSERTION_RECORDS, 39);
assert.deepEqual(
  cases.map((entry) => entry.expectedAssertionRecords),
  [12, 11, 16],
);
assert.deepEqual(
  Object.values(composerFormattingStageAssertions).map((ids) => ids.length),
  [12, 11, 16],
);

void test(
  'Android composer formatting journeys',
  { timeout: 1_200_000 },
  async (testContext) => {
    await withNodeTestResources(
      { testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'composer-formatting',
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
        matrixResources.cleanup('Scan composer formatting diagnostics', () =>
          scanComposerFormattingArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact composer formatting diagnostics', () =>
          redactMaestroArtifacts(output, secrets, false),
        );

        const unique = new Set<ComposerFormattingAssertion>();
        const records = new Set<ComposerFormattingAssertion>();
        const stages: Array<{
          readonly id: ComposerFormattingCaseId;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 11 | 12 | 16;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 3,
                expectedUniqueAssertions: 39,
                expectedAssertionRecords: 39,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: COMPOSER_FORMATTING_SOURCES,
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
        matrixResources.cleanup('Composer formatting Android device', () =>
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
          const stageRecords = new Set<ComposerFormattingAssertion>();
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
          console.info(`[composer-formatting] ${entry.id} start`);
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
              `[composer-formatting] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Composer formatting journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 39);
        assert.equal(records.size, COMPOSER_FORMATTING_ASSERTION_RECORDS);
      },
    );
  },
);
