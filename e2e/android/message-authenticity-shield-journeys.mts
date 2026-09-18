import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import {
  MESSAGE_AUTHENTICITY_SHIELD_ASSERTION_RECORDS,
  MESSAGE_AUTHENTICITY_SHIELD_SOURCES,
  messageAuthenticityGeometryAssertions,
  messageAuthenticityShieldAssertions as assertions,
  type MessageAuthenticityShieldAssertion,
} from './message-authenticity-shield-contract.mts';

const PRIMARY_APPLICATION_ID = 'eu.qwky.trinity';
const SECONDARY_APPLICATION_ID = 'eu.qwky.trinity.secondary';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const imageArtifactExtensions = new Set(['.jpeg', '.jpg', '.png', '.webp']);
const allAssertionIds = [
  ...Object.values(assertions.plaintext),
  ...Object.values(assertions.shield),
] as readonly MessageAuthenticityShieldAssertion[];

type Fixtures = ReturnType<typeof createAccountFixtures>;
type Direction = 'ltr' | 'rtl';

interface ShieldObservation {
  readonly messageVisible: boolean;
  readonly shieldVisible: boolean;
  readonly eventId: string;
  readonly title: string | null;
  readonly tabindex: string | null;
  readonly focused: boolean;
  readonly receiptVisible: boolean;
  readonly receiptAriaLabel: string;
  readonly tooltipVisible: boolean;
  readonly tooltipReason: string;
  readonly tooltipDetail: string;
  readonly describedBy: string | null;
  readonly tooltipText: string;
}

interface GeometryObservation {
  readonly shieldIsBodyChild: boolean;
  readonly receiptIsBodyChild: boolean;
  readonly shieldTrailingGap: number;
  readonly receiptTrailingGap: number;
  readonly contentOverlapsShield: boolean;
  readonly receiptOverlapsContent: boolean;
  readonly receiptOverlapsShield: boolean;
  readonly rowContainsReceipt: boolean;
}

