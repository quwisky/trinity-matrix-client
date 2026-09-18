import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountElement,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  RECOVERY_RESET_SOURCES,
  recoveryResetAssertions as assertions,
  type RecoveryResetAssertion,
} from './recovery-reset-contract.mts';
import { captureSecretSafe } from './recovery-reset-diagnostics.mts';

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

type Fixtures = ReturnType<typeof createAccountFixtures>;

interface RecoveryState {
  readonly originalKey: string;
  readonly defaultKey: string;
  readonly backupVersion: string;
  readonly masterKey: string;
}

interface ReadySecurity {
  readonly copy: AccountElement;
  readonly unlockAbsent: boolean;
  readonly setupAbsent: boolean;
}

interface RecoveryResetCase {
  readonly id: string;
  readonly source: string;
  readonly expected: readonly RecoveryResetAssertion[];
  run(context: {
    readonly primary: AccountWorkspaceClient;
    readonly secondary: AccountWorkspaceClient;
    readonly fixtures: Fixtures;
    readonly secrets: Record<string, string>;
    readonly onAssertionCount: (count: number) => void;
  }): Promise<void>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function redactFailure(
  error: unknown,
  secrets: Readonly<Record<string, string>>,
): string {
  return Object.values(secrets)
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (message, secret) => message.replaceAll(secret, '[REDACTED]'),
      describeFailure(error),
    );
}

const assertionCountObservers = new WeakMap<
  Set<RecoveryResetAssertion>,
  (count: number) => void
>();

async function recordAssertion(
  client: AccountWorkspaceClient,
  recorded: Set<RecoveryResetAssertion>,
  identity: RecoveryResetAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
  assertionCountObservers.get(recorded)?.(recorded.size);
}

function createRecordedAssertions(
  onAssertionCount: (count: number) => void,
): Set<RecoveryResetAssertion> {
  const recorded = new Set<RecoveryResetAssertion>();
  assertionCountObservers.set(recorded, onAssertionCount);
  return recorded;
}

function assertExactAssertions(
  recorded: ReadonlySet<RecoveryResetAssertion>,
  expected: readonly RecoveryResetAssertion[],
): void {
  assert.deepEqual([...recorded].sort(), [...expected].sort());
}

