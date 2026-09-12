import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/room-list.spec.mts',
);
const replacementPath = resolve(root, 'e2e/android/room-list-journeys.mts');

const assertionIds = [
  'preview.latest-body',
  'preview.room-name',
  'preview.avatar-count',
  'preview.legacy-hash-absent',
  'unread.muted-badge-visible',
  'unread.muted-badge-count',
];

describe('Android room-list migration', () => {
  it('pins both complete unchanged Playwright predecessors', () => {
    const source = readFileSync(sourcePath);

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '122c617df290018bd59fcb57a08ad962e78dbba1230ae87d16d9d3c684112654',
    );
    expect(source.toString('utf8')).toContain(
      "test('a room row shows avatar, name, and last-message preview instead of a hash'",
    );
    expect(source.toString('utf8')).toContain(
      "test('an unread room row shows a muted badge with the unread count, and it clears once opened'",
    );
  });

  it('maps exactly two stages and all six direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/room-list.spec.mts:185-217',
    );
    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/room-list.spec.mts:219-269',
    );
    expect(replacement).toContain(
      "assert.equal(cases.length, 2, 'Exactly two room-list stages are required')",
    );
    expect(new Set(assertionIds).size).toBe(6);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves fixtures, Pixel 5, waits, native actions and best-effort clear evidence', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain("preset: 'private_chat'");
    expect(replacement).toContain(
      "const PREVIEW_BODY = 'latest preview message'",
    );
    expect(replacement).toContain('const UNREAD_SEED = 3');
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain("client.tapCurrent('.channel'");
    expect(replacement).toContain("'unread.badge-clear-observation'");
    expect(replacement).toContain('30_000');
    expect(replacement).toContain('15_000');
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