interface MessageAuthenticityCase {
  readonly id: 'plaintext-no-shield' | 'unsigned-device-shield';
  readonly source: string;
  readonly expectedAssertionRecords: number;
  run(context: {
    readonly primary: AccountWorkspaceClient;
    readonly secondary: AccountWorkspaceClient;
    readonly fixtures: Fixtures;
    readonly secrets: Record<string, string>;
    readonly unique: Set<MessageAuthenticityShieldAssertion>;
    readonly records: Set<string>;
  }): Promise<void>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function oneVisible(elements: readonly AccountElement[]): boolean {
  return elements.length === 1 && elements[0]!.visible;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<MessageAuthenticityShieldAssertion>,
  records: Set<string>,
  identity: MessageAuthenticityShieldAssertion,
  observation: unknown,
  variant?: Direction,
): Promise<void> {
  const recordKey = variant ? `${identity}-${variant}` : identity;
  assert(!records.has(recordKey), `${recordKey} is recorded exactly once`);
  records.add(recordKey);
  unique.add(identity);
  await client.record(recordKey, {
    assertion: identity,
    ...(variant ? { direction: variant } : {}),
    observation,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible('textarea.composer__input', {}, 30_000);
}

async function composeExactMessage(
  client: AccountWorkspaceClient,
  body: string,
): Promise<void> {
  assert(body.length <= 160, 'The exact message fits the composer limit');
  await client.tapCurrent('textarea.composer__input');
  await client.device.runFlow(
    join(
      client.workspaceRoot,
      'e2e/android/flows/message-authenticity-compose.yaml',
    ),
    { APP_ID: client.applicationId, MESSAGE: body },
  );
  const composerValue = await evaluateNative(
    client.webview,
    `document.querySelector('textarea.composer__input')?.value ?? null`,
  );
  assert.equal(composerValue, body);
}

async function openSecuritySettings(
  client: AccountWorkspaceClient,
): Promise<void> {
  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[aria-label="Settings sections"]', {}, 30_000);
  await client.tapCurrent('[data-testid="settings-nav-security"]');
  await client.visible('[data-testid="security-settings"]', {}, 30_000);
}

async function answerPasswordUiaIfAsked(
  client: AccountWorkspaceClient,
  password: string,
): Promise<void> {
  const outcome = await waitForNativeShellState(
    async () => ({
      prompt: await client.elements('trn-alert-dialog h2', {
        exactText: 'Confirm your password',
      }),
      recovery: await client.elements('[data-testid="recovery-key"]'),
    }),
    ({ prompt, recovery }) => oneVisible(prompt) || oneVisible(recovery),
    'conditional encryption-setup password UIA',
    client.signal,
    60_000,
  );
  if (!oneVisible(outcome.prompt)) return;
  await client.tapCurrent('trn-alert-dialog input');
  await client.fillFocused('trn-alert-dialog input', password);
  await client.tapCurrent('[data-testid="alert-confirm"]');
  await client.visible('[data-testid="recovery-key"]', {}, 60_000);
}

async function establishRecovery(
  client: AccountWorkspaceClient,
  account: NodeWorkspaceAccount,
): Promise<void> {
  await openSecuritySettings(client);
  await client.visible('[data-testid="security-setup"]', {}, 30_000);
  await client.tapCurrent('[data-testid="security-setup"]');
  await waitForNativeShellState(
    () => client.surface(),
    (surface) => new URL(surface.url).pathname === '/encryption/setup',
    'native encryption setup route',
    client.signal,
    30_000,
  );
  await client.tapCurrent('button', { exactText: 'Set up encryption' });
  await answerPasswordUiaIfAsked(client, account.password);
  await client.visible('[data-testid="recovery-key"]', {}, 60_000);
  await client.tapCurrent(
    '[data-testid="recovery-key-saved"] input[role="checkbox"]',
  );
  await client.tapCurrent('button', { exactText: 'Continue to Trinity' });
  await client.activeAccountRooms(account);
}

async function deactivate(client: AccountWorkspaceClient): Promise<void> {
  await client.close();
  await client.device.adb(
    'shell',
    'am',
    'force-stop',
    client.applicationId,
  );
}

async function observeShield(
  client: AccountWorkspaceClient,
  body: string,
): Promise<ShieldObservation> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
      const body = ${JSON.stringify(body)};
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible';
      };
      const row = [...document.querySelectorAll('.msg[data-mid]')].find(
        (candidate) => candidate.querySelector('.msg__text')?.textContent?.includes(body),
      );
      const message = row?.querySelector('.msg__text');
      const shield = row?.querySelector('[data-testid^="msg-shield-"]');
      const receipt = row?.querySelector('[data-testid="read-receipts"]');
      const tooltip = document.querySelector('[data-testid="msg-shield-tip"]');
      return {
        messageVisible: visible(message),
        shieldVisible: visible(shield),
        eventId: row?.getAttribute('data-mid') ?? '',
        title: shield?.getAttribute('title') ?? null,
        tabindex: shield?.getAttribute('tabindex') ?? null,
        focused: document.activeElement === shield,
        receiptVisible: visible(receipt),
        receiptAriaLabel: receipt?.getAttribute('aria-label') ?? '',
        tooltipVisible: visible(tooltip),
        tooltipReason: tooltip?.querySelector('.msg__shield-tip-reason')?.textContent?.trim() ?? '',
        tooltipDetail: tooltip?.querySelector('.msg__shield-tip-detail')?.textContent?.trim() ?? '',
        describedBy: shield?.getAttribute('aria-describedby') ?? null,
        tooltipText: tooltip?.textContent?.trim() ?? '',
      };
    })()`,
  );
  assert(value && typeof value === 'object');
  return value as ShieldObservation;
}

async function focusShieldWithNativeTab(
  client: AccountWorkspaceClient,
  body: string,
): Promise<ShieldObservation> {
  for (let step = 0; step < 64; step++) {
    const observation = await observeShield(client, body);
    if (observation.focused) return observation;
    await client.key('tab');
  }
  assert.fail('Native Tab traversal did not reach the authenticity shield');
}

async function observeGeometry(
  client: AccountWorkspaceClient,
  body: string,
  direction: Direction,
): Promise<GeometryObservation> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
      const body = ${JSON.stringify(body)};
      const direction = ${JSON.stringify(direction)};
      document.documentElement.dir = direction;
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rowEl = [...document.querySelectorAll('.msg[data-mid]')].find(
          (candidate) => candidate.querySelector('.msg__text')?.textContent?.includes(body),
        );
        const bodyEl = rowEl?.querySelector('.msg__body');
        const contentEl = bodyEl?.querySelector('.msg__content');
        const shieldEl = bodyEl?.querySelector('[data-testid^="msg-shield-"]');
        const receiptEl = bodyEl?.querySelector('[data-testid="read-receipts"]');
        if (!rowEl || !bodyEl || !contentEl || !shieldEl || !receiptEl) {
          resolve(null);
          return;
        }
        const row = rowEl.getBoundingClientRect();
        const bodyBox = bodyEl.getBoundingClientRect();
        const content = contentEl.getBoundingClientRect();
        const shield = shieldEl.getBoundingClientRect();
        const receipt = receiptEl.getBoundingClientRect();
        const overlaps = (left, right) =>
          left.left < right.right && left.right > right.left &&
          left.top < right.bottom && left.bottom > right.top;
        const trailingGap = (box) =>
          direction === 'rtl' ? box.left - bodyBox.left : bodyBox.right - box.right;
        resolve({
          shieldIsBodyChild: shieldEl.parentElement === bodyEl,
          receiptIsBodyChild: receiptEl.parentElement === bodyEl,
          shieldTrailingGap: trailingGap(shield),
          receiptTrailingGap: trailingGap(receipt),
          contentOverlapsShield: overlaps(content, shield),
          receiptOverlapsContent: overlaps(receipt, content),
          receiptOverlapsShield: overlaps(receipt, shield),
          rowContainsReceipt:
            receipt.top >= row.top - 1 && receipt.bottom <= row.bottom + 1,
        });
      })));
    })()`,
  );
  assert(value && typeof value === 'object');
  return value as GeometryObservation;
}

