import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/trust/recovery-reset.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(root, 'e2e/android/recovery-reset-contract.mts');
const journeyPath = resolve(root, 'e2e/android/recovery-reset-journeys.mts');
const accountClientPath = resolve(
  root,
  'e2e/android/account-workspace-client.mts',
);
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const replacementAssertions = [
  'recovery-reset.replacement.original-key-nonempty',
  'recovery-reset.replacement.default-key-before-nonempty',
  'recovery-reset.replacement.reset-action-visible',
  'recovery-reset.replacement.warning-gate-visible',
  'recovery-reset.replacement.backup-deletion-warning',
  'recovery-reset.replacement.four-consequence-lines',
  'recovery-reset.replacement.reset-word-instruction',
  'recovery-reset.replacement.wrong-word-gate-hidden',
  'recovery-reset.replacement.wrong-word-reset-reenabled',
  'recovery-reset.replacement.wrong-word-default-key-unchanged',
  'recovery-reset.replacement.wrong-word-feedback',
  'recovery-reset.replacement.confirmed-gate-visible',
  'recovery-reset.replacement.recovery-key-visible',
  'recovery-reset.replacement.replacement-key-nonempty',
  'recovery-reset.replacement.replacement-key-different',
  'recovery-reset.replacement.acknowledgement-disabled',
  'recovery-reset.replacement.acknowledgement-enabled',
  'recovery-reset.replacement.default-key-after-nonempty',
  'recovery-reset.replacement.default-key-changed',
  'recovery-reset.replacement.ready-security-copy',
  'recovery-reset.replacement.unlock-action-absent',
  'recovery-reset.replacement.setup-action-absent',
];

const cancelAssertions = [
  'recovery-reset.cancel.default-key-before-nonempty',
  'recovery-reset.cancel.backup-version-before-nonempty',
  'recovery-reset.cancel.reset-action-visible',
  'recovery-reset.cancel.reset-gate-visible',
  'recovery-reset.cancel.password-gate-visible',
  'recovery-reset.cancel.recovery-key-absent',
  'recovery-reset.cancel.reset-action-reenabled',
  'recovery-reset.cancel.backup-version-unchanged',
  'recovery-reset.cancel.default-key-unchanged',
  'recovery-reset.cancel.ready-security-copy',
  'recovery-reset.cancel.unlock-action-absent',
  'recovery-reset.cancel.setup-action-absent',
];

const originalKeyAssertions = [
  'recovery-reset.original-key.original-key-nonempty',
  'recovery-reset.original-key.default-key-before-nonempty',
  'recovery-reset.original-key.backup-version-before-nonempty',
  'recovery-reset.original-key.master-key-before-nonempty',
  'recovery-reset.original-key.reset-action-visible',
  'recovery-reset.original-key.reset-gate-visible',
  'recovery-reset.original-key.password-gate-visible',
  'recovery-reset.original-key.reset-action-reenabled',
  'recovery-reset.original-key.unlock-error-absent',
  'recovery-reset.original-key.ready-security-copy',
  'recovery-reset.original-key.unlock-action-absent',
  'recovery-reset.original-key.setup-action-absent',
  'recovery-reset.original-key.master-key-unchanged',
  'recovery-reset.original-key.backup-version-unchanged',
  'recovery-reset.original-key.default-key-unchanged',
];

const escapeHatchAssertions = [
  'recovery-reset.escape-hatch.lost-key-action-visible',
  'recovery-reset.escape-hatch.unlock-action-visible',
  'recovery-reset.escape-hatch.reset-gate-visible',
  'recovery-reset.escape-hatch.reset-instruction-visible',
  'recovery-reset.escape-hatch.owning-reset-action-visible',
];

const assertionIds = [
  ...replacementAssertions,
  ...cancelAssertions,
  ...originalKeyAssertions,
  ...escapeHatchAssertions,
];

