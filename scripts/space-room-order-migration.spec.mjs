import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/space-room-order.spec.mts',
);
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

describe('Android space room-order migration', () => {
  it('pins the two unchanged functional predecessor definitions', () => {
    const source = readFileSync(sourcePath);
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
