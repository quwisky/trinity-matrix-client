import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/room-filter-spaceless.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/room-filter-spaceless-journeys.mts',
);

const assertionIds = [
  'rooms.freestanding-visible',
  'rooms.child-absent',
  'space.pill-visible',
  'space.pill-current',
  'space.child-visible',
  'space.child-name-exact',
];

describe('Android spaceless room-filter migration', () => {
  it('pins the unchanged predecessor definition', () => {
    const source = readFileSync(sourcePath);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '0f5d42072c018ef27e6e1c6276f72b209d43b927666149c8e7574c2bc4aefadc',
    );
    expect(text).toContain(
      "test('a spaceless room stays in the flat Rooms list; a space child moves under its space pill'",
    );
  });

  it('maps one functional stage and all six direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/room-filter-spaceless.spec.mts:147-230',
    );
    expect(replacement).toMatch(
      /assert\.equal\(\s*cases\.length,\s*1,\s*'Exactly one spaceless room-filter stage is required'/,
    );
    expect(new Set(assertionIds).size).toBe(6);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves Matrix setup, Pixel 5 and exact native navigation', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain('fixtures.setSpaceChild(');
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
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