function oneVisible(elements: readonly AccountElement[]): boolean {
  return elements.length === 1 && elements[0]!.visible;
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

async function openSecuritySettings(
  client: AccountWorkspaceClient,
): Promise<void> {
  const current = new URL((await client.surface()).url);
  if (current.pathname === '/settings/security') {
    await client.visible('[data-testid="security-settings"]', {}, 30_000);
    return;
  }
  assert(
    current.pathname.startsWith('/rooms'),
    `Security navigation starts from Rooms, received ${current.pathname}`,
  );
  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[aria-label="Settings sections"]', {}, 30_000);
  await client.tapCurrent('[data-testid="settings-nav-security"]');
  await waitForNativeShellState(
    async () => ({
      surface: await client.surface(),
      settings: await client.elements('[data-testid="security-settings"]'),
    }),
    ({ surface, settings }) =>
      new URL(surface.url).pathname === '/settings/security' &&
      oneVisible(settings),
    'native Security settings navigation',
    client.signal,
    30_000,
  );
}

async function answerPasswordUiaIfAsked(
  client: AccountWorkspaceClient,
  password: string,
  settledSelector: string,
): Promise<void> {
  const outcome = await waitForNativeShellState(
    async () => ({
      password: await client.elements('trn-alert-dialog h2', {
        exactText: 'Confirm your password',
      }),
      settled: await client.elements(settledSelector),
    }),
    ({ password: prompt, settled }) =>
      oneVisible(prompt) || oneVisible(settled),
    `conditional password UIA or ${settledSelector}`,
    client.signal,
    60_000,
  );
  if (!oneVisible(outcome.password)) return;
  await client.tapCurrent('trn-alert-dialog input');
  await client.fillFocused('trn-alert-dialog input', password);
  await client.tapCurrent('[data-testid="alert-confirm"]');
  await client.visible(settledSelector, {}, 60_000);
}

async function establishRecovery(
  client: AccountWorkspaceClient,
  fixtures: Fixtures,
  account: NodeWorkspaceAccount,
  secrets: Record<string, string>,
  stageId: string,
): Promise<RecoveryState> {
  await client.login(account);
  await openSecuritySettings(client);
  await client.visible('[data-testid="security-setup"]', {}, 30_000);
  await client.tapCurrent('[data-testid="security-setup"]');
  await waitForNativeShellState(
    () => client.surface(),
    (surface) => new URL(surface.url).pathname === '/encryption/setup',
    'encryption setup route',
    client.signal,
    30_000,
  );
  await client.tapCurrent('button', { exactText: 'Set up encryption' });
  await answerPasswordUiaIfAsked(
    client,
    account.password,
    '[data-testid="recovery-key"]',
  );
  const key = await client.visible(
    '[data-testid="recovery-key"]',
    {},
    60_000,
  );
  const originalKey = key.text.trim();
  assert(originalKey.length > 0, 'Initial recovery key is non-empty');
  secrets[`${stageId}_ORIGINAL_RECOVERY_KEY`] = originalKey;
  await client.tapCurrent(
    '[data-testid="recovery-key-saved"] input[role="checkbox"]',
  );
  await client.tapCurrent('button', { exactText: 'Continue to Trinity' });
  await client.rooms(account);

  const defaultKey = await fixtures.defaultKeyId(account);
  const backupVersion = await fixtures.keyBackupVersion(account);
  const masterKey = await fixtures.masterKey(account);
  assert(defaultKey, 'Initial secret-storage default key exists');
  assert(backupVersion, 'Initial key-backup version exists');
  assert(masterKey, 'Initial cross-signing master key exists');
  return { originalKey, defaultKey, backupVersion, masterKey };
}

async function enterSecondaryRecovery(
  client: AccountWorkspaceClient,
  account: NodeWorkspaceAccount,
): Promise<{
  readonly lost: AccountElement;
  readonly unlock: AccountElement;
  readonly reset: AccountElement;
}> {
  await client.reset(DESKTOP_ACCOUNT_PROFILE);
  await client.login(account);
  await openSecuritySettings(client);
  const lost = await client.visible(
    '[data-testid="security-reset-recovery"]',
    { exactText: "I've lost my recovery key" },
    60_000,
  );
  const unlock = await client.visible(
    '[data-testid="security-unlock"]',
    { exactText: 'Enter recovery key' },
    60_000,
  );
  await client.tapCurrent('[data-testid="security-unlock"]');
  await waitForNativeShellState(
    () => client.surface(),
    (surface) =>
      new URL(surface.url).pathname === '/settings/security' &&
      surface.body.includes('Enter your recovery key'),
    'secondary nested encryption unlock surface',
    client.signal,
    30_000,
  );
  const reset = await client.visible(
    '[data-testid="reset-recovery"]',
    { exactText: "I've lost my recovery key" },
    30_000,
  );
  return { lost, unlock, reset };
}

async function openResetGate(
  client: AccountWorkspaceClient,
  trigger = '[data-testid="reset-recovery"]',
): Promise<AccountElement> {
  await client.tapCurrent(trigger);
  await client.visible('trn-alert-dialog h2', {
    exactText: 'Reset encryption',
  });
  return client.visible('trn-alert-dialog p');
}

async function confirmResetWord(
  client: AccountWorkspaceClient,
  value: 'RESET' | 'yes please',
): Promise<void> {
  await client.tapCurrent('trn-alert-dialog input');
  if (value === 'RESET') {
    await client.fillFocused('trn-alert-dialog input', 'RESET');
  } else {
    await client.fillFocused('trn-alert-dialog input', 'yes please');
  }
  await client.tapCurrent('[data-testid="alert-confirm"]');
}

async function unlockWithOriginalKey(
  client: AccountWorkspaceClient,
  originalKey: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="recovery-key-input"]');
  await client.fillFocused('[data-testid="recovery-key-input"]', originalKey);
  await client.tapCurrent('[data-testid="unlock-submit"]');
}

