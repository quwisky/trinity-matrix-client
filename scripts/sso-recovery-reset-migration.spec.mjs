import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/trust/sso-recovery-reset.spec.mts';
const accountSource = 'e2e/support/account.mts';
const ssoHelperSource = 'e2e/browser/support/sso.mts';
const appSource = 'e2e/support/app.mts';
const dexSource = 'e2e/support/synapse/dex.yaml';
const contractPath = resolve(
  root,
  'e2e/android/sso-recovery-reset-contract.mts',
);
const fixturePath = resolve(root, 'e2e/android/sso-recovery-reset-fixture.mts');
const journeyPath = resolve(
  root,
  'e2e/android/sso-recovery-reset-journeys.mts',
);

const assertionIds = [
  'sso-recovery-reset.master-key-before-nonempty',
  'sso-recovery-reset.backup-version-before-nonempty',
  'sso-recovery-reset.reset-action-visible',
  'sso-recovery-reset.reset-gate-visible',
  'sso-recovery-reset.identity-provider-refusal-copy',
  'sso-recovery-reset.recovery-key-absent',
  'sso-recovery-reset.password-prompt-absent',
  'sso-recovery-reset.master-key-unchanged',
  'sso-recovery-reset.backup-version-unchanged',
];

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

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

function assertProtectedRuntimeContract(journey) {
  const required = [
    "const TRINITY_PACKAGE = 'eu.qwky.trinity'",
    'session.synapse.ssoReset',
    'openLegacySsoProvider(',
    'openSsoApiSession(',
    'ensureSsoRecoveryState(',
    'readSsoRecoveryState(',
    "exactText: 'Continue with SSO'",
    "exactText: 'Enter recovery key'",
    'exactText: "I\'ve lost my recovery key"',
    "exactText: 'Reset encryption'",
    "client.fillFocused('trn-alert-dialog input', 'RESET')",
    "'Your identity provider has to reset encryption for this account'",
    'client.expectCount(\'[data-testid="recovery-key"]\', 0)',
    "client.expectCount('body *', 0, {",
    "exactText: 'Confirm your password'",
    'assert(before.masterKey.length > 0)',
    'assert(before.backupVersion.length > 0)',
    'assert.equal(after.masterKey, before.masterKey)',
    'after.backupVersion === before.backupVersion',
    "'SSO recovery key-backup version is unchanged'",
    'expectedStages: 1',
    'expectedAssertions: 9',
    'new Set<SsoRecoveryResetAssertion>()',
    'assert(!recorded.has(identity)',
    'assertionCountObservers.get(recorded)?.(recorded.size)',
    'stage.assertionCount = count',
    'captureSecretSafe(',
    'removeSsoRecoveryResetMaestroImages(output)',
    'redactMaestroArtifacts(output, secrets)',
    'scanSsoRecoveryResetArtifacts(output, secrets)',
    'await provider.close()',
    'await closeSsoApiSession(',
    'await client.close()',
    'await device.clearApplicationData(TRINITY_PACKAGE)',
    'device.close()',
    'throw new AggregateError(',
  ];
  for (const fragment of required) expect(journey).toContain(fragment);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /observation:\s*(?:loginToken|accessToken|password|email|masterKey|backupVersion)/u,
  );
  expect(journey).not.toContain('secrets.BACKUP_VERSION_SECRET');
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|navigate|reload)\s*\(|evaluateNative\([\s\S]*?\.(?:click|focus|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toMatch(/mock(?:CrossSigning|KeyBackup|Trust|Sso)/u);
}

describe('Android SSO recovery-reset migration', () => {
  it('pins the exact predecessor, dedicated account guard, helper and nine assertions', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '4d4a15f2518a40a1845dfa965d03757697be9d9613030d757b2c74004441ed0b',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );
    const sso = sourceLines(
      ssoHelperSource,
      'e669c3b588e788c37fab77a7e427a38286de46cffafb228fcf27ae32c70a99b3',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const dex = sourceLines(
      dexSource,
      'b994b7e7c7de5fc103079b82d379a3dd8d022a1468796d6f8f35628c55c585d5',
    );

    expect(predecessor[33]).toContain(
      "test.describe('Recovery reset on an SSO account'",
    );
    expect(predecessor[40]).toContain('session.available && !session.ssoReset');
    expect(predecessor[47]).toContain(
      "test('refuses the reset and points at the identity provider'",
    );
    expect(predecessor[106]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(47, 107))).toBe(9);
    expect(predecessor[109]).toContain('/**');
    expect(predecessor[117]).toContain('async function ensureKeyBackup');
    expect(predecessor[139]).toBe('}');

    const owned = predecessor.slice(47, 107).join('\n');
    expect(owned).toContain('session.ssoReset as SsoAccount');
    expect(owned).toContain('await ensureCrossSigning(');
    expect(owned).toContain('await ensureKeyBackup(');
    expect(owned).toContain(
      'Your identity provider has to reset encryption for this account',
    );
    expect(owned).toContain("getByText('Confirm your password')");
    expect(owned).toContain('await masterKey(');
    expect(owned).toContain('await keyBackupVersion(');
    expect(account.join('\n')).toContain('export async function masterKey(');
    expect(account.join('\n')).toContain(
      'export async function keyBackupVersion(',
    );
    expect(sso.join('\n')).toContain('export async function ssoApiSession(');
    expect(sso.join('\n')).toContain(
      'export async function ensureCrossSigning(',
    );
    expect(app.join('\n')).toContain('ssoReset?: SsoAccount');
    expect(dex.join('\n')).toContain('email: sso-reset-e2e@trinity.test');
  });

  it('exports the exact source map and all nine unique identities', async () => {
    expect(
      contractPath,
      'sso-recovery-reset-contract.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.SSO_RECOVERY_RESET_SOURCES).toEqual({
      availability: `${predecessorSource}:34-46`,
      refusal: `${predecessorSource}:48-107`,
      keyBackup: `${predecessorSource}:110-140`,
      account: accountSource,
      ssoHelper: ssoHelperSource,
      app: appSource,
      dex: dexSource,
    });
    expect(Object.values(contract.ssoRecoveryResetAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.ssoRecoveryResetAssertions)).size,
    ).toBe(9);
  });

  it('uses the dedicated SSO identity and real finite server setup', () => {
    const fixture = readIfPresent(fixturePath);
    expect(fixture, 'sso-recovery-reset-fixture.mts must exist').not.toBe('');
    expect(fixture).toContain('chromium.launch(');
    expect(fixture).toContain("locator('#login')");
    expect(fixture).toContain("locator('#password')");
    expect(fixture).toContain("locator('#submit-login')");
    expect(fixture).toContain("type: 'm.login.token'");
    expect(fixture).toContain('/keys/device_signing/upload');
    expect(fixture).toContain('/room_keys/version');
    expect(fixture).toContain('/keys/query');
    expect(fixture).toContain('/account_data/m.secret_storage.default_key');
    expect(fixture).toContain('/logout');
    expect(fixture).toContain('AbortSignal.timeout(15_000)');
    expect(fixture).toContain('AbortSignal.timeout(60_000)');
    expect(fixture).toContain('await context?.close()');
    expect(fixture).toContain('await browser?.close()');
    expect(fixture).not.toMatch(/session\.synapse\.sso(?!Reset)/u);
  });

  it('implements one native refusal stage with exact atomic observations', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'sso-recovery-reset-journeys.mts must exist').not.toBe('');
    assertProtectedRuntimeContract(journey);
    expect(journey).toContain("id: 'sso-recovery-reset-refusal'");
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toContain("client.focusCurrent('#homeserver')");
    expect(journey).toContain("client.fillFocused('#homeserver', homeserver)");
    expect(journey).toContain(
      "client.tapCurrent('button', { exactText: 'Continue' })",
    );
    expect(journey).toContain('provider.completeDexSignIn(');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="open-settings"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="settings-nav-security"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="security-unlock"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="reset-recovery"]\')',
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('rejects refusal, absence, atomicity, cleanup and redaction weakenings', () => {
    const journey = readIfPresent(journeyPath);
    expect(() => assertProtectedRuntimeContract(journey)).not.toThrow();
    const mutations = [
      [
        "'Your identity provider has to reset encryption for this account'",
        "'Your identity provider rejected the request'",
      ],
      [
        'client.expectCount(\'[data-testid="recovery-key"]\', 0)',
        'client.expectCount(\'[data-testid="recovery-key"]\', 1)',
      ],
      [
        "client.expectCount('body *', 0, {",
        "client.expectCount('body *', 1, {",
      ],
      [
        'assert(before.masterKey.length > 0)',
        'assert(before.masterKey.length >= 0)',
      ],
      [
        'assert(before.backupVersion.length > 0)',
        'assert(before.backupVersion.length >= 0)',
      ],
      [
        'assert.equal(after.masterKey, before.masterKey)',
        'assert.equal(after.masterKey, after.masterKey)',
      ],
      [
        'after.backupVersion === before.backupVersion',
        'after.backupVersion === after.backupVersion',
      ],
      ['await provider.close()', 'await Promise.resolve()'],
      ['await closeSsoApiSession(', 'await forgetSsoApiSession('],
      ['removeSsoRecoveryResetMaestroImages(output)', 'Promise.resolve()'],
      ['redactMaestroArtifacts(output, secrets)', 'Promise.resolve()'],
      ['scanSsoRecoveryResetArtifacts(output, secrets)', 'Promise.resolve()'],
    ];
    for (const [before, after] of mutations) {
      expect(journey).toContain(before);
      expect(() =>
        assertProtectedRuntimeContract(journey.replace(before, after)),
      ).toThrow();
    }
  });

  it('registers one bounded uncached Chrome/Maestro suite before native shell', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['sso-recovery-reset'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain(
      '--suite=android.sso-recovery-reset',
    );
    expect(target.options.command).toContain('--timeout-ms=1200000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/sso-recovery-reset-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:sso-recovery-reset']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:sso-recovery-reset',
    );

    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.sso-recovery-reset'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:sso-recovery-reset'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:sso-recovery-reset'",
    );
    expect(runners).toContain("'chrome'");
    expect(runners).toContain("'maestro'");
    expect(commands).toContain("name: 'e2e:android:sso-recovery-reset'");
    expect(commands).toContain("suiteIds: ['android.sso-recovery-reset']");
    expect(workflow).toContain('sso-recovery-reset-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:sso-recovery-reset',
    );
    expect(workflow).toContain('surface: android-sso-recovery-reset');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.sso-recovery-reset/**',
    );
    expect(workflow.indexOf('legacy-sso-started=true')).toBeLessThan(
      workflow.indexOf('sso-recovery-reset-started=true'),
    );
    expect(workflow.indexOf('sso-recovery-reset-started=true')).toBeLessThan(
      workflow.indexOf('native-shell-started=true'),
    );
  });

  it('documents parity and retains the exact predecessor', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## SSO recovery-reset refusal journey');
    expect(migration).toContain('`android.sso-recovery-reset`');
    expect(migration).toContain(
      '4d4a15f2518a40a1845dfa965d03757697be9d9613030d757b2c74004441ed0b',
    );
    expect(migration).toContain('nine direct assertion identities');
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain(
      "path: 'journeys/trust/sso-recovery-reset.spec.mts'",
    );
    expect(read(predecessorSource)).toContain(
      "test('refuses the reset and points at the identity provider'",
    );
  });
});
