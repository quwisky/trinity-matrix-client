import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const markReadPath = resolve(
  root,
  'e2e/browser/journeys/room-library/mark-read.spec.mts',
);
const markUnreadPath = resolve(
  root,
  'e2e/browser/journeys/room-library/mark-unread.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/room-read-state-journeys.mts',
);
const fixturesPath = resolve(
  root,
  'e2e/android/account-workspace-fixtures.mts',
);

const assertionIds = [
  'mark-all.room-visible',
  'mark-all.action-visible',
  'mark-all.action-hidden',
  'local.initial-flag-absent',
  'local.initial-badge-absent',
  'local.flag-round-trip',
  'local.dot-visible',
  'local.dot-empty',
  'local.conversation-visible',
  'local.flag-cleared',
  'local.dot-cleared',
  'remote.initial-badge-absent',
  'remote.write-accepted',
  'remote.live-dot-visible',
  'remote.reload-dot-visible',
  'remote.flag-cleared',
  'remote.dot-cleared',
];

describe('Android room read-state migration', () => {
  it('pins all three unchanged Playwright predecessors', () => {
    const markRead = readFileSync(markReadPath);
    const markUnread = readFileSync(markUnreadPath);

    expect(createHash('sha256').update(markRead).digest('hex')).toBe(
      '38d3d95524dcb03cbc36ba0891031e52014ed66a8ff7416df374aa7f2256828b',
    );
    expect(createHash('sha256').update(markUnread).digest('hex')).toBe(
      '43165d7f4fc936d214d54e5410d7876d174e6e61c0c477ed6fa8d398e70963b6',
    );
    expect(markRead.toString('utf8')).toContain(
      "test('mark all as read clears the unread indicator'",
    );
    expect(markUnread.toString('utf8')).toContain(
      "test('flags a read room, and opening it clears the flag'",
    );
    expect(markUnread.toString('utf8')).toContain(
      "test('a flag set elsewhere arrives, survives a reload, and Mark as read clears it'",
    );
  });

  it('maps exactly three stages and all 17 direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/mark-read.spec.mts:48-102',
    );
    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/mark-unread.spec.mts:29-103',
    );
    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/mark-unread.spec.mts:105-180',
    );
    expect(replacement).toContain(
      "assert.equal(cases.length, 3, 'Exactly three room read-state stages are required')",
    );
    expect(new Set(assertionIds).size).toBe(17);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves fresh fixtures, Pixel 5, exact waits and native actions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain("preset: 'private_chat'");
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain('`[aria-label="Options for ${roomName}"]`');
    expect(replacement).toContain("client.tapCurrent('.channel-row'");
    expect(replacement).toContain('client.reload()');
    expect(replacement).toContain('30_000');
    expect(replacement).toContain('20_000');
  });

  it('keeps Matrix access tokens private inside the fixture boundary', () => {
    const fixtures = readFileSync(fixturesPath, 'utf8');
    const publicContract = fixtures.match(
      /export function createAccountFixtures[\s\S]*?\): \{([\s\S]*?)\n\} \{/,
    );

    expect(fixtures).toContain('markedUnread(');
    expect(fixtures).toContain('setMarkedUnread(');
    expect(publicContract).not.toBeNull();
    expect(publicContract?.[1]).not.toContain('token');
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