async function returnToRooms(
  client: AccountWorkspaceClient,
  account: NodeWorkspaceAccount,
): Promise<void> {
  for (let presses = 0; presses < 2; presses += 1) {
    const current = new URL((await client.surface()).url);
    if (current.pathname.startsWith('/rooms')) break;
    assert(
      current.pathname.startsWith('/settings'),
      `Native Back to Rooms starts in Settings, received ${current.pathname}`,
    );
    await client.device.adb('shell', 'input', 'keyevent', '4');
    await waitForNativeShellState(
      () => client.surface(),
      (surface) => new URL(surface.url).pathname !== current.pathname,
      `native Back leaves ${current.pathname}`,
      client.signal,
      30_000,
    );
  }
  await client.rooms(account);
}

async function assertReadySecurity(
  client: AccountWorkspaceClient,
): Promise<ReadySecurity> {
  await openSecuritySettings(client);
  const copy = await client.visible(
    '[data-testid="security-encryption"]',
    { text: 'Your messages are secured' },
    30_000,
  );
  const unlock = await client.elements('[data-testid="security-unlock"]');
  const setup = await client.elements('[data-testid="security-setup"]');
  assert.equal(unlock.length, 0, 'Ready Security has no unlock action');
  assert.equal(setup.length, 0, 'Ready Security has no setup action');
  return {
    copy,
    unlockAbsent: unlock.length === 0,
    setupAbsent: setup.length === 0,
  };
}

