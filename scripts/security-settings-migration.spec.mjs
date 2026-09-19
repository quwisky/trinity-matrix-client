import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/trust/security-settings.spec.mts';
const navigationSource = 'e2e/support/journeys/navigation.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(
  root,
  'e2e/android/security-settings-contract.mts',
);
const journeyPath = resolve(root, 'e2e/android/security-settings-journeys.mts');

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const inheritedAssertionIds = [
  'security-settings.posture.rooms-account-qualified',
  'security-settings.posture.settings-navigation-visible',
  'security-settings.posture.settings-detail-non-empty',
  'security-settings.narrow.rooms-account-qualified',
  'security-settings.narrow.settings-navigation-visible',
  'security-settings.narrow.settings-detail-non-empty',
];

const directAssertionIds = [
  'security-settings.posture.root-visible',
  'security-settings.posture.session-visible',
  'security-settings.posture.backup-visible',
  'security-settings.posture.verify-visible',
  'security-settings.posture.setup-visible-and-route',
  'security-settings.narrow.verify-visible',
  'security-settings.narrow.verify-page-visible',
  'security-settings.narrow.verify-heading-focused',
  'security-settings.narrow.security-heading-focused',
];

const assertionIds = [...inheritedAssertionIds, ...directAssertionIds];

const forbiddenProductMutations = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
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
  lines.filter((line) => /\bexpect(?:\.poll)?(?:\(|\s*$)/u.test(line)).length;

function assertProtectedJourney(journey) {
  const required = [
    "id: 'fresh-posture-setup'",
    "id: 'narrow-verification-return'",
    'profile: DESKTOP_ACCOUNT_PROFILE',
    'profile: NARROW_SECURITY_PROFILE',
    'width: 700',
    'height: 760',
    'client.login(account)',
    'client.tapCurrent(\'[data-testid="open-settings"]\')',
    'client.tapCurrent(\'[data-testid="settings-nav-security"]\')',
    'client.tapCurrent(\'[data-testid="security-setup"]\')',
    'client.tapCurrent(\'[data-testid="security-verify"]\')',
    "client.tapCurrent('button', { exactText: 'Close' })",
    '\'[data-testid="security-settings"]\'',
    '\'[data-testid="security-session"]\'',
    '\'[data-testid="security-backup"]\'',
    "url.pathname === '/encryption/setup'",
    "url.searchParams.get('returnTo') === '/settings/security'",
    "url.pathname === '/encryption/verify'",
    "url.pathname === '/settings/security'",
    "exactText: 'Verify device'",
    "exactText: 'Security'",
    'new Set<SecuritySettingsAssertion>()',
    'assert(!recorded.has(identity)',
    'redactMaestroArtifacts(output, secrets)',
    "await client.capture('passed')",
    "await client.capture('failed')",
    'await client.close()',
    'device.close()',
    'throw new AggregateError(',
  ];
  for (const fragment of required) expect(journey).toContain(fragment);
  expect(journey).not.toContain('window.ng');
  expect(journey).not.toContain('getComponent(');
  expect(journey).not.toContain('isCrossSigningReady');
  expect(journey).not.toContain('synthetic private Trust response');
  expect(journey).not.toContain('matrix-http-fault');
}

describe('Android Security settings migration', () => {
  it('pins the two applicable paths and the browser-only fault exclusion', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '7da77f2e6b8d2091709ca6565bd54a08ed97115cce71e887ad1c46b6f5767fd9',
    );
    const navigation = sourceLines(
      navigationSource,
      '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[50]).toContain(
      "test('shows the encryption posture and launches recovery setup'",
    );
    expect(predecessor[83]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(50, 84))).toBe(5);
    expect(predecessor.slice(50, 84).join('\n')).toContain(
      '/\\/encryption\\/setup(\\?|$)/',
    );

    expect(predecessor[85]).toContain(
      "test('keeps verification nested in the narrow settings surface'",
    );
    expect(predecessor[94]).toContain('width: 700, height: 760');
    expect(predecessor[104]).toContain('if (isAndroidE2E)');
    expect(predecessor[120]).toBe('      return;');
    expect(assertionSiteCount(predecessor.slice(100, 121))).toBe(4);
    expect(predecessor.slice(104, 121).join('\n')).toContain(
      "url.pathname === '/encryption/verify'",
    );
    expect(predecessor.slice(104, 121).join('\n')).toContain(
      "url.pathname === '/settings/security'",
    );

    expect(predecessor[137]).toContain(
      "test('labels failed Trust reads and recovers through the scoped action'",
    );
    expect(predecessor[222]).toBe('  });');
    const fault = predecessor.slice(137, 223).join('\n');
    expect(fault).toContain(
      "process.env['TRINITY_E2E_PLATFORM'] === 'android'",
    );
    expect(fault).toContain(
      'fault injection requires Angular development hooks; the installed APK is production',
    );
    expect(fault).toContain('target.ng.getComponent(root)');
    expect(fault).toContain('synthetic private Trust response');

    expect(
      predecessor.filter((line) =>
        line.includes("openSettingsSection(page, 'security')"),
      ),
    ).toHaveLength(4);
    expect(navigation[10]).toContain(
      'export async function openSettingsFromRooms',
    );
    expect(navigation[47]).toContain(
      'export async function openSettingsSection',
    );
    expect(navigation[59]).toBe('}');
    const inherited = navigation.slice(10, 60).join('\n');
    expect(inherited).toContain("url.searchParams.has('account')");
    expect(inherited).toContain("name: 'Settings sections'");
    expect(inherited).toContain("page.getByTestId('settings-detail')");
  });

  it('exports exact source mappings and stable 6 + 9 identities', async () => {
    expect(
      existsSync(contractPath),
      'security-settings-contract.mts must exist',
    ).toBe(true);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.SECURITY_SETTINGS_SOURCES).toEqual({
      posture: `${predecessorSource}:51-84`,
      narrow: `${predecessorSource}:86-136`,
      androidNarrow: `${predecessorSource}:105-121`,
      excludedFault: `${predecessorSource}:138-223`,
      navigation: `${navigationSource}:11-60`,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.securitySettingsInheritedAssertions)).toEqual(
      inheritedAssertionIds,
    );
    expect(Object.values(contract.securitySettingsDirectAssertions)).toEqual(
      directAssertionIds,
    );
    expect(Object.values(contract.securitySettingsAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.securitySettingsAssertions)).size,
    ).toBe(15);
  });

  it('implements exactly two native stages through all 15 identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'security-settings-journeys.mts must exist').not.toBe('');
    assertProtectedJourney(journey);
    expect(journey).toContain('security-settings-contract.mts');
    expect(journey).toContain('SECURITY_SETTINGS_SOURCES.posture');
    expect(journey).toContain('SECURITY_SETTINGS_SOURCES.narrow');
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey).toContain(
      'expectedAssertions: Object.keys(assertions).length',
    );
    expect(journey).toContain('assert.equal(cases.length, 2');
    expect(journey).toMatch(
      /assert\.equal\(\s*Object\.keys\(assertions\)\.length,\s*15,/u,
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'postureRoomsAccountQualified',
      'postureSettingsNavigationVisible',
      'postureSettingsDetailNonEmpty',
      'narrowRoomsAccountQualified',
      'narrowSettingsNavigationVisible',
      'narrowSettingsDetailNonEmpty',
      'postureRootVisible',
      'postureSessionVisible',
      'postureBackupVisible',
      'postureVerifyVisible',
      'postureSetupVisibleAndRoute',
      'narrowVerifyVisible',
      'narrowVerifyPageVisible',
      'narrowVerifyHeadingFocused',
      'narrowSecurityHeadingFocused',
    ]) {
      expect(journey).toContain(`assertions.${key}`);
    }
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('keeps account setup, artifacts, redaction and teardown finite', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('createAccountFixtures(matrixResources, signal)');
    expect(journey).toContain("fixtures.account('security-posture')");
    expect(journey).toContain("fixtures.account('security-narrow')");
    expect(journey).toContain('secrets[account.userId] = account.password');
    expect(journey).toContain('withNodeTestResources(');
    expect(journey).toContain('20_000');
    expect(journey).toContain('30_000');
    expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
    expect(journey).not.toMatch(
      /observation:\s*(?:account\.password|password)/u,
    );
  });

  it('rejects posture, route, focus, exclusion, cleanup and redaction weakenings', () => {
    const journey = readIfPresent(journeyPath);
    if (!journey) return;
    assertProtectedJourney(journey);
    const mutations = [
      [
        '\'[data-testid="security-backup"]\'',
        '\'[data-testid="security-settings"]\'',
      ],
      [
        "url.pathname === '/encryption/setup'",
        "url.pathname.startsWith('/encryption')",
      ],
      [
        "url.pathname === '/encryption/verify'",
        "url.pathname.startsWith('/encryption')",
      ],
      ["exactText: 'Verify device'", "text: 'Verify'"],
      ["exactText: 'Security'", "text: 'Security'"],
      ['redactMaestroArtifacts(output, secrets)', 'Promise.resolve()'],
      ['await client.close()', 'Promise.resolve()'],
    ];
    for (const [before, after] of mutations) {
      expect(journey).toContain(before);
      expect(() =>
        assertProtectedJourney(journey.replace(before, after)),
      ).toThrow();
    }

    const predecessor = read(predecessorSource);
    const exclusion =
      "'fault injection requires Angular development hooks; the installed APK is production'";
    expect(predecessor).toContain(exclusion);
    expect(predecessor.replace(exclusion, "'runs on Android'")).not.toContain(
      exclusion,
    );
  });

  it('registers one bounded uncached Nx suite and package command', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['security-settings'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain(
      '--suite=android.security-settings',
    );
    expect(target.options.command).toContain('--timeout-ms=900000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/security-settings-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:security-settings']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:security-settings',
    );
  });

  it('registers the suite and started-only hosted artifact after OIDC', () => {
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.security-settings'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:security-settings'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:security-settings'",
    );
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/security-settings-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:security-settings'");
    expect(commands).toContain("suiteIds: ['android.security-settings']");
    expect(workflow).toContain('security-settings-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:security-settings',
    );
    expect(workflow.indexOf('oidc-login-started=true')).toBeLessThan(
      workflow.indexOf('security-settings-started=true'),
    );
    expect(workflow).toContain('surface: android-security-settings');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.security-settings/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.security-settings-started == 'true'/u,
    );
  });

  it('documents parity and keeps every predecessor enabled', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Security settings journeys');
    expect(migration).toContain('`android.security-settings`');
    expect(migration).toContain('five direct plus four direct');
    expect(migration).toContain('six inherited');
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain(
      "path: 'journeys/trust/security-settings.spec.mts'",
    );
    const predecessor = read(predecessorSource);
    for (const title of [
      'shows the encryption posture and launches recovery setup',
      'keeps verification nested in the narrow settings surface',
      'labels failed Trust reads and recovers through the scoped action',
    ]) {
      expect(predecessor).toContain(`test('${title}'`);
    }
  });
});
