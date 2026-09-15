import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/sidebar-touch.spec.mts',
);
const replacementPath = resolve(root, 'e2e/android/sidebar-touch-journeys.mts');

const assertionIds = [
  'touch.media-profile',
  'account-menu.visible',
  'account-menu.switch-account-copy',
  'account-menu.add-account-copy',
  'account-menu.remove-account-copy',
  'account-menu.within-viewport',
  'account-menu.escape-focus-restored',
  'identity-dock.position',
  'identity-dock.display',
  'identity-dock.flow',
  'touch-target.rail-rooms.width',
  'touch-target.rail-rooms.height',
  'touch-target.user-menu-trigger.width',
  'touch-target.user-menu-trigger.height',
  'touch-target.open-settings.width',
  'touch-target.open-settings.height',
  'room-row.height',
  'room-menu.opacity',
  'room-menu.width',
  'room-menu.height',
  'room-menu.low-priority-visible',
];

describe('Android sidebar touch migration', () => {
  it('pins the complete unchanged Playwright predecessor', () => {
    const source = readFileSync(sourcePath);

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '8b09cba85b29db3e4819462e45b0f074f516198dca8f1733c195722c492f6ebb',
    );
    expect(source.toString('utf8')).toContain(
      "test('keeps the rail, room, menu and identity-dock controls touch-sized'",
    );
  });

  it('maps exactly one stage and all 21 direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/sidebar-touch.spec.mts:32-164',
    );
    expect(replacement).toContain(
      "assert.equal(cases.length, 1, 'Exactly one sidebar touch stage is required')",
    );
    expect(new Set(assertionIds).size).toBe(21);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves Pixel 5 setup, native actions and bounded observations', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain("preset: 'private_chat'");
    expect(replacement).toContain("client.key('escape')");
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain('30_000');
    expect(replacement).toContain('10_000');
    expect(replacement).toContain(
      "throw new Error('missing mobile identity dock')",
    );
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
