import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/recent-activity.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/recent-activity-journeys.mts',
);

const assertionIds = [
  'scope.recent-current',
  'scope.recent-dm-visible',
  'scope.recent-room-visible',
  'scope.home-recent-not-current',
  'scope.home-dm-visible',
  'scope.home-room-absent',
  'scope.rooms-room-visible',
  'scope.rooms-dm-absent',
  'scope.return-dm-visible',
  'scope.return-room-visible',
  'favourites.recent-current',
  'favourites.section-visible',
  'favourites.row-visible',
  'favourites.dm-visible',
  'favourites.index-present',
  'favourites.before-dm',
  'space.recent-current',
  'space.free-visible',
  'space.child-visible',
  'space.rooms-free-visible',
  'space.rooms-child-absent',
  'unread.badge-visible',
  'unread.badge-numeric',
  'unread.badge-positive',
];

describe('Android Recent Activity migration', () => {
  it('pins all four unchanged predecessor definitions', () => {
    const source = readFileSync(sourcePath);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'c2b12540c8b45ace5a7d3e2111c3f00a61ba69555522b5b6212636cb0fc9243c',
    );
    for (const title of [
      'is the default view and mixes DMs with rooms; Home and Rooms stay scoped',
      'groups favourites above the rest of the mixed list',
      'includes a space-owned room, which the flat Rooms view excludes',
      'shows the unread total on the Recent pill',
    ]) {
      expect(text).toContain(`test('${title}'`);
    }
  });

  it('maps exactly four stages and all 24 direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    for (const span of ['97-142', '144-189', '191-240', '242-301']) {
      expect(replacement).toContain(
        `e2e/browser/journeys/room-library/recent-activity.spec.mts:${span}`,
      );
    }
    expect(replacement).toMatch(
      /assert\.equal\(\s*cases\.length,\s*4,\s*'Exactly four Recent Activity stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(24);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves Matrix setup, Pixel 5 and exact native navigation', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain('fixtures.createDirectRoom(');
    expect(replacement).toContain('fixtures.setRoomTag(');
    expect(replacement).toContain('fixtures.setSpaceChild(');
    expect(replacement).toContain('fixtures.sendMessage(');
    expect(replacement).toContain('client.tapCurrent(\'[aria-label="Home"]\')');
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-recent"]\')',
    );
    expect(replacement).toContain('const UNREAD_SEED = 3');
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
