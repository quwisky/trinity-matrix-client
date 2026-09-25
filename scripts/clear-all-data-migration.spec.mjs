import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/accounts/clear-all-data.spec.mts';
const appSource = 'e2e/support/app.mts';
const contrastSource = 'e2e/browser/support/contrast.mts';
const contractPath = resolve(root, 'e2e/android/clear-all-data-contract.mts');
const observerPath = resolve(root, 'e2e/android/clear-all-data-observer.mts');
const journeyPath = resolve(root, 'e2e/android/clear-all-data-journeys.mts');
const accountClientPath = resolve(
  root,
  'e2e/android/account-workspace-client.mts',
);
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const functionalAssertionIds = [
  'clear-all-data.signed-in.secure-token-webview-exclusion',
  'clear-all-data.signed-in.native-account-preference-present',
  'clear-all-data.signed-in.sync-database-present',
  'clear-all-data.signed-in.crypto-database-present',
  'clear-all-data.signed-in.escape-hatch-visible',
  'clear-all-data.signed-in.mistype-feedback',
  'clear-all-data.signed-in.mistype-preserves-state',
  'clear-all-data.signed-in.native-preferences-empty',
  'clear-all-data.signed-in.database-enumeration-ready',
  'clear-all-data.signed-in.databases-removed',
  'clear-all-data.signed-in.signed-out-surface-visible',
  'clear-all-data.signed-out.dead-push-preference-present',
  'clear-all-data.signed-out.native-preferences-empty',
];
const visualAssertionIds = ['trinity', 'amethyst'].flatMap((theme) =>
  ['light', 'dark'].flatMap((mode) =>
    ['applied', 'danger-token', 'aa-contrast'].map(
      (check) => `clear-all-data.visual.${theme}.${mode}.${check}`,
    ),
  ),
);
const assertionIds = [...functionalAssertionIds, ...visualAssertionIds];
const forbiddenObserverMutations = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
  /\.dispatchEvent\s*\(/u,
  /\.(?:requestSubmit|submit)\s*\(/u,
  /\blocalStorage\b/u,
  /\bPage\.(?:navigate|reload)\b/u,
  /\blocation\.(?:assign|replace|reload)\s*\(/u,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/u,
  /\bwindow\.open\s*\(/u,
];
const forbiddenJourneyMutations = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
  /\.dispatchEvent\s*\(/u,
  /\.(?:requestSubmit|submit)\s*\(/u,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/u,
  /\blocation\.(?:assign|replace|reload)\s*\(/u,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/u,
  /\bwindow\.open\s*\(/u,
  /client\.(?:focusFixture|navigate)\s*\(/u,
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

describe('Android clear-all-data migration', () => {
  it('pins the exact predecessor and helper-owned assertion shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '271c63f2e49f27d7c99d4d0d75c7b844d466d70afe69afda71d1335bcc0b1e9c',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      contrastSource,
      '5c5561a7cd599679a95735fe82cbe14b95faf93c359f3f4ef7e85aa386b2b7f3',
    );

    expect(predecessor[36]).toContain('Every CapacitorStorage-namespaced key');
    expect(predecessor[79]).toBe('}');
    expect(predecessor[84]).toContain(
      "test('erases a signed-in install and restarts into an empty app'",
    );
    expect(predecessor[150]).toBe('  });');
    expect(predecessor[152]).toContain(
      "test('erases a signed-out install whose settings are wedged'",
    );
    expect(predecessor[175]).toBe('  });');
    expect(predecessor[192]).toContain('const THEMES = [');
    expect(predecessor[252]).toBe('  });');

    expect(assertionSiteCount(predecessor.slice(84, 151))).toBe(10);
    expect(assertionSiteCount(predecessor.slice(152, 176))).toBe(1);
    expect(assertionSiteCount(predecessor.slice(192, 253))).toBe(3);
    expect(
      predecessor.filter((line) =>
        line.includes('await waitForEmptyStorage(page)'),
      ),
    ).toHaveLength(2);
    expect(predecessor.join('\n')).toContain(
      "for (const scheme of ['light', 'dark'] as const)",
    );
    expect(predecessor.join('\n')).toContain('for (const theme of THEMES)');
    expect(assertionSiteCount(predecessor.slice(84, 253))).toBe(14);
  });

  it('exports exact source mappings, 25 identities and hover exclusion', async () => {
    expect(
      existsSync(contractPath),
      'clear-all-data-contract.mts must exist',
    ).toBe(true);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.CLEAR_ALL_DATA_SOURCES).toEqual({
      helpers: `${predecessorSource}:37-80`,
      signedIn: `${predecessorSource}:85-151`,
      signedOut: `${predecessorSource}:153-176`,
      visual: `${predecessorSource}:193-253`,
      app: appSource,
      contrast: contrastSource,
    });
    expect(Object.values(contract.clearAllDataFunctionalAssertions)).toEqual(
      functionalAssertionIds,
    );
    expect(Object.values(contract.clearAllDataVisualAssertions)).toEqual(
      visualAssertionIds,
    );
    expect(Object.values(contract.clearAllDataAssertions)).toEqual(
      assertionIds,
    );
    expect(new Set(assertionIds).size).toBe(25);
    expect(contract.CLEAR_ALL_DATA_HOVER_EXCLUSION).toEqual({
      source: `${predecessorSource}:230-249`,
      platform: 'android',
      media: { hover: 'none', pointer: 'coarse' },
      retainedOwner: predecessorSource,
      reason:
        'Installed Android touch has no supported persistent native hover path; touch is not hover.',
    });
  });

  it('requires the observer and journey implementation seams', () => {
    expect(
      readIfPresent(observerPath),
      'clear-all-data-observer.mts must exist',
    ).not.toBe('');
    expect(
      readIfPresent(journeyPath),
      'clear-all-data-journeys.mts must exist',
    ).not.toBe('');
  });

  it('keeps setup and observation authoritative, finite and action-free', () => {
    const observer = readIfPresent(observerPath);
    expect(observer, 'clear-all-data-observer.mts must exist').not.toBe('');
    expect(observer).toContain('run-as');
    expect(observer).toContain("'eu.qwky.trinity'");
    expect(observer).toContain("'shared_prefs/CapacitorStorage.xml'");
    expect(observer).toMatch(
      /device\.adb\(\s*'shell',\s*`run-as \$\{APPLICATION_ID\} cat \$\{PREFERENCE_FILE\} 2>\/dev\/null \|\| true`,\s*\)/u,
    );
    expect(observer).not.toMatch(
      /device\.adb\(\s*'shell',\s*'run-as',\s*APPLICATION_ID,\s*'sh',\s*'-c'/u,
    );
    expect(observer).toContain('indexedDB.databases()');
    expect(observer).toContain('Capacitor?.Plugins?.Preferences');
    expect(observer).toContain(
      'preferences.set({ key: preferenceKey, value })',
    );
    expect(observer).toContain("matchMedia('(hover: none)').matches");
    expect(observer).toContain("matchMedia('(pointer: coarse)').matches");
    expect(observer).toContain(
      "getContext('2d', { willReadFrequently: true })",
    );
    expect(observer).toContain('0.2126 * channel(r)');
    expect(observer).toContain('AA_NORMAL_TEXT = 4.5');
    expect(observer).toContain('waitForNativeShellState');
    for (const mutation of forbiddenObserverMutations) {
      expect(observer).not.toMatch(mutation);
    }
  });

  it('parses authoritative Android preference keys without values', async () => {
    expect(existsSync(observerPath)).toBe(true);
    if (!existsSync(observerPath)) return;
    const observer = await import(observerPath);
    expect(
      observer.parseNativePreferenceKeys(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <string name="trinity.push.gateway">https://secret.example</string>
  <string name="matrix.accounts">{&quot;activeUserId&quot;:&quot;@alice:localhost&quot;}</string>
</map>`),
    ).toEqual(['matrix.accounts', 'trinity.push.gateway']);
  });

  it('implements six native stages through every identity', () => {
    const journey = readIfPresent(journeyPath);
    const accountClient = readIfPresent(accountClientPath);
    expect(journey, 'clear-all-data-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('clear-all-data-contract.mts');
    expect(journey).toContain('clear-all-data-observer.mts');
    expect(journey).toContain('CLEAR_ALL_DATA_SOURCES.signedIn');
    expect(journey).toContain('CLEAR_ALL_DATA_SOURCES.signedOut');
    expect(journey).toContain('CLEAR_ALL_DATA_SOURCES.visual');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toContain('client.login(account)');
    expect(journey).toContain('client.openMenu()');
    expect(journey).toContain('client.tap(\'[data-testid="add-account"]\')');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="clear-all-data"]\')',
    );
    expect(journey).toContain(
      "client.fillFocused('trn-alert-dialog input', confirmation)",
    );
    expect(accountClient).toContain("sentinel = 'x',");
    expect(accountClient).toContain('SECRET_TEXT: `${sentinel}${value}`');
    expect(accountClient).toContain("await this.key('home')");
    expect(accountClient).toContain("await this.key('forwardDelete')");
    expect(accountClient).toContain('async waitForFullViewportNativeBounds()');
    expect(accountClient).toContain(
      'await this.waitForFullViewportNativeBounds();',
    );
    expect(accountClient).toContain(
      'Native point is outside the attached WebView bounds',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="alert-confirm"]\')',
    );
    expect(journey).toContain("await confirmErase(client, 'yes please')");
    expect(journey).toContain(
      "await confirmErase(client, 'reset trinity', true)",
    );
    expect(journey).toContain(
      "await confirmErase(client, 'RESET TRINITY', true)",
    );
    expect(journey).toContain(
      'const immediatelyBefore = await snapshot(client)',
    );
    expect(journey).toContain('immediatelyBefore.documentTimeOrigin');
    expect(accountClient).toContain('async tapCurrentReplacingDocument(');
    expect(accountClient).toContain(
      'allowDocumentReplacementFrom: previousTimeOrigin',
    );
    expect(accountClient).toContain(
      'documentTimeOrigin !== allowDocumentReplacementFrom',
    );
    expect(journey).toContain('waitForRestartedEmptyState(');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain('assert.equal(cases.length, 6');
    expect(journey).toContain('expectedAssertions: 25');
    expect(journey).toContain('new Set<ClearAllDataAssertion>()');
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'signedInSecureTokenWebviewExclusion',
      'signedInNativeAccountPreferencePresent',
      'signedInSyncDatabasePresent',
      'signedInCryptoDatabasePresent',
      'signedInEscapeHatchVisible',
      'signedInMistypeFeedback',
      'signedInMistypePreservesState',
      'signedInNativePreferencesEmpty',
      'signedInDatabaseEnumerationReady',
      'signedInDatabasesRemoved',
      'signedInSignedOutSurfaceVisible',
      'signedOutDeadPushPreferencePresent',
      'signedOutNativePreferencesEmpty',
      'trinityLightApplied',
      'trinityLightDangerToken',
      'trinityLightAaContrast',
      'trinityDarkApplied',
      'trinityDarkDangerToken',
      'trinityDarkAaContrast',
      'amethystLightApplied',
      'amethystLightDangerToken',
      'amethystLightAaContrast',
      'amethystDarkApplied',
      'amethystDarkDangerToken',
      'amethystDarkAaContrast',
    ]) {
      expect(journey).toMatch(
        new RegExp(`recordAssertion\\([\\s\\S]*?assertions\\.${key}[,\\)]`),
      );
    }
    for (const mutation of forbiddenJourneyMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('rejects vacuous wipe, restart, visual and cleanup evidence', () => {
    const observer = readIfPresent(observerPath);
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain(
      "value.preferenceKeys.includes('matrix.accounts')",
    );
    expect(journey).toContain(
      "assert(preferencesPreserved, 'Mistyped confirmation preserves preferences')",
    );
    expect(journey).toContain(
      "assert(databasesPreserved, 'Mistyped confirmation preserves databases')",
    );
    expect(observer).toContain('value.preferenceKeys.length === 0');
    expect(observer).toContain(
      'previousDatabases.every((name) => !value.databases.includes(name))',
    );
    expect(observer).toMatch(
      /waitForNativeShellState\(\s*\(\) => snapshot\(client\),/u,
    );
    expect(observer).not.toMatch(
      /waitForNativeShellState\(\s*async \(\) => \{[\s\S]*?catch/u,
    );
    expect(observer).toContain(
      'value.documentTimeOrigin !== previousTimeOrigin',
    );
    expect(journey).toMatch(
      /assert\.deepEqual\(\s*observation\.text,\s*observation\.danger,/u,
    );
    expect(journey).toContain('observation.ratio >= AA_NORMAL_TEXT');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain('device.close()');
    expect(journey).toContain('client?.close()');
  });

  it('registers one bounded uncached Nx suite and started-only hosted artifact', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['clear-all-data'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain('--suite=android.clear-all-data');
    expect(target.options.command).toContain('--timeout-ms=1200000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/clear-all-data-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:clear-all-data']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:clear-all-data',
    );

    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.clear-all-data'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:clear-all-data'",
    );
    expect(runners).toContain("canonicalScript: 'e2e:android:clear-all-data'");
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/clear-all-data-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:clear-all-data'");
    expect(commands).toContain("suiteIds: ['android.clear-all-data']");
    expect(workflow).toContain('clear-all-data-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:clear-all-data',
    );
    expect(workflow).toContain('surface: android-clear-all-data');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.clear-all-data/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.clear-all-data-started == 'true'/u,
    );
  });

  it('keeps every exact predecessor enabled', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Clear-all-data journeys');
    expect(migration).toContain('`android.clear-all-data`');
    expect(migration).toContain('11 signed-in, two signed-out and 12 visual');
    expect(migration).toContain('`shared_prefs/CapacitorStorage.xml`');
    expect(migration).toContain('`hover: none` and `pointer: coarse`');
    expect(migration).toContain(
      '271c63f2e49f27d7c99d4d0d75c7b844d466d70afe69afda71d1335bcc0b1e9c',
    );
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain(
      "path: 'journeys/accounts/clear-all-data.spec.mts'",
    );
    expect(read(predecessorSource)).toContain(
      "test('erases a signed-in install and restarts into an empty app'",
    );
    expect(read(predecessorSource)).toContain(
      "test('erases a signed-out install whose settings are wedged'",
    );
    expect(read(predecessorSource)).toContain(
      "for (const scheme of ['light', 'dark'] as const)",
    );
  });
});
