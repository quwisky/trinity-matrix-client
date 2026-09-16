import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitionSource =
  'e2e/browser/journeys/accounts/change-password.spec.mts';
const navigationSource = 'e2e/support/journeys/navigation.mts';
const appSource = 'e2e/support/app.mts';
const contractPath = resolve(
  root,
  'e2e/android/account-password-change-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/account-password-change-journeys.mts',
);
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const inheritedAssertionIds = [
  'password-change.rooms-account-qualified',
  'password-change.settings-navigation-visible',
  'password-change.settings-detail-non-empty',
];
const directAssertionIds = [
  'password-change.form-ready',
  'password-change.wrong-current-feedback',
  'password-change.success-toast',
  'password-change.new-password-login-status',
  'password-change.old-password-login-status',
];
const assertionIds = [...inheritedAssertionIds, ...directAssertionIds];
const forbiddenProductMutations = [
  /\.click\s*\(/,
  /\.focus\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.(?:requestSubmit|submit)\s*\(/,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/,
  /\blocation\.(?:assign|replace|reload)\s*\(/,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/,
  /\bwindow\.open\s*\(/,
  /client\.(?:focusFixture|navigate|reload)\s*\(/,
];

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

describe('Android account password-change migration', () => {
  it('pins the exact predecessor and helper-owned assertion shape', () => {
    const definition = sourceLines(
      definitionSource,
      'bc3d99b6a65fd59bd5b0641d94768127692df14f757b7c787c982e466b47b98f',
    );
    const navigation = sourceLines(
      navigationSource,
      '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );

    expect(definition[41]).toContain('async function openAccountSection');
    expect(definition[46]).toBe('}');
    expect(definition[51]).toContain(
      "test('rejects a wrong current password, then changes it'",
    );
    expect(definition[93]).toBe('  });');
    expect(
      definition
        .slice(41, 94)
        .filter((line) => /\bexpect(?:\.poll)?(?:\(|\s*$)/.test(line)),
    ).toHaveLength(5);
    expect(
      definition.filter((line) => line.includes('openAccountSection(page)')),
    ).toHaveLength(1);
    expect(navigation[10]).toContain(
      'export async function openSettingsFromRooms',
    );
    expect(navigation[47]).toContain(
      'export async function openSettingsSection',
    );
    expect(navigation[59]).toBe('}');
    expect(navigation.join('\n')).toContain("url.searchParams.has('account')");
    expect(navigation.join('\n')).toContain("name: 'Settings sections'");
    expect(navigation.join('\n')).toContain(
      "page.getByTestId('settings-detail')",
    );
  });

  it('exports exact source mappings and stable 5+3 identities', async () => {
    expect(
      existsSync(contractPath),
      'account-password-change-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ACCOUNT_PASSWORD_CHANGE_SOURCES).toEqual({
      journey: `${definitionSource}:52-94`,
      formReady: `${definitionSource}:42-47`,
      navigation: `${navigationSource}:11-60`,
      app: appSource,
    });
    expect(
      Object.values(contract.accountPasswordChangeInheritedAssertions),
    ).toEqual(inheritedAssertionIds);
    expect(
      Object.values(contract.accountPasswordChangeDirectAssertions),
    ).toEqual(directAssertionIds);
    expect(Object.values(contract.accountPasswordChangeAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.accountPasswordChangeAssertions)).size,
    ).toBe(8);
  });

  it('implements one native stage through every identity without product DOM mutation', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'account-password-change-journeys.mts must exist').not.toBe(
      '',
    );
    expect(journey).toContain('account-password-change-contract.mts');
    expect(journey).toContain('ACCOUNT_PASSWORD_CHANGE_SOURCES.journey');
    expect(journey).toContain('profile: DESKTOP_ACCOUNT_PROFILE');
    expect(journey).toContain('client.login(account)');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="open-settings"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="settings-nav-account"]\')',
    );
    for (const selector of [
      '#current-password',
      '#new-password',
      '#confirm-password',
    ]) {
      expect(journey).toContain(`client.fill('${selector}'`);
    }
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="change-password"]\')',
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'roomsAccountQualified',
      'settingsNavigationVisible',
      'settingsDetailNonEmpty',
      'formReady',
      'wrongCurrentFeedback',
      'successToast',
      'newPasswordLoginStatus',
      'oldPasswordLoginStatus',
    ]) {
      expect(journey).toMatch(
        new RegExp(`recordAssertion\\([\\s\\S]*?assertions\\.${key}[,\\)]`),
      );
    }
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
    expect(journey).toContain(
      "elements[0]!.text.includes('current password is incorrect')",
    );
    expect(journey).toContain(
      "elements[0]!.text.includes('Password changed.')",
    );
    expect(journey).toContain('passwordFieldsMatch(client, expectedNewHash)');
    expect(journey).toContain(
      "assert.equal(retained.newPassword, true, 'New password remains exact')",
    );
    expect(journey).toContain(
      "assert.equal(retained.confirmation, true, 'Confirmation remains exact')",
    );
  });

  it('keeps credentials private and revokes successful observation sessions', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('status === 200');
    expect(journey).toContain('oldStatus === 403');
    expect(journey).toMatch(/\/_matrix\/client\/v3\/login/);
    expect(journey).toContain('`${SYNAPSE_HTTP}/_matrix/client/v3/logout`,');
    expect(journey).toMatch(/finally\s*\{/);
    expect(journey).toContain('AbortSignal.timeout(15_000)');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain('secrets.PASSWORD_OLD = account.password');
    expect(journey).toContain(
      'secrets.PASSWORD_NEW = `${account.password}-new`',
    );
    expect(journey).toContain(
      'secrets.PASSWORD_WRONG = `${account.password}-wrong`',
    );
    expect(journey).not.toMatch(
      /observation:\s*(?:oldPassword|newPassword|wrongPassword)/,
    );
  });

  it('registers one bounded uncached Nx suite and package command', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['account-password-change'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain(
      '--suite=android.account-password-change',
    );
    expect(target.options.command).toContain('--timeout-ms=900000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/account-password-change-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:account-password-change']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:account-password-change',
    );
  });

  it('registers the suite and started-only hosted artifact', () => {
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.account-password-change'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:account-password-change'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:account-password-change'",
    );
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/account-password-change-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:account-password-change'");
    expect(commands).toContain("suiteIds: ['android.account-password-change']");
    expect(workflow).toContain('account-password-change-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:account-password-change',
    );
    expect(workflow).toContain('surface: android-account-password-change');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.account-password-change/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.account-password-change-started == 'true'/,
    );
  });

  it('documents parity and keeps the exact predecessor enabled', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Account password-change journey');
    expect(migration).toContain('`android.account-password-change`');
    expect(migration).toContain('five direct plus three inherited');
    expect(migration).toMatch(/Do not\s+retire/);
    expect(catalog).toContain(
      "path: 'journeys/accounts/change-password.spec.mts'",
    );
    expect(read(definitionSource)).toContain(
      "test('rejects a wrong current password, then changes it'",
    );
  });
});
