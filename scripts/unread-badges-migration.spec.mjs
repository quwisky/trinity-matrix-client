import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/unread-badges.spec.mts',
);
const replacementPath = resolve(root, 'e2e/android/unread-badges-journeys.mts');

const assertionIds = [
  'rail.badge-visible',
  'rail.badge-positive-count',
  'platform.badge-set-three',
  'platform.badge-clear-zero',
];

describe('Android unread-badges migration', () => {
  it('pins both complete unchanged Playwright predecessors', () => {
    const source = readFileSync(sourcePath);

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '88717c4e01c304025b951a359b1cda79a775e92015be2f294639b39490adfae0',
    );
    expect(source.toString('utf8')).toContain(
      "test('server-rail Rooms pill shows the aggregated unread count'",
    );
    expect(source.toString('utf8')).toContain(
      "test('the platform badge mirrors the unread total'",
    );
  });

  it('maps exactly two stages and all four direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/unread-badges.spec.mts:133-160',
    );
    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/unread-badges.spec.mts:162-186',
    );
    expect(replacement).toMatch(
      /assert\.equal\(\s*cases\.length,\s*2,\s*'Exactly two unread-badge stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(4);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves fixtures, Pixel 5, waits, native actions and the Badge recorder', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain("preset: 'private_chat'");
    expect(replacement).toContain('const UNREAD_SEED = 3');
    expect(replacement).toContain('installAccountBadgeRecorder');
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain("client.tapCurrent('.channel'");
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
