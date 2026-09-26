import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRetiredPredecessor } from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceFile =
  'e2e/browser/journeys/room-library/space-room-order.spec.mts';
const replacementPath = resolve(
  root,
  'e2e/android/space-room-order-journeys.mts',
);

const assertionIds = [
  'preference.default-recency-order',
  'preference.form-visible',
  'preference.space-order-checked',
  'preference.saved-feedback',
  'preference.hierarchy-unchanged',
  'preference.curated-order',
  'preference.reload-curated-order',
  'preference.account-default-curated-order',
  'preference.default-saved-feedback',
  'preference.alphabetical-order',
  'preference.shortcut-recency-order',
  'live.initial-recency-order',
  'live.reordered-recency-order',
];

function replacement() {
  return existsSync(replacementPath)
    ? readFileSync(replacementPath, 'utf8')
    : '';
}

function ownLedgerSection() {
  const docs = readFileSync(resolve(root, 'e2e/android/MIGRATION.md'), 'utf8');
  const start = docs.indexOf('\n## Space room-order functional batch\n');
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

describe('Android space room-order migration', () => {
  it('pins the two functional predecessor definitions at their retirement commit', () => {
    const source = readRetiredPredecessor(sourceFile);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'b26ae29366d8d470a1f813da9bf9e6b501ec4f49d77d432f1ba7e77606c96705',
    );
    for (const title of [
      'defaults to recent activity, and a per-space choice beats the account default',
      're-orders as a message arrives, without reopening the space',
    ]) {
      expect(text).toContain(`test('${title}'`);
    }
  });

  it('retires the Android-owned definitions and keeps desktop-only ones skipped on Android', () => {
    const working = readFileSync(resolve(root, sourceFile), 'utf8');

    expect(working).not.toContain(
      "test('re-orders as a message arrives, without reopening the space'",
    );
    expect(working).toContain(
      "test('defaults to recent activity, and a per-space choice beats the account default'",
    );
    expect(
      skipsAndroidFirst(
        working,
        'defaults to recent activity, and a per-space choice beats the account default',
      ),
    ).toBe(true);
    expect(ownLedgerSection()).toContain(
      'Predecessor status: retired on 2026-09-26',
    );
  });

  it('maps exactly two stages and all thirteen direct assertions', () => {
    const text = replacement();

    for (const span of ['237-347', '428-464']) {
      expect(text).toContain(
        `e2e/browser/journeys/room-library/space-room-order.spec.mts:${span}`,
      );
    }
    expect(text).toMatch(
      /assert\.equal\(\s*cases\.length,\s*2,\s*'Exactly two space room-order stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(13);
    for (const assertion of assertionIds) {
      expect(text).toContain(`'${assertion}'`);
    }
  });

  it('preserves Matrix order/state proof, reload and native product actions', () => {
    const text = replacement();

    expect(text).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(text).toContain('fixtures.setSpaceChild(');
    expect(text).toContain('fixtures.spaceChild(');
    expect(text).toContain('fixtures.sendMessage(');
    expect(text).toContain('assert.deepEqual(');
    expect(text).toContain('await client.reload()');
    expect(text).toContain('client.tapCurrent(');
    expect(text).toContain('e2e/android/flows/native-shell-back.yaml');
    expect(text).toContain('30_000');
  });

  it('keeps WebView expressions observational', () => {
    const text = replacement();

    for (const mutation of [
      /\.click\s*\(/,
      /\.focus\s*\(/,
      /\.dispatchEvent\s*\(/,
      /(?:document|window)\.location\s*=/,
      /(?:document|window)\.location\.(?:assign|replace)\s*\(/,
      /history\.(?:back|forward|go|pushState|replaceState)\s*\(/,
      /window\.open\s*\(/,
    ]) {
      expect(text).not.toMatch(mutation);
    }
  });
});