async function scanRecoveryResetArtifacts(
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
      assert(entry.isFile(), `Recovery-reset artifact is a file: ${path}`);
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

async function removeRecoveryResetMaestroImages(output: string): Promise<void> {
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

const cases: readonly RecoveryResetCase[] = [
  {
    id: 'replacement-key-reset',
    source: `${RECOVERY_RESET_SOURCES.replacement}; ${RECOVERY_RESET_SOURCES.helpers}; ${RECOVERY_RESET_SOURCES.app}; ${RECOVERY_RESET_SOURCES.account}`,
    expected: Object.values(assertions.replacement),
    async run({ primary, secondary, fixtures, secrets, onAssertionCount }) {
      const recorded = createRecordedAssertions(onAssertionCount);
      const account = await fixtures.account('recovery-reset-replacement');
      secrets[`${this.id}_PASSWORD`] = account.password;
      const before = await establishRecovery(
        primary,
        fixtures,
        account,
        secrets,
        this.id,
      );
      const { originalKey } = before;
      await recordAssertion(
        primary,
        recorded,
        assertions.replacement.originalKeyNonempty,
        { nonEmpty: originalKey.length > 0 },
      );
      await recordAssertion(
        primary,
        recorded,
        assertions.replacement.defaultKeyBeforeNonempty,
        {
          nonEmpty: before.defaultKey.length > 0,
          backupNonEmpty: before.backupVersion.length > 0,
          masterNonEmpty: before.masterKey.length > 0,
        },
      );
      await deactivate(primary);

      const recovery = await enterSecondaryRecovery(secondary, account);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.resetActionVisible,
        { visible: recovery.reset.visible },
      );
      const warning = await openResetGate(secondary);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.warningGateVisible,
        { visible: warning.visible },
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.backupDeletionWarning,
        { includesBackupDeletion: warning.text.includes('backup on the server is deleted') },
      );
      assert(warning.text.includes('backup on the server is deleted'));
      const spelledOut = warning.renderedText;
      const consequenceLines = spelledOut.split('\n').filter((line) => line.trim().length > 0);
      assert.equal(consequenceLines.length, 4);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.fourConsequenceLines,
        { lineCount: consequenceLines.length },
      );
      assert(spelledOut.includes('Type RESET to confirm'));
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.resetWordInstruction,
        { exactInstruction: true },
      );

      await confirmResetWord(secondary, 'yes please');
      await secondary.waitElements(
        'trn-alert-dialog',
        (elements) => elements.length === 0,
        'wrong-word reset gate closes',
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.wrongWordGateHidden,
        { hidden: true },
      );
      const resetAgain = await secondary.waitElements(
        '[data-testid="reset-recovery"]',
        (elements) => oneVisible(elements) && !elements[0]!.disabled,
        'wrong-word reset action re-enabled',
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.wrongWordResetReenabled,
        { enabled: !resetAgain[0]!.disabled },
      );
      const wrongWordKey = await fixtures.defaultKeyId(account);
      assert.equal(wrongWordKey, before.defaultKey);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.wrongWordDefaultKeyUnchanged,
        { unchanged: wrongWordKey === before.defaultKey },
      );
      const feedback = await secondary.visible('[data-testid="unlock-error"]');
      assert(feedback.text.includes('RESET'));
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.wrongWordFeedback,
        { mentionsReset: feedback.text.includes('RESET') },
      );

      const confirmedWarning = await openResetGate(secondary);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.confirmedGateVisible,
        { visible: confirmedWarning.visible },
      );
      await confirmResetWord(secondary, 'RESET');
      await answerPasswordUiaIfAsked(
        secondary,
        account.password,
        '[data-testid="recovery-key"]',
      );
      const replacement = await secondary.visible(
        '[data-testid="recovery-key"]',
        {},
        60_000,
      );
      const replacementKey = replacement.text.trim();
      secrets[`${this.id}_REPLACEMENT_RECOVERY_KEY`] = replacementKey;
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.recoveryKeyVisible,
        { visible: replacement.visible },
      );
      assert(replacementKey.length > 0);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.replacementKeyNonempty,
        { nonEmpty: replacementKey.length > 0 },
      );
      assert.notEqual(replacementKey, originalKey);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.replacementKeyDifferent,
        { different: replacementKey !== originalKey },
      );
      const doneDisabled = await secondary.visible('[data-testid="reset-done"]');
      assert(doneDisabled.disabled);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.acknowledgementDisabled,
        { disabled: doneDisabled.disabled },
      );
      await secondary.tapCurrent(
        '[data-testid="recovery-key-saved"] input[role="checkbox"]',
      );
      const doneEnabled = await secondary.waitElements(
        '[data-testid="reset-done"]',
        (elements) => oneVisible(elements) && !elements[0]!.disabled,
        'replacement acknowledgement enables Done',
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.acknowledgementEnabled,
        { enabled: !doneEnabled[0]!.disabled },
      );
      await secondary.tapCurrent('[data-testid="reset-done"]');
      const defaultKeyAfter = await waitForNativeShellState(
        () => fixtures.defaultKeyId(account),
        (key) => typeof key === 'string' && key.length > 0 && key !== before.defaultKey,
        'replacement secret-storage default key',
        secondary.signal,
        30_000,
      );
      assert(defaultKeyAfter, 'Replacement secret-storage default key exists');
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.defaultKeyAfterNonempty,
        { nonEmpty: defaultKeyAfter.length > 0 },
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.defaultKeyChanged,
        { changed: defaultKeyAfter !== before.defaultKey },
      );
      await secondary.relaunch(DESKTOP_ACCOUNT_PROFILE);
      const ready = await assertReadySecurity(secondary);
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.readySecurityCopy,
        { securedCopy: ready.copy.text.includes('Your messages are secured') },
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.unlockActionAbsent,
        { absent: ready.unlockAbsent },
      );
      await recordAssertion(
        secondary,
        recorded,
        assertions.replacement.setupActionAbsent,
        { absent: ready.setupAbsent },
      );
      assertExactAssertions(recorded, this.expected);
    },
  },
  {
    id: 'password-cancel-atomicity',
    source: `${RECOVERY_RESET_SOURCES.cancel}; ${RECOVERY_RESET_SOURCES.helpers}; ${RECOVERY_RESET_SOURCES.app}; ${RECOVERY_RESET_SOURCES.account}`,
    expected: Object.values(assertions.cancel),
    async run({ primary, secondary, fixtures, secrets, onAssertionCount }) {
      const recorded = createRecordedAssertions(onAssertionCount);
      const account = await fixtures.account('recovery-reset-cancel');
      secrets[`${this.id}_PASSWORD`] = account.password;
      const before = await establishRecovery(
        primary,
        fixtures,
        account,
        secrets,
        this.id,
      );
      await recordAssertion(primary, recorded, assertions.cancel.defaultKeyBeforeNonempty, {
        nonEmpty: before.defaultKey.length > 0,
      });
      await recordAssertion(primary, recorded, assertions.cancel.backupVersionBeforeNonempty, {
        nonEmpty: before.backupVersion.length > 0,
        masterNonEmpty: before.masterKey.length > 0,
      });
      await deactivate(primary);

      const recovery = await enterSecondaryRecovery(secondary, account);
      await recordAssertion(secondary, recorded, assertions.cancel.resetActionVisible, {
        visible: recovery.reset.visible,
      });
      const gate = await openResetGate(secondary);
      await recordAssertion(secondary, recorded, assertions.cancel.resetGateVisible, {
        visible: gate.visible,
      });
      await confirmResetWord(secondary, 'RESET');
      const passwordGate = await secondary.visible('trn-alert-dialog h2', {
        exactText: 'Confirm your password',
      }, 60_000);
      await recordAssertion(secondary, recorded, assertions.cancel.passwordGateVisible, {
        visible: passwordGate.visible,
      });
      await secondary.tapCurrent('[data-testid="alert-cancel"]');
      const recoveryKeys = await secondary.elements('[data-testid="recovery-key"]');
      assert.equal(recoveryKeys.length, 0);
      await recordAssertion(secondary, recorded, assertions.cancel.recoveryKeyAbsent, {
        absent: recoveryKeys.length === 0,
      });
      const reset = await secondary.waitElements(
        '[data-testid="reset-recovery"]',
        (elements) => oneVisible(elements) && !elements[0]!.disabled,
        'cancelled reset action re-enabled',
        {},
        30_000,
      );
      await recordAssertion(secondary, recorded, assertions.cancel.resetActionReenabled, {
        enabled: !reset[0]!.disabled,
      });
      const backupAfter = await fixtures.keyBackupVersion(account);
      const defaultAfter = await fixtures.defaultKeyId(account);
      assert.equal(backupAfter, before.backupVersion);
      assert.equal(defaultAfter, before.defaultKey);
      await recordAssertion(secondary, recorded, assertions.cancel.backupVersionUnchanged, {
        unchanged: backupAfter === before.backupVersion,
      });
      await recordAssertion(secondary, recorded, assertions.cancel.defaultKeyUnchanged, {
        unchanged: defaultAfter === before.defaultKey,
      });
      await deactivate(secondary);
      await primary.relaunch(DESKTOP_ACCOUNT_PROFILE);
      const ready = await assertReadySecurity(primary);
      await recordAssertion(primary, recorded, assertions.cancel.readySecurityCopy, {
        securedCopy: ready.copy.text.includes('Your messages are secured'),
      });
      await recordAssertion(primary, recorded, assertions.cancel.unlockActionAbsent, {
        absent: ready.unlockAbsent,
      });
      await recordAssertion(primary, recorded, assertions.cancel.setupActionAbsent, {
        absent: ready.setupAbsent,
      });
      assertExactAssertions(recorded, this.expected);
    },
  },
  {
    id: 'original-key-after-cancel',
    source: `${RECOVERY_RESET_SOURCES.originalKey}; ${RECOVERY_RESET_SOURCES.helpers}; ${RECOVERY_RESET_SOURCES.app}; ${RECOVERY_RESET_SOURCES.account}`,
    expected: Object.values(assertions.originalKey),
    async run({ primary, secondary, fixtures, secrets, onAssertionCount }) {
      const recorded = createRecordedAssertions(onAssertionCount);
      const account = await fixtures.account('recovery-reset-original-key');
      secrets[`${this.id}_PASSWORD`] = account.password;
      const before = await establishRecovery(
        primary,
        fixtures,
        account,
        secrets,
        this.id,
      );
      const { originalKey } = before;
      await recordAssertion(primary, recorded, assertions.originalKey.originalKeyNonempty, {
        nonEmpty: originalKey.length > 0,
      });
      await recordAssertion(primary, recorded, assertions.originalKey.defaultKeyBeforeNonempty, {
        nonEmpty: before.defaultKey.length > 0,
      });
      await recordAssertion(primary, recorded, assertions.originalKey.backupVersionBeforeNonempty, {
        nonEmpty: before.backupVersion.length > 0,
      });
      await recordAssertion(primary, recorded, assertions.originalKey.masterKeyBeforeNonempty, {
        nonEmpty: before.masterKey.length > 0,
      });
      await deactivate(primary);

      const recovery = await enterSecondaryRecovery(secondary, account);
      await recordAssertion(secondary, recorded, assertions.originalKey.resetActionVisible, {
        visible: recovery.reset.visible,
      });
      const gate = await openResetGate(secondary);
      await recordAssertion(secondary, recorded, assertions.originalKey.resetGateVisible, {
        visible: gate.visible,
      });
      await confirmResetWord(secondary, 'RESET');
      const passwordGate = await secondary.visible('trn-alert-dialog h2', {
        exactText: 'Confirm your password',
      }, 60_000);
      await recordAssertion(secondary, recorded, assertions.originalKey.passwordGateVisible, {
        visible: passwordGate.visible,
      });
      await secondary.tapCurrent('[data-testid="alert-cancel"]');
      const reset = await secondary.waitElements(
        '[data-testid="reset-recovery"]',
        (elements) => oneVisible(elements) && !elements[0]!.disabled,
        'original-key reset action re-enabled',
        {},
        30_000,
      );
      await recordAssertion(secondary, recorded, assertions.originalKey.resetActionReenabled, {
        enabled: !reset[0]!.disabled,
      });
      await unlockWithOriginalKey(secondary, originalKey);
      const unlockErrors = await secondary.elements('[data-testid="unlock-error"]');
      assert.equal(unlockErrors.length, 0);
      await recordAssertion(secondary, recorded, assertions.originalKey.unlockErrorAbsent, {
        absent: unlockErrors.length === 0,
      });
      await returnToRooms(secondary, account);
      const ready = await assertReadySecurity(secondary);
      await recordAssertion(secondary, recorded, assertions.originalKey.readySecurityCopy, {
        securedCopy: ready.copy.text.includes('Your messages are secured'),
      });
      await recordAssertion(secondary, recorded, assertions.originalKey.unlockActionAbsent, {
        absent: ready.unlockAbsent,
      });
      await recordAssertion(secondary, recorded, assertions.originalKey.setupActionAbsent, {
        absent: ready.setupAbsent,
      });
      const masterAfter = await fixtures.masterKey(account);
      const backupAfter = await fixtures.keyBackupVersion(account);
      const defaultAfter = await fixtures.defaultKeyId(account);
      assert.equal(masterAfter, before.masterKey);
      assert.equal(backupAfter, before.backupVersion);
      assert.equal(defaultAfter, before.defaultKey);
      await recordAssertion(secondary, recorded, assertions.originalKey.masterKeyUnchanged, {
        unchanged: masterAfter === before.masterKey,
      });
      await recordAssertion(secondary, recorded, assertions.originalKey.backupVersionUnchanged, {
        unchanged: backupAfter === before.backupVersion,
      });
      await recordAssertion(secondary, recorded, assertions.originalKey.defaultKeyUnchanged, {
        unchanged: defaultAfter === before.defaultKey,
      });
      assertExactAssertions(recorded, this.expected);
    },
  },
  {
    id: 'secondary-settings-escape-hatch',
    source: `${RECOVERY_RESET_SOURCES.escapeHatch}; ${RECOVERY_RESET_SOURCES.helpers}; ${RECOVERY_RESET_SOURCES.app}; ${RECOVERY_RESET_SOURCES.account}`,
    expected: Object.values(assertions.escapeHatch),
    async run({ primary, secondary, fixtures, secrets, onAssertionCount }) {
      const recorded = createRecordedAssertions(onAssertionCount);
      const account = await fixtures.account('recovery-reset-escape-hatch');
      secrets[`${this.id}_PASSWORD`] = account.password;
      await establishRecovery(primary, fixtures, account, secrets, this.id);
      await deactivate(primary);

      await secondary.reset(DESKTOP_ACCOUNT_PROFILE);
      await secondary.login(account);
      await openSecuritySettings(secondary);
      const lost = await secondary.visible(
        '[data-testid="security-reset-recovery"]',
        { exactText: "I've lost my recovery key" },
        60_000,
      );
      const unlock = await secondary.visible(
        '[data-testid="security-unlock"]',
        { exactText: 'Enter recovery key' },
        60_000,
      );
      await recordAssertion(secondary, recorded, assertions.escapeHatch.lostKeyActionVisible, {
        visible: lost.visible,
      });
      await recordAssertion(secondary, recorded, assertions.escapeHatch.unlockActionVisible, {
        visible: unlock.visible,
      });
      const gate = await openResetGate(
        secondary,
        '[data-testid="security-reset-recovery"]',
      );
      await recordAssertion(secondary, recorded, assertions.escapeHatch.resetGateVisible, {
        visible: gate.visible,
      });
      assert(gate.text.includes('Type RESET to confirm'));
      await recordAssertion(secondary, recorded, assertions.escapeHatch.resetInstructionVisible, {
        exactInstruction: true,
      });
      await secondary.tapCurrent('[data-testid="alert-cancel"]');
      const owningReset = await secondary.visible(
        '[data-testid="reset-recovery"]',
        { exactText: "I've lost my recovery key" },
        30_000,
      );
      await recordAssertion(secondary, recorded, assertions.escapeHatch.owningResetActionVisible, {
        visible: owningReset.visible,
        pathname: new URL((await secondary.surface()).url).pathname,
      });
      assert.equal(
        new URL((await secondary.surface()).url).pathname,
        '/settings/security',
      );
      assertExactAssertions(recorded, this.expected);
    },
  },
];