const forbiddenRendererActions = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
  /\.fill\s*\(/u,
  /\.dispatchEvent\s*\(/u,
  /\.(?:requestSubmit|submit)\s*\(/u,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/u,
  /\blocation\.(?:assign|replace|reload)\s*\(/u,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/u,
  /\bwindow\.open\s*\(/u,
  /client\.(?:focusFixture|navigate|reload)\s*\(/u,
];

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

const assertionSiteCount = (lines) =>
  lines.filter(
    (line) =>
      !line.trimStart().startsWith('//') &&
      /\bexpect(?:\.poll)?(?:\(|\s*$)/u.test(line),
  ).length;

const occurrences = (source, fragment) => source.split(fragment).length - 1;

function assertProtectedRuntimeContract(journey) {
  const required = [
    "id: 'replacement-key-reset'",
    "id: 'password-cancel-atomicity'",
    "id: 'original-key-after-cancel'",
    "id: 'secondary-settings-escape-hatch'",
    "const PRIMARY_APPLICATION_ID = 'eu.qwky.trinity'",
    "const SECONDARY_APPLICATION_ID = 'eu.qwky.trinity.secondary'",
    'new AccountWorkspaceClient(',
    'SECONDARY_APPLICATION_ID',
    'await establishRecovery(',
    'await enterSecondaryRecovery(',
    'await answerPasswordUiaIfAsked(',
    'await openResetGate(',
    'await assertReadySecurity(',
    'fixtures.defaultKeyId(account)',
    'fixtures.keyBackupVersion(account)',
    'fixtures.masterKey(account)',
    "exactText: 'I've lost my recovery key'",
    "exactText: 'Enter recovery key'",
    "exactText: 'Reset encryption'",
    "exactText: 'Confirm your password'",
    "client.fillFocused('trn-alert-dialog input', 'yes please')",
    "client.fillFocused('trn-alert-dialog input', 'RESET')",
    'client.fillFocused(\'[data-testid="recovery-key-input"]\', originalKey)',
    'replacementKey.length > 0',
    'assert.notEqual(replacementKey, originalKey)',
    "spelledOut.split('\\n').filter((line) => line.trim().length > 0)",
    "includes('Type RESET to confirm')",
    'new Set<RecoveryResetAssertion>()',
    'assert(!recorded.has(identity)',
    'expectedStages: 4',
    'expectedAssertions: 54',
    'captureSecretSafe(',
    'redactMaestroArtifacts(output, secrets)',
    'scanRecoveryResetArtifacts(output, secrets)',
    'await primary.close()',
    'await secondary.close()',
    'device.close()',
    'throw new AggregateError(',
  ];
  for (const fragment of required) expect(journey).toContain(fragment);
  expect(occurrences(journey, 'expectedAssertions: 54')).toBe(1);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /observation:\s*(?:originalKey|replacementKey|password|accessToken|token|uia)/u,
  );
  expect(journey).not.toMatch(
    /mock(?:CrossSigning|SecretStorage|KeyBackup|Trust)/u,
  );
}

describe('Android recovery-reset migration', () => {
  it('pins the helpers, four exact predecessor spans and 22 + 12 + 15 + 5 assertion shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      'fad6cee0f80c92770978a672129c66a1ab22c9a7504a1068970673cbca08b848',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[26]).toContain('Answer the device-signing UIA prompt');
    expect(predecessor[27]).toContain('async function answerUiaIfAsked');
    expect(predecessor[58]).toContain('async function setUpEncryption');
    expect(predecessor[73]).toBe('}');
    const helpers = predecessor.slice(26, 74).join('\n');
    expect(helpers).toContain("hasText: 'Confirm your password'");
    expect(helpers).toContain("name: 'Set up encryption'");
    expect(helpers).toContain("getByTestId('recovery-key')");
    expect(helpers).toContain("name: /I've saved my recovery key/");
    expect(helpers).toContain("name: 'Continue to Trinity'");
    expect(helpers).toContain('await waitForRooms(page)');

    expect(predecessor[78]).toContain(
      "test('mints a new recovery key for someone who lost theirs'",
    );
    expect(predecessor[179]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(78, 180))).toBe(22);

    expect(predecessor[181]).toContain(
      "test('a cancelled password costs the account nothing'",
    );
    expect(predecessor[241]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(181, 242))).toBe(12);

    expect(predecessor[243]).toContain(
      "test('leaves the original recovery key working after a cancelled reset'",
    );
    expect(predecessor[312]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(243, 313))).toBe(15);

    expect(predecessor[314]).toContain(
      "test('Settings offers the escape hatch to someone who cannot unlock'",
    );
    expect(predecessor[361]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(314, 362))).toBe(5);

    const source = predecessor.join('\n');
    expect(occurrences(source, 'await setUpEncryption(page, pass)')).toBe(4);
    expect(occurrences(source, 'await answerUiaIfAsked(')).toBe(2);
    expect(occurrences(source, 'await waitForRooms(page')).toBe(2);
    expect(app.join('\n')).toContain('export async function login(');
    expect(app.join('\n')).toContain('export async function waitForRooms(');
    expect(account.join('\n')).toContain('export async function defaultKeyId(');
    expect(account.join('\n')).toContain(
      'export async function keyBackupVersion(',
    );
    expect(account.join('\n')).toContain('export async function masterKey(');
  });

  it('exports the exact source map and all 54 unique direct identities', async () => {
    expect(contractPath, 'recovery-reset-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.RECOVERY_RESET_SOURCES).toEqual({
      helpers: `${predecessorSource}:27-74`,
      replacement: `${predecessorSource}:79-180`,
      cancel: `${predecessorSource}:182-242`,
      originalKey: `${predecessorSource}:244-313`,
      escapeHatch: `${predecessorSource}:315-362`,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.recoveryResetAssertions.replacement)).toEqual(
      replacementAssertions,
    );
    expect(Object.values(contract.recoveryResetAssertions.cancel)).toEqual(
      cancelAssertions,
    );
    expect(Object.values(contract.recoveryResetAssertions.originalKey)).toEqual(
      originalKeyAssertions,
    );
    expect(Object.values(contract.recoveryResetAssertions.escapeHatch)).toEqual(
      escapeHatchAssertions,
    );
    const actual = Object.values(contract.recoveryResetAssertions).flatMap(
      Object.values,
    );
    expect(actual).toEqual(assertionIds);
    expect(new Set(actual).size).toBe(54);
  });

  it('makes every Account workspace native action package-aware', () => {
    const client = readIfPresent(accountClientPath);
    expect(client).toContain('NativeShellApplicationId');
    expect(client).toContain(
      "applicationId: NativeShellApplicationId = 'eu.qwky.trinity'",
    );
    expect(client).toContain(
      'readonly applicationId: NativeShellApplicationId',
    );
    expect(client).toContain('this.applicationId = applicationId');
    expect(occurrences(client, "'eu.qwky.trinity'"), client).toBe(1);
    expect(occurrences(client, 'this.applicationId')).toBeGreaterThanOrEqual(
      10,
    );
    for (const pattern of [
      /'pm',\s*'clear',\s*this\.applicationId/u,
      /'pm',\s*'grant',\s*this\.applicationId/u,
      /'am',\s*'force-stop',\s*this\.applicationId/u,
      /startNativeShellClient\(\s*this\.device,\s*this\.applicationId,/u,
    ]) {
      expect(client).toMatch(pattern);
    }
    expect(client).toContain('APP_ID: this.applicationId');
    expect(client).toContain('`appId: ${this.applicationId}');
  });

  it('keeps crypto observations bounded and access tokens closure-private', () => {
    const fixture = readIfPresent(fixturePath);
    expect(fixture).toContain('defaultKeyId(');
    expect(fixture).toContain('keyBackupVersion(');
    expect(fixture).toContain('masterKey(');
    expect(fixture).toContain('m.secret_storage.default_key');
    expect(fixture).toContain('/room_keys/version');
    expect(fixture).toContain("'/keys/query'");
    expect(fixture).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');
    expect(fixture).not.toMatch(/return\s+access\(/u);
    expect(fixture).not.toMatch(/accessToken/u);
  });

  it('implements four native two-package stages through exactly 54 identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'recovery-reset-journeys.mts must exist').not.toBe('');
    assertProtectedRuntimeContract(journey);
    expect(journey).toContain('recovery-reset-contract.mts');
    expect(journey).toContain('RECOVERY_RESET_SOURCES.helpers');
    expect(journey).toContain('RECOVERY_RESET_SOURCES.replacement');
    expect(journey).toContain('RECOVERY_RESET_SOURCES.cancel');
    expect(journey).toContain('RECOVERY_RESET_SOURCES.originalKey');
    expect(journey).toContain('RECOVERY_RESET_SOURCES.escapeHatch');
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const group of [
      'replacement',
      'cancel',
      'originalKey',
      'escapeHatch',
    ]) {
      expect(journey).toContain(`assertions.${group}.`);
    }
    for (const mutation of forbiddenRendererActions) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('rejects warning, atomicity, key, escape-hatch, cleanup and redaction weakenings', () => {
    const journey = readIfPresent(journeyPath);
    if (!journey) return;
    assertProtectedRuntimeContract(journey);
    const mutations = [
      [
        "spelledOut.split('\\n').filter((line) => line.trim().length > 0)",
        '[spelledOut]',
      ],
      ["includes('Type RESET to confirm')", "includes('RESET')"],
      [
        "client.fillFocused('trn-alert-dialog input', 'yes please')",
        "client.fillFocused('trn-alert-dialog input', 'RESET')",
      ],
      ['replacementKey.length > 0', 'replacementKey.length >= 0'],
      [
        'assert.notEqual(replacementKey, originalKey)',
        'assert.equal(replacementKey, replacementKey)',
      ],
      [
        'client.fillFocused(\'[data-testid="recovery-key-input"]\', originalKey)',
        'Promise.resolve()',
      ],
      ["exactText: 'I've lost my recovery key'", "text: 'lost'"],
      ['redactMaestroArtifacts(output, secrets)', 'Promise.resolve()'],
      ['scanRecoveryResetArtifacts(output, secrets)', 'Promise.resolve()'],
      ['await secondary.close()', 'Promise.resolve()'],
    ];
    for (const [before, after] of mutations) {
      expect(journey).toContain(before);
      expect(() =>
        assertProtectedRuntimeContract(journey.replace(before, after)),
      ).toThrow();
    }
  });

  it('registers one bounded uncached two-APK Nx suite and package command', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['recovery-reset'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [
        { projects: ['trinity-android'], target: 'build-prebuilt' },
        {
          projects: ['trinity-android'],
          target: 'build-secondary-prebuilt',
        },
      ],
    });
    expect(target.options.command).toContain('--suite=android.recovery-reset');
    expect(target.options.command).toContain('--timeout-ms=1800000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/recovery-reset-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:recovery-reset']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:recovery-reset',
    );
  });

  it('registers the suite and started-only hosted artifact after Security settings', () => {
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.recovery-reset'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:recovery-reset'",
    );
    expect(runners).toContain("canonicalScript: 'e2e:android:recovery-reset'");
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/recovery-reset-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:recovery-reset'");
    expect(commands).toContain("suiteIds: ['android.recovery-reset']");
    expect(workflow).toContain('recovery-reset-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:recovery-reset',
    );
    expect(workflow.indexOf('security-settings-started=true')).toBeLessThan(
      workflow.indexOf('recovery-reset-started=true'),
    );
    expect(workflow).toContain('surface: android-recovery-reset');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.recovery-reset/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.recovery-reset-started == 'true'/u,
    );
  });

  it('documents parity and keeps every predecessor enabled', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Recovery-reset journeys');
    expect(migration).toContain('`android.recovery-reset`');
    expect(migration).toContain('22 + 12 + 15 + 5');
    expect(migration).toContain('primary and secondary installed packages');
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain("path: 'journeys/trust/recovery-reset.spec.mts'");
    const predecessor = read(predecessorSource);
    for (const title of [
      'mints a new recovery key for someone who lost theirs',
      'a cancelled password costs the account nothing',
      'leaves the original recovery key working after a cancelled reset',
      'Settings offers the escape hatch to someone who cannot unlock',
    ]) {
      expect(predecessor).toContain(`test('${title}'`);
    }
  });
});
