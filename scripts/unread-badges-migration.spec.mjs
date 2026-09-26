import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRetiredPredecessor } from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceFile = 'e2e/browser/journeys/room-library/unread-badges.spec.mts';
const replacementPath = resolve(root, 'e2e/android/unread-badges-journeys.mts');

const assertionIds = [
  'rail.badge-visible',
  'rail.badge-positive-count',
  'platform.badge-set-three',
  'platform.badge-clear-zero',
];

function ownLedgerSection() {
  const docs = readFileSync(resolve(root, 'e2e/android/MIGRATION.md'), 'utf8');
  const start = docs.indexOf(
    '\n## Aggregate and platform unread-badge batch\n',
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = docs.indexOf('\n## ', start + 1);
  return docs.slice(start, end === -1 ? undefined : end);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a kept definition starts by skipping Android, which owns its Android run. */
const skipsAndroidFirst = (source, title) =>
  new RegExp(
    `test\\('${escapeRegExp(title)}', async \\(\\{[^}]*\\}(?:, testInfo)?\\) => \\{\\s*test\\.skip\\(\\s*isAndroidE2E,`,
  ).test(source);

describe('Android unread-badges migration', () => {
  it('pins both predecessors at their retirement commit', () => {
    const source = readRetiredPredecessor(sourceFile);

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

  it('retires the Android-owned definitions and keeps desktop-only ones skipped on Android', () => {
    const working = readFileSync(resolve(root, sourceFile), 'utf8');

    expect(working).not.toContain(
      "test('server-rail Rooms pill shows the aggregated unread count'",
    );
    expect(working).toContain(
      "test('the platform badge mirrors the unread total'",
    );
    expect(
      skipsAndroidFirst(working, 'the platform badge mirrors the unread total'),
    ).toBe(true);
    expect(ownLedgerSection()).toContain(
      'Predecessor status: retired on 2026-09-26',
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
