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

  it('keeps every exact predecessor enabled', () => {
    const catalog = read('e2e/browser/journey-catalog.mts');
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
