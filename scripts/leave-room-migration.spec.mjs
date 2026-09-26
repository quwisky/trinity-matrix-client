import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRetiredPredecessor } from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceFile = 'e2e/browser/journeys/room-library/leave-room.spec.mts';
const replacementPath = resolve(root, 'e2e/android/leave-room-journeys.mts');

const assertionIds = [
  'setup.leave-row-visible',
  'setup.keep-row-visible',
  'menu.leave-action-visible',
  'dialog.confirm-visible',
  'list.left-absent',
  'list.keep-visible',
];

function ownLedgerSection() {
  const docs = readFileSync(resolve(root, 'e2e/android/MIGRATION.md'), 'utf8');
  const start = docs.indexOf('\n## Leave-room functional batch\n');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = docs.indexOf('\n## ', start + 1);
  return docs.slice(start, end === -1 ? undefined : end);
}

describe('Android leave-room migration', () => {
  it('pins the functional predecessor at its retirement commit', () => {
    const source = readRetiredPredecessor(sourceFile);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '3ff3a9e93bc430044062948c4e8e6bac67578f5588d68691ac540f46e41b390c',
    );
    expect(text).toContain(
      "test('leaving a room removes it from the list while others stay'",
    );
    expect(text).toContain("test.describe('Destructive menu item contrast'");
    expect(text).toContain('page.emulateMedia({ colorScheme: scheme })');
  });

  it('retires the Android-owned definition and keeps the browser-only rest', () => {
    const working = readFileSync(resolve(root, sourceFile), 'utf8');

    expect(working).not.toContain(
      "test('leaving a room removes it from the list while others stay'",
    );
    expect(working).toContain("test.describe('Destructive menu item contrast'");
    expect(working).toContain('page.emulateMedia({ colorScheme: scheme })');
    expect(ownLedgerSection()).toContain(
      'Predecessor status: retired on 2026-09-26',
    );
  });

  it('maps exactly one stage and all six direct assertions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain(
      'e2e/browser/journeys/room-library/leave-room.spec.mts:79-110',
    );
    expect(replacement).toMatch(
      /assert\.equal\(\s*cases\.length,\s*1,\s*'Exactly one leave-room stage is required'/,
    );
    expect(new Set(assertionIds).size).toBe(6);
    for (const assertion of assertionIds) {
      expect(replacement).toContain(`'${assertion}'`);
    }
  });

  it('preserves two-room fixtures, Pixel 5, waits and exact native actions', () => {
    const replacement = readFileSync(replacementPath, 'utf8');

    expect(replacement).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(replacement).toContain("preset: 'private_chat'");
    expect(replacement).toContain('const ROOM_COUNT = 2');
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(replacement).toContain('`Options for ${leaveRoom.name}`');
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="room-leave"]\')',
    );
    expect(replacement).toContain(
      'client.tapCurrent(\'[data-testid="alert-confirm"]\')',
    );
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
