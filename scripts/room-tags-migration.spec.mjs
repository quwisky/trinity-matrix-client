import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/favourite-rooms.spec.mts',
);
const replacementPath = resolve(root, 'e2e/android/room-tags-journeys.mts');

const assertionIds = [
  'favourite.initial-section-absent',
  'favourite.menu-label',
  'favourite.first-room',
  'unfavourite.menu-label',
  'unfavourite.section-absent',
  'low-priority.initial-section-absent',
  'low-priority.initial-first-room',
  'low-priority.menu-label',
  'low-priority.last-room',
  'low-priority.first-room',
  'double-tag.low-priority-section-absent',
  'double-tag.favourites-section-visible',
  'double-tag.first-room',
  'double-tag.restore-label',
];

describe('Android room tags migration', () => {
  it('pins the complete unchanged Playwright predecessors', () => {
    const source = readFileSync(sourcePath);

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '35b1ba6d96033782dfb66e31a67821cb97a81c7bf98d4d729cbab5fd3313a228',
    );
    expect(source.toString('utf8')).toContain(
      "test('favouriting a room surfaces a Favourites section and moves it to the top; unfavouriting reverses it'",
    );
    expect(source.toString('utf8')).toContain(
      "test('demoting a room sinks it under a Low priority section, and favouriting it there pulls it back to the top'",
    );
  });

  it('maps exactly two stages and all 14 direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/favourite-rooms.spec.mts:130-196',
    );
    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/favourite-rooms.spec.mts:198-275',
    );
    expect(replacement).toContain(
      "assert.equal(cases.length, 2, 'Exactly two room tag stages are required')",
    );
    expect(new Set(assertionIds).size).toBe(14);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves the two-room fixture, Pixel 5 profile and native actions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain("preset: 'private_chat'");
    expect(replacement).toContain("const names = ['Alpha Room', 'Bravo Room']");
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain('`[aria-label="Options for ${roomName}"]`');
    expect(replacement).toContain('30_000');
    expect(replacement).toContain('10_000');
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
