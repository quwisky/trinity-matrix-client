import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const blockSource =
  'e2e/browser/journeys/room-administration/block-member.spec.mts';
const removalSource =
  'e2e/browser/journeys/room-administration/kick-member.spec.mts';
const contractPath = resolve(
  root,
  'e2e/android/member-moderation-contract.mts',
);
const journeyPath = resolve(root, 'e2e/android/member-moderation-journeys.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const assertionIds = [
  'block.room-timeline-visible',
  'block.members-initially-hidden',
  'block.members-panel-visible',
  'block.member-info-visible',
  'block.action-block-visible',
  'block.action-unblock-visible',
  'kick.room-timeline-visible',
  'kick.members-initially-hidden',
  'kick.members-panel-visible',
  'kick.member-info-visible',
  'kick.member-info-closed',
  'kick.roster-visible',
  'kick.member-row-absent',
  'kick.server-membership',
  'ban.room-timeline-visible',
  'ban.members-initially-hidden',
  'ban.members-panel-visible',
  'ban.member-info-visible',
  'ban.member-info-closed',
  'ban.roster-visible',
  'ban.member-row-absent',
  'ban.server-membership',
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

describe('Android member moderation migration', () => {
  it('pins the Block and generated Kick/Ban sources while preserving the browser-only fault', () => {
    const block = readFileSync(resolve(root, blockSource));
    const removal = readFileSync(resolve(root, removalSource));
    const blockLines = block.toString('utf8').split('\n');
    const removalLines = removal.toString('utf8').split('\n');

    expect(createHash('sha256').update(block).digest('hex')).toBe(
      '792a6e1d021c5e09661c5847e4fb577044cab1635673151cefd026cf57acfa84',
    );
    expect(createHash('sha256').update(removal).digest('hex')).toBe(
      'e7ab22e420abf9f545c7ad1bb9b637b435cbc9a754759167070ebb38550d2a86',
    );
    expect(blockLines[46]).toContain('async function openRoom');
    expect(blockLines[54]).toBe('}');
    expect(blockLines[59]).toContain(
      "test('blocking a member flips the action to Unblock'",
    );
    expect(blockLines[122]).toBe('  });');
    expect(removalLines[67]).toContain('async function openRoom');
    expect(removalLines[75]).toBe('}');
    expect(removalLines[80]).toContain('for (const moderation of [');
    expect(removalLines[93]).toContain('] as const) {');
    expect(removalLines[94]).toContain(
      'an admin ${moderation.label} a lower-power member',
    );
    expect(removalLines[164]).toBe('    });');
    expect(removalLines[167]).toContain("test('labels a retained stale roster");
    expect(removalLines.slice(171, 175).join('\n')).toContain(
      "process.env['TRINITY_E2E_PLATFORM'] === 'android'",
    );
    expect(removalLines.slice(171, 175).join('\n')).toContain(
      'installed APK is production',
    );

    const directExpectSites = (lines) =>
      lines.filter((line) => line.includes('expect(')).length;
    expect(
      directExpectSites([
        ...blockLines.slice(46, 55),
        ...blockLines.slice(59, 123),
      ]),
    ).toBe(6);
    expect(
      directExpectSites([
        ...removalLines.slice(67, 76),
        ...removalLines.slice(94, 165),
      ]),
    ).toBe(8);
  });

  it('exports exact source mappings, the generated domain, and 22 unique identities', async () => {
    expect(
      existsSync(contractPath),
      'member-moderation-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);

    expect(contract.MEMBER_MODERATION_SOURCES).toEqual({
      block: {
        helper: `${blockSource}:47-55`,
        definition: `${blockSource}:60-123`,
      },
      removal: {
        helper: `${removalSource}:68-76`,
        generator: `${removalSource}:81-94`,
        definitions: `${removalSource}:95-165`,
      },
      staleRoster: {
        definition: `${removalSource}:168-291`,
        androidExclusion:
          'fault injection requires Angular development hooks; the installed APK is production',
      },
    });
    expect(contract.memberRemovalActions).toEqual([
      {
        id: 'kick',
        actionTestId: 'member-info-kick',
        expectedMembership: 'leave',
      },
      {
        id: 'ban',
        actionTestId: 'member-info-ban',
        expectedMembership: 'ban',
      },
    ]);
    expect(Object.values(contract.memberModerationAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.memberModerationAssertions)).size,
    ).toBe(22);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?22,[\s\S]*?Exactly 22 member moderation assertion identities are required/,
    );
  });

  it('implements three Pixel 5 stages with every assertion identity', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey, 'member-moderation-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('member-moderation-contract.mts');
    expect(journey).toContain('MEMBER_MODERATION_SOURCES.block.definition');
    expect(journey).toContain('MEMBER_MODERATION_SOURCES.removal.definitions');
    expect(journey).toContain('memberRemovalActions');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?3,[\s\S]*?Exactly three member moderation stages are required/,
    );
    for (const key of [
      'blockRoomTimelineVisible',
      'blockMembersInitiallyHidden',
      'blockMembersPanelVisible',
      'blockMemberInfoVisible',
      'blockActionBlockVisible',
      'blockActionUnblockVisible',
      'kickRoomTimelineVisible',
      'kickMembersInitiallyHidden',
      'kickMembersPanelVisible',
      'kickMemberInfoVisible',
      'kickMemberInfoClosed',
      'kickRosterVisible',
      'kickMemberRowAbsent',
      'kickServerMembership',
      'banRoomTimelineVisible',
      'banMembersInitiallyHidden',
      'banMembersPanelVisible',
      'banMemberInfoVisible',
      'banMemberInfoClosed',
      'banRosterVisible',
      'banMemberRowAbsent',
      'banServerMembership',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('seeds exact fixtures and drives compact member navigation natively', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain('invite: [member.userId]');
    expect(journey).toContain('fixtures.setDisplayName(member, memberName)');
    expect(journey).toContain('fixtures.join(member, room.id)');
    expect(journey).toContain('client.login(admin)');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(journey).toContain("client.tapCurrent('.channel'");
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="room-actions-overflow"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="overflow-toggle-members"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="member-row"]\', {',
    );
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('binds Block identities to exact surfaces and the Block to Unblock round trip', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.blockRoomTimelineVisible,[\s\S]*?'\[data-testid="composer-input"\]'[\s\S]*?elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toMatch(
      /assertions\.blockMembersInitiallyHidden,[\s\S]*?'\.chat-members'[\s\S]*?elements\.length === 0 \|\|[\s\S]*?elements\.every\(\(element\) => !element\.visible\)/,
    );
    expect(journey).toMatch(
      /assertions\.blockMembersPanelVisible,[\s\S]*?'\[data-testid="member-list"\]'[\s\S]*?elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toMatch(
      /assertions\.blockMemberInfoVisible,[\s\S]*?'\[data-testid="member-info"\]'[\s\S]*?elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toMatch(
      /assertions\.blockActionBlockVisible,[\s\S]*?'\[data-testid="member-info-ignore"\]'[\s\S]*?\{ exactText: 'Block' \}/,
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="member-info-ignore"]\')',
    );
    expect(journey).toMatch(
      /assertions\.blockActionUnblockVisible,[\s\S]*?'\[data-testid="member-info-ignore"\]'[\s\S]*?\{ exactText: 'Unblock' \}/,
    );
  });

  it('binds generated Kick/Ban identities to panel recovery and exact Matrix membership', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /for \(const moderation of memberRemovalActions\)[\s\S]*?id: moderation\.id/,
    );
    expect(journey).toContain(
      "client.scrollIntoViewIfNeeded(actionSelector, '.member-info')",
    );
    expect(journey).toContain('client.tapCurrent(actionSelector)');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="alert-confirm"]\')',
    );
    expect(journey).toMatch(
      /fixtures\.roomMembership\(\s*fixture\.admin,\s*fixture\.room\.id,\s*fixture\.member,\s*\)/,
    );
    expect(journey).toMatch(
      /\(membership\) => membership === expectedMembership,\s*assertionIdentity,/,
    );
    expect(journey).toMatch(
      /observedElements\(\s*client,\s*stageAssertions\.memberInfoClosed,\s*'\[data-testid="member-info"\]',\s*\(elements\) => elements\.length === 0,\s*\)/,
    );
    expect(journey).toMatch(
      /observedElements\(\s*client,\s*stageAssertions\.rosterVisible,\s*'\[data-testid="member-list"\]',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible,\s*\)/,
    );
    expect(journey).toMatch(
      /observedElements\(\s*client,\s*stageAssertions\.memberRowAbsent,\s*'\[data-testid="member-row"\]',\s*\(elements\) => elements\.length === 0,\s*\{ text: memberName \},\s*\)/,
    );
    expect(journey).toMatch(
      /observedMembership\(\s*client,\s*fixtures,\s*stageAssertions\.serverMembership,[\s\S]*?moderation\.expectedMembership,\s*\)/,
    );
    expect(journey).toContain(
      'fixtures.allowEndedMembershipCleanup(member, room.id)',
    );
  });

  it('retains invocation-owned lifecycle, evidence, and secret redaction', () => {
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