async function recordGeometry(
  client: AccountWorkspaceClient,
  unique: Set<MessageAuthenticityShieldAssertion>,
  records: Set<string>,
  body: string,
): Promise<void> {
  try {
    for (const direction of ['ltr', 'rtl'] as const) {
      const geometry = await observeGeometry(client, body, direction);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.geometryObservationComplete,
        { complete: true, geometry },
        direction,
      );
      assert.equal(geometry.shieldIsBodyChild, true);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.shieldBodyChild,
        { bodyChild: geometry.shieldIsBodyChild },
        direction,
      );
      assert.equal(geometry.receiptIsBodyChild, true);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.receiptBodyChild,
        { bodyChild: geometry.receiptIsBodyChild },
        direction,
      );
      assert.equal(
        Math.abs(geometry.shieldTrailingGap) <= 1,
        true,
        `${direction} shield trailing gap: ${geometry.shieldTrailingGap}`,
      );
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.shieldTrailingEdge,
        { withinOnePixel: true },
        direction,
      );
      assert.equal(
        Math.abs(geometry.receiptTrailingGap) <= 1,
        true,
        `${direction} receipt trailing gap: ${geometry.receiptTrailingGap}`,
      );
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.receiptTrailingEdge,
        { withinOnePixel: true },
        direction,
      );
      assert.equal(geometry.contentOverlapsShield, false);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.contentShieldNonoverlap,
        { overlaps: false },
        direction,
      );
      assert.equal(geometry.receiptOverlapsContent, false);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.receiptContentNonoverlap,
        { overlaps: false },
        direction,
      );
      assert.equal(geometry.receiptOverlapsShield, false);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.receiptShieldNonoverlap,
        { overlaps: false },
        direction,
      );
      assert.equal(geometry.rowContainsReceipt, true);
      await recordAssertion(
        client,
        unique,
        records,
        assertions.shield.receiptWithinRow,
        { withinRow: true },
        direction,
      );
    }
  } finally {
    await evaluateNative(
      client.webview,
      `(() => { document.documentElement.removeAttribute('dir'); return true; })()`,
    );
  }
}

async function scanMessageAuthenticityShieldArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Message-authenticity artifact is a file: ${path}`);
      if (!textArtifactExtensions.has(extname(path))) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of values) {
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

async function removeMessageAuthenticityMaestroImages(
  output: string,
): Promise<void> {
  async function remove(directory: string, insideFlow: boolean): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const ownsFlow =
      insideFlow ||
      entries.some((entry) => entry.isFile() && entry.name === 'maestro.log');
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await remove(path, ownsFlow);
      } else if (
        ownsFlow &&
        entry.isFile() &&
        imageArtifactExtensions.has(extname(path))
      ) {
        await unlink(path);
      }
    }
  }
  await remove(output, false);
}

const cases: readonly MessageAuthenticityCase[] = [
  {
    id: 'plaintext-no-shield',
    source: `${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.plaintext}; ${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.app}; ${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.account}`,
    expectedAssertionRecords: 2,
    async run({ primary, fixtures, secrets, unique, records }) {
      const owner = await fixtures.account('message-authenticity-plain-owner');
      const reader = await fixtures.account('message-authenticity-plain-reader');
      secrets.PLAIN_OWNER_PASSWORD = owner.password;
      secrets.PLAIN_READER_PASSWORD = reader.password;
      const room = await fixtures.createRoom(owner, {
        name: `Plain ${Date.now()}`,
        preset: 'private_chat',
        invite: [reader.userId],
      });
      await fixtures.join(reader, room.id);
      const body = `plaintext message ${Date.now()}`;
      await fixtures.sendMessage(owner, room.id, body, `plain-${Date.now()}`);

      await primary.login(reader);
      await openRoom(primary, room.name);
      const message = await primary.visible('.scroll .msg__text', { text: body }, 30_000);
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.plaintext.messageVisible,
        { visible: message.visible },
      );
      const plaintextShields = await primary.elements(
        '[data-testid^="msg-shield-"]',
      );
      assert.equal(plaintextShields.length, 0);
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.plaintext.shieldAbsent,
        { count: plaintextShields.length },
      );
    },
  },
  {
    id: 'unsigned-device-shield',
    source: `${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.shielded}; ${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.helpers}; ${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.app}; ${MESSAGE_AUTHENTICITY_SHIELD_SOURCES.account}`,
    expectedAssertionRecords: 33,
    async run({ primary, secondary, fixtures, secrets, unique, records }) {
      const account = await fixtures.account('message-authenticity-shield');
      const seer = await fixtures.account('message-authenticity-seer');
      const seerName = `Shield reader ${Date.now()}`;
      secrets.SHIELD_ACCOUNT_PASSWORD = account.password;
      secrets.SHIELD_SEER_PASSWORD = seer.password;
      await fixtures.setDisplayName(seer, seerName);
      const room = await fixtures.createRoom(account, {
        name: `Sealed ${Date.now()}`,
        preset: 'private_chat',
        invite: [seer.userId],
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      });
      assert(room.id.length > 0);
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.roomCreated,
        { nonEmpty: room.id.length > 0 },
      );
      await fixtures.join(seer, room.id);

      await primary.login(account);
      await establishRecovery(primary, account);
      await deactivate(primary);

      await secondary.reset(PIXEL_5_ACCOUNT_PROFILE);
      await secondary.login(account);
      await openRoom(secondary, room.name);
      const messageToken = Date.now().toString(36);
      const body = `encrypted from an unsigned device ${messageToken} — long enough that this line wraps all the way across the message body and reaches the right-hand edge of the row`;
      await composeExactMessage(secondary, body);
      await secondary.tapCurrent('[data-testid="composer-send"]');
      const secondaryMessage = await secondary.visible(
        '.scroll .msg__text',
        { text: body },
        60_000,
      );
      await recordAssertion(
        secondary,
        unique,
        records,
        assertions.shield.secondaryMessageVisible,
        { visible: secondaryMessage.visible },
      );
      await secondary.capture('passed-send');
      await deactivate(secondary);

      await primary.relaunch(PIXEL_5_ACCOUNT_PROFILE);
      await primary.activeAccountRooms(account);
      await openRoom(primary, room.name);
      const primaryMessage = await primary.visible(
        '.scroll .msg__text',
        { text: body },
        60_000,
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.primaryMessageVisible,
        { visible: primaryMessage.visible },
      );

      const shield = await waitForNativeShellState(
        () => observeShield(primary, body),
        (observation) =>
          observation.messageVisible &&
          observation.shieldVisible &&
          observation.eventId.length > 0,
        'exact unsigned-device message shield',
        primary.signal,
        60_000,
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.shieldVisible,
        { visible: shield.shieldVisible },
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.eventIdNonempty,
        { nonEmpty: shield.eventId.length > 0 },
      );

      await fixtures.sendReadReceipt(seer, room.id, shield.eventId);
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.receiptResponseOk,
        { ok: true },
      );
      const receipt = await waitForNativeShellState(
        () => observeShield(primary, body),
        (observation) =>
          observation.receiptVisible &&
          observation.receiptAriaLabel.includes(seerName),
        'exact-event read receipt and reader label',
        primary.signal,
        30_000,
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.receiptVisible,
        { visible: receipt.receiptVisible },
      );
      assert(receipt.receiptAriaLabel.includes(seerName));
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.receiptReaderLabel,
        { includesExactReaderName: true },
      );

      assert.equal(shield.title, null);
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.nativeTitleAbsent,
        { absent: shield.title === null },
      );
      assert.equal(shield.tabindex, '0');
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.focusableTabindex,
        { tabindex: shield.tabindex },
      );

      await focusShieldWithNativeTab(primary, body);
      const tooltip = await waitForNativeShellState(
        () => observeShield(primary, body),
        (observation) =>
          observation.focused &&
          observation.tooltipVisible &&
          observation.tooltipReason.length > 0 &&
          observation.tooltipDetail.length > 0 &&
          Boolean(observation.describedBy),
        'native-focused authenticity tooltip',
        primary.signal,
        15_000,
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.tooltipVisible,
        { visible: tooltip.tooltipVisible },
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.tooltipReasonNonempty,
        { nonEmpty: tooltip.tooltipReason.length > 0 },
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.tooltipDetailNonempty,
        { nonEmpty: tooltip.tooltipDetail.length > 0 },
      );
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.ariaDescribed,
        { described: Boolean(tooltip.describedBy) },
      );
      assert(!/intercept|read by|eavesdrop|compromised|leaked/i.test(tooltip.tooltipText));
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.shield.copyDoesNotOverstate,
        { prohibitedCopyAbsent: true },
      );

      await recordGeometry(primary, unique, records, body);
    },
  },
];

assert.equal(cases.length, 2, 'Exactly two message-authenticity stages exist');
assert.equal(allAssertionIds.length, 26);
assert.equal(messageAuthenticityGeometryAssertions.length, 9);
assert.equal(MESSAGE_AUTHENTICITY_SHIELD_ASSERTION_RECORDS, 35);

void test(
  'Android message-authenticity shield journeys',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'message-authenticity-shield',
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
          'Scan message-authenticity diagnostics',
          () => scanMessageAuthenticityShieldArtifacts(output, secrets),
        );
        matrixResources.cleanup(
          'Redact message-authenticity diagnostics',
          () => redactMaestroArtifacts(output, secrets),
        );
        matrixResources.cleanup(
          'Remove secret-bearing Maestro images',
          () => removeMessageAuthenticityMaestroImages(output),
        );

        const unique = new Set<MessageAuthenticityShieldAssertion>();
        const records = new Set<string>();
        const stages: Array<{
          readonly id: MessageAuthenticityCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: number;
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
                expectedUniqueAssertions: 26,
                expectedAssertionRecords: 35,
                attempt: 1,
                retries: 0,
                applications: [
                  PRIMARY_APPLICATION_ID,
                  SECONDARY_APPLICATION_ID,
                ],
                sources: MESSAGE_AUTHENTICITY_SHIELD_SOURCES,
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
        matrixResources.cleanup('Message-authenticity Android device', () =>
          device.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
          PRIMARY_APPLICATION_ID,
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/secondaryDebug/app-secondaryDebug.apk',
          ),
          SECONDARY_APPLICATION_ID,
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          const primary = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            join(directory, 'primary'),
            signal,
            PRIMARY_APPLICATION_ID,
          );
          const secondary = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            join(directory, 'secondary'),
            signal,
            SECONDARY_APPLICATION_ID,
          );
          await mkdir(primary.output, { recursive: true });
          await mkdir(secondary.output, { recursive: true });
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
          const recordsBefore = records.size;
          const failures: unknown[] = [];
          console.info(`[message-authenticity] ${entry.id} start`);
          try {
            await primary.reset(PIXEL_5_ACCOUNT_PROFILE);
            await entry.run({
              primary,
              secondary,
              fixtures,
              secrets,
              unique,
              records,
            });
            stage.assertionRecords = records.size - recordsBefore;
            assert.equal(
              stage.assertionRecords,
              entry.expectedAssertionRecords,
            );
            await primary.capture('passed');
          } catch (error) {
            failures.push(error);
            for (const [client, name] of [
              [primary, 'failed-primary'],
              [secondary, 'failed-secondary'],
            ] as const) {
              try {
                await client.capture(name);
              } catch (diagnosticError) {
                failures.push(diagnosticError);
              }
            }
          } finally {
            try {
              await primary.close();
            } catch (error) {
              failures.push(error);
            }
            try {
              await secondary.close();
            } catch (error) {
              failures.push(error);
            }
            for (const applicationId of [
              PRIMARY_APPLICATION_ID,
              SECONDARY_APPLICATION_ID,
            ] as const) {
              try {
                await device.clearApplicationData(applicationId);
              } catch (error) {
                failures.push(error);
              }
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures
                .map((error) => describeFailure(error))
                .join('\n');
            }
            await save();
            console.info(
              `[message-authenticity] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Message-authenticity journey ${entry.id} failed`,
            );
          }
        }

        assert.deepEqual([...unique].sort(), [...allAssertionIds].sort());
        assert.equal(records.size, MESSAGE_AUTHENTICITY_SHIELD_ASSERTION_RECORDS);
      },
    );
  },
);
