import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRetiredPredecessor } from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceFile = 'e2e/browser/journeys/room-library/space-curation.spec.mts';
const replacementPath = resolve(
  root,
  'e2e/android/space-curation-create-join-journeys.mts',
);

const assertionIds = [
  'add.dialog-visible',
  'add.link-present',
  'add.link-via-array',
  'add.link-via-nonempty',
  'subspace.name-field-visible',
  'subspace.link-present',
  'subspace.child-type-space',
  'join.action-visible',
  'join.action-hidden',
  'join.child-row-visible',
];

function ownLedgerSection() {
  const docs = readFileSync(resolve(root, 'e2e/android/MIGRATION.md'), 'utf8');
  const start = docs.indexOf(
    '\n## Space creation and join curation functional batch\n',
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = docs.indexOf('\n## ', start + 1);
  return docs.slice(start, end === -1 ? undefined : end);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a kept definition starts by skipping Android, which owns its Android run. */
const skipsAndroidFirst = (source, title) =>
  new RegExp(
    `test\\('${escapeRegExp(title)}', async \\(\\{[^}]*\\}(?:, testInfo)?\\) => \\{\\s*test\\.skip\\(\\s*isAndroidE2E,`,
  ).test(source);

describe('Android space creation and join curation migration', () => {
  it('pins the three predecessor definitions at their retirement commit', () => {
    const source = readRetiredPredecessor(sourceFile);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '35a2dd1726eef56c03288c64c23885703f3f1d06927870d4eeabac7bf3a51c7b',
    );
    for (const title of [
      'an admin adds an existing room to a space',
      'an admin creates a space inside a space',
      'a child moves out of More Channels the moment you join it',
    ]) {
      expect(text).toContain(`test('${title}'`);
    }
  });

  it('retires the Android-owned definitions and keeps desktop-only ones skipped on Android', () => {
    const working = readFileSync(resolve(root, sourceFile), 'utf8');

    expect(working).not.toContain(
      "test('an admin creates a space inside a space'",
    );
    expect(working).not.toContain(
      "test('a child moves out of More Channels the moment you join it'",
    );
    expect(working).toContain(
      "test('an admin adds an existing room to a space'",
    );
    expect(
      skipsAndroidFirst(working, 'an admin adds an existing room to a space'),
    ).toBe(true);
    expect(ownLedgerSection()).toContain(
      'Predecessor status: retired on 2026-09-26',
    );
  });

  it('maps exactly three stages and all ten direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    for (const span of ['92-140', '142-221', '392-457']) {
      expect(replacement).toContain(
        `e2e/browser/journeys/room-library/space-curation.spec.mts:${span}`,
      );
    }
    expect(replacement).toMatch(
      /assert\.equal\(\s*cases\.length,\s*3,\s*'Exactly three space creation and join stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(10);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves Matrix state proof, Pixel 5 and native product actions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain('fixtures.spaceChild(');
    expect(replacement).toContain('fixtures.spaceChildIds(');
    expect(replacement).toContain('fixtures.roomCreateType(');
    expect(replacement).toContain('fixtures.trackRoomMembership(');
    expect(replacement).toContain('client.fill(\'[placeholder="Space name"]\'');
    expect(replacement).toContain('client.tapCurrent(spaceSelector)');
    expect(replacement).toContain('30_000');
  });

  it('keeps WebView expressions observational', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    for (const mutation of [
      /\.click\s*\(/,
      /\.focus\s*\(/,
      /\.dispatchEvent\s*\(/,
      /(?:document|window)\.location\s*=/,
      /(?:document|window)\.location\.(?:assign|replace)\s*\(/,
      /history\.(?:back|forward|go|pushState|replaceState)\s*\(/,
      /window\.open\s*\(/,
    ]) {
      expect(replacement).not.toMatch(mutation);
    }
  });
});
