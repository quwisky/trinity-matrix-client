import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/space-curation.spec.mts',
);
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

describe('Android space creation and join curation migration', () => {
  it('pins the three unchanged predecessor definitions', () => {
    const source = readFileSync(sourcePath);
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