assert.equal(cases.length, 4, 'Exactly four recovery-reset stages exist');
assert.equal(
  cases.reduce((count, entry) => count + entry.expected.length, 0),
  54,
  'Exactly 54 recovery-reset assertions are required',
);

void test(
  'Android recovery-reset journeys',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'recovery-reset',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const fixtures = createAccountFixtures(matrixResources, signal);
        matrixResources.cleanup('Scan recovery-reset diagnostics', () =>
          scanRecoveryResetArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact recovery-reset diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        matrixResources.cleanup('Remove recovery-key Maestro images', () =>
          removeRecoveryResetMaestroImages(output),
        );

        const stages: Array<{
          readonly id: string;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionCount: number;
          assertionCount: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 4,
                expectedAssertions: 54,
                attempt: 1,
                retries: 0,
                applications: [
                  PRIMARY_APPLICATION_ID,
                  SECONDARY_APPLICATION_ID,
                ],
                sources: RECOVERY_RESET_SOURCES,
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
        matrixResources.cleanup('Recovery-reset Android device', () =>
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
            expectedAssertionCount: entry.expected.length,
            assertionCount: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[recovery-reset] ${entry.id} start`);
          try {
            await primary.reset(DESKTOP_ACCOUNT_PROFILE);
            await entry.run({
              primary,
              secondary,
              fixtures,
              secrets,
              onAssertionCount: (count) => {
                stage.assertionCount = count;
              },
            });
            await captureSecretSafe(primary, 'passed-primary');
            await captureSecretSafe(secondary, 'passed-secondary');
          } catch (error) {
            failures.push(error);
            for (const [client, name] of [
              [primary, 'failed-primary'],
              [secondary, 'failed-secondary'],
            ] as const) {
              try {
                await captureSecretSafe(client, name);
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
                .map((error) => redactFailure(error, secrets))
                .join('\n');
            }
            try {
              await save();
            } catch (error) {
              failures.push(error);
            }
            console.info(
              `[recovery-reset] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Recovery-reset journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(
          stages.reduce((count, stage) => count + stage.assertionCount, 0),
          54,
        );
      },
    );
  },
);
