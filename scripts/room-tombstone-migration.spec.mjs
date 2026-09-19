import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sourcePath =
  'e2e/browser/journeys/room-administration/tombstone.spec.mts';
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const contractPath = resolve(root, 'e2e/android/room-tombstone-contract.mts');
const journeyPath = resolve(root, 'e2e/android/room-tombstone-journeys.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

// Literal issue #707 identities: this independent list detects omissions and substitutions.
const assertionIds = [
  'old.composer-visible',
  'old.banner-visible',
  'layout.banner-above-chat-row',
  'layout.timeline-share',
  'successor.banner-hidden',
  'successor.composer-visible',
];

const forbiddenProductMutations = [
  /\.click\s*\(/,
  /\.focus\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.(?:requestSubmit|submit)\s*\(/,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/,
  /\blocation\.(?:assign|replace|reload)\s*\(/,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/,
  /\bwindow\.open\s*\(/,
  /client\.(?:focusFixture|navigate|reload)\s*\(/,
  /documentElement\.(?:style|classList|setAttribute|removeAttribute)/,
  /Page\.navigate/,
];

describe('Android Room tombstone migration', () => {
  it('pins the unchanged helper and single-definition predecessor', () => {
    const source = readFileSync(resolve(root, sourcePath));
    const lines = source.toString('utf8').split('\n');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'ca5563f9d5a4f84db23d7fb7a889da28682fffabf3dedd3b42b2f529d936472b',
    );
    expect(lines[14]).toBe(
      'async function openRoom(page: Page, roomName: string): Promise<void> {',
    );
    expect(lines[22]).toBe('}');
    expect(lines[27]).toContain(
      "test('shows the upgrade banner and moves to the successor room'",
    );
    expect(lines[112]).toBe('  });');
    expect(
      [...source.toString('utf8').matchAll(/^  test\('([^']+)'/gm)].map(
        (match) => match[1],
      ),
    ).toEqual(['shows the upgrade banner and moves to the successor room']);
  });

  it('exports the exact source mappings and six unique assertion identities', async () => {
    expect(
      existsSync(contractPath),
      'room-tombstone-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);

    expect(contract.ROOM_TOMBSTONE_SOURCE).toEqual({
      helper: `${sourcePath}:15-23`,
      definition: `${sourcePath}:28-113`,
    });
    expect(Object.values(contract.roomTombstoneAssertions)).toEqual(
      assertionIds,
    );
    expect(new Set(Object.values(contract.roomTombstoneAssertions)).size).toBe(
      6,
    );
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?6,[\s\S]*?Exactly six Room tombstone assertion identities are required/,
    );
  });

  it('implements one Pixel 5 native stage with every assertion identity', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey, 'room-tombstone-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('room-tombstone-contract.mts');
    expect(journey).toContain('ROOM_TOMBSTONE_SOURCE.definition');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?1,[\s\S]*?Exactly one Room tombstone stage is required/,
    );
    for (const key of [
      'oldComposerVisible',
      'oldBannerVisible',
      'layoutBannerAboveChatRow',
      'layoutTimelineShare',
      'successorBannerHidden',
      'successorComposerVisible',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('seeds the exact tombstone graph and drives product actions natively', () => {
    const fixture = readFileSync(fixturePath, 'utf8');
    const journey = readIfPresent(journeyPath);

    expect(fixture).toContain("| 'm.room.tombstone'");
    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain("'m.room.tombstone'");
    expect(journey).toContain("body: 'This room has been upgraded.'");
    expect(journey).toContain('replacement_room: successor.id');
    expect(journey).toContain('client.login(account)');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(journey).toContain("client.tapCurrent('.channel'");
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="tombstone-go"]\')',
    );
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('binds old-Room and layout identities to the exact outcomes', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.oldComposerVisible,\s*'\[data-testid="composer-input"\]',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toMatch(
      /assertions\.oldBannerVisible,\s*'\[data-testid="tombstone-banner"\]',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toContain("banner.closest('.chat-body')");
    expect(journey).toContain("document.querySelector('.chat-body')");
    expect(journey).toContain(
      "document.querySelector('.chat-body trn-simple-message-list, .chat-body trn-virtual-message-list')",
    );
    expect(journey).toMatch(
      /assertions\.layoutBannerAboveChatRow,[\s\S]*?insideChatBody === false/,
    );
    expect(journey).toMatch(
      /assertions\.layoutTimelineShare,[\s\S]*?timelineShare > 0\.5/,
    );
  });

  it('binds successor identities to the hidden banner and visible composer', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.successorBannerHidden,\s*'\[data-testid="tombstone-banner"\]',\s*\(elements\) =>\s*elements\.length === 0/,
    );
    expect(journey).toMatch(
      /assertions\.successorComposerVisible,\s*'\[data-testid="composer-input"\]',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible/,
    );
  });

  it('retains invocation-owned lifecycle, evidence and secret redaction', () => {
    const journey = readIfPresent(journeyPath);

    for (const required of [
      'openMaestroDevice({',
      'device.install(',
      'client.reset(entry.profile ?? PIXEL_5_ACCOUNT_PROFILE)',
      "status: 'running'",
      "stage.status = failures.length ? 'failed' : 'passed'",
      "join(output, 'journeys.json')",
      'redactMaestroArtifacts(output, secrets)',
      'device.close()',
      'client?.close()',
    ]) {
      expect(journey).toContain(required);
    }
    expect(journey.indexOf('await save();')).toBeLessThan(
      journey.indexOf('const device = await openMaestroDevice({'),
    );
    expect(journey.indexOf('await save();')).toBeLessThan(
      journey.indexOf('await device.install('),
    );
    expect(journey).not.toMatch(/password\s*:/);
    expect(journey).not.toMatch(/access[_-]?token\s*:/i);
  });
});
