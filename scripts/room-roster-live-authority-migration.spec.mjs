import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitionSource =
  'e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';
const openSettingsTabSource = 'e2e/support/app.mts';
const contractPath = resolve(
  root,
  'e2e/android/room-roster-live-authority-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/room-roster-live-authority-journeys.mts',
);
const clientPath = resolve(root, 'e2e/android/account-workspace-client.mts');
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const directAssertionIds = [
  'roster.roster-visible',
  'roster.target-row-visible',
  'roster.detail-target',
  'roster.role-confirm-room',
  'roster.role-confirm-account',
  'roster.after-role-visible',
  'roster.moderator-group-target',
  'roster.detail-moderator',
  'roster.kick-absent-after-demotion',
  'roster.ban-absent-after-demotion',
  'roster.detail-target-after-demotion',
  'roster.detail-moderator-after-demotion',
  'roster.kick-visible-after-restore',
  'roster.kick-confirm-target',
  'roster.kick-confirm-room',
  'roster.kick-confirm-account',
  'roster.row-absent-after-kick',
  'roster.row-visible-after-rejoin',
  'roster.ban-visible',
  'roster.ban-confirm-target',
  'roster.ban-confirm-room',
  'roster.ban-confirm-account',
  'roster.row-absent-after-ban',
  'roster.banned-row-visible',
  'roster.unban-confirm-target',
  'roster.unban-confirm-room',
  'roster.unban-confirm-account',
  'roster.banned-row-absent',
  'roster.settings-closed-after-escape',
  'roster.conversation-row-visible',
  'roster.conversation-detail-target',
  'roster.conversation-row-after-close-visible',
  'roster.member-filter-focused',
];
const helperAssertionIds = [
  'roster.room-timeline-visible',
  'roster.members-panel-visible',
];
const assertionIds = [...helperAssertionIds, ...directAssertionIds];

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
  /\bdocument\.(?:createElement|write|writeln)\s*\(/,
  /\.(?:append|appendChild|prepend|remove|removeChild|replaceChildren)\s*\(/,
  /(?:documentElement|body|host|element|node)\.(?:style|classList|setAttribute|removeAttribute)/,
  /Page\.navigate/,
];

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

describe('Android Room roster and live-authority migration', () => {
  it('pins one definition, both transitive helpers, and exactly 35 sites', () => {
    const definition = sourceLines(
      definitionSource,
      'f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5',
    );
    const openRoom = sourceLines(
      openRoomSource,
      'bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7',
    );
    const openSettingsTab = sourceLines(
      openSettingsTabSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );

    expect(definition[171]).toContain(
      "test('keeps Room roster, member detail, role changes and live authority in one destination'",
    );
    expect(definition[400]).toBe('  });');
    expect(openRoom[35]).toContain('export async function openRoom');
    expect(openRoom[43]).toBe('}');
    expect(openSettingsTab[227]).toContain(
      'export async function openSettingsTab',
    );
    expect(openSettingsTab[247]).toBe('}');

    const expectSites = (lines, from, to) =>
      lines
        .slice(from - 1, to)
        .filter((line) => /\bexpect(?:\.poll)?(?:\(|\s*$)/.test(line)).length;
    expect(expectSites(definition, 172, 401)).toBe(33);
    expect(expectSites(openRoom, 36, 44)).toBe(1);
    expect(expectSites(openSettingsTab, 228, 248)).toBe(1);
  });

  it('exports exact mappings and stable 33+2 identities', async () => {
    expect(
      existsSync(contractPath),
      'room-roster-live-authority-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ROOM_ROSTER_LIVE_AUTHORITY_SOURCES).toEqual({
      definition: `${definitionSource}:172-401`,
      openRoom: `${openRoomSource}:36-44`,
      openSettingsTab: `${openSettingsTabSource}:228-248`,
    });
    expect(
      Object.values(contract.roomRosterLiveAuthorityHelperAssertions),
    ).toEqual(helperAssertionIds);
    expect(
      Object.values(contract.roomRosterLiveAuthorityDirectAssertions),
    ).toEqual(directAssertionIds);
    expect(Object.values(contract.roomRosterLiveAuthorityAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.roomRosterLiveAuthorityAssertions)).size,
    ).toBe(35);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?33,[\s\S]*?Exactly 33 direct Room roster assertion identities are required/,
    );
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?2,[\s\S]*?Exactly two helper Room roster assertion identities are required/,
    );
  });

  it('adds only the required create-room power override fixture shape', () => {
    const fixture = readIfPresent(fixturePath);
    expect(fixture).toMatch(
      /power_level_content_override\?:[\s\S]{0,180}?users\?:[\s\S]{0,120}?number/,
    );
    expect(fixture).toMatch(
      /content\.power_level_content_override[\s\S]{0,260}?power_level_content_override:[\s\S]{0,40}?content\.power_level_content_override/,
    );
  });

  it('implements one Pixel 5 stage through all 35 contract identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(
      journey,
      'room-roster-live-authority-journeys.mts must exist',
    ).not.toBe('');
    expect(journey).toContain('room-roster-live-authority-contract.mts');
    expect(journey).toContain('ROOM_ROSTER_LIVE_AUTHORITY_SOURCES.definition');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?1,[\s\S]*?Exactly one Room roster live-authority stage is required/,
    );
    for (const key of [
      'roomTimelineVisible',
      'membersPanelVisible',
      'rosterVisible',
      'targetRowVisible',
      'detailTarget',
      'roleConfirmRoom',
      'roleConfirmAccount',
      'afterRoleVisible',
      'moderatorGroupTarget',
      'detailModerator',
      'kickAbsentAfterDemotion',
      'banAbsentAfterDemotion',
      'detailTargetAfterDemotion',
      'detailModeratorAfterDemotion',
      'kickVisibleAfterRestore',
      'kickConfirmTarget',
      'kickConfirmRoom',
      'kickConfirmAccount',
      'rowAbsentAfterKick',
      'rowVisibleAfterRejoin',
      'banVisible',
      'banConfirmTarget',
      'banConfirmRoom',
      'banConfirmAccount',
      'rowAbsentAfterBan',
      'bannedRowVisible',
      'unbanConfirmTarget',
      'unbanConfirmRoom',
      'unbanConfirmAccount',
      'bannedRowAbsent',
      'settingsClosedAfterEscape',
      'conversationRowVisible',
      'conversationDetailTarget',
      'conversationRowAfterCloseVisible',
      'memberFilterFocused',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('uses finite setup, external actor transitions, and native product actions', () => {
    const journey = readIfPresent(journeyPath);
    const client = readIfPresent(clientPath);
    expect(journey).toContain('fixtures.setDisplayName(');
    expect(journey).toContain('fixtures.createRoom(');
    expect(journey).toContain('power_level_content_override:');
    expect(journey).toContain('fixtures.join(member, room.id)');
    expect(journey).toContain('fixtures.join(admin, room.id)');
    expect(journey).toMatch(
      /fixtures\.setRoomPower\(controller, room\.id, admin\.userId, 0\)/,
    );
    expect(journey).toMatch(
      /fixtures\.setRoomPower\(controller, room\.id, admin\.userId, 100\)/,
    );
    expect(
      journey.match(/fixtures\.invite\(admin, room\.id, member\)/g),
    ).toHaveLength(2);
    expect(journey.match(/fixtures\.join\(member, room\.id\)/g)).toHaveLength(
      3,
    );
    for (const selector of [
      'rail-rooms',
      'room-actions-overflow',
      'overflow-open-room-settings',
      'room-settings-tab-members',
      'member-info-role-50',
      'member-info-kick',
      'member-info-ban',
      'members-settings-banned',
      'banned-member-unban',
      'alert-confirm',
      'overflow-toggle-members',
      'member-info-close',
    ]) {
      expect(journey).toContain(`data-testid="${selector}"`);
    }
    expect(journey).toMatch(
      /await client\.key\('escape'\);\s*await client\.key\('escape'\);/,
    );
    expect(journey).toContain("client.key('enter')");
    expect(journey).toContain('await client.hideKeyboard()');
    expect(journey).toContain(
      'await client.tapCurrent(\'[data-testid="overflow-toggle-members"]\')',
    );
    expect(journey).toContain(
      "'[data-testid=\"member-info-role-50\"]',\n        '.member-info',",
    );
    expect(journey).toMatch(
      /const moderatorRow =\s*'\.members__section\[aria-label\^="Moderator"\] \[data-testid="member-row"\]';[\s\S]{0,180}?client\.scrollIntoViewIfNeeded\(\s*moderatorRow,\s*'\[data-testid="room-settings-detail"\]'/,
    );
    expect(client).toContain("const viewport = await this.visible('html');");
    expect(client).toMatch(
      /const visibleTop = Math\.max\(list\.rect\.y, 0\);[\s\S]{0,180}?const visibleBottom = Math\.min\(list\.rect\.bottom, viewport\.clientHeight\);/,
    );
    expect(client).toMatch(
      /async hideKeyboard\(\): Promise<void>[\s\S]{0,300}?- hideKeyboard/,
    );
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins exact role, live authority, moderation, and continuity outcomes', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.roleConfirmRoom[\s\S]{0,260}?\{ text: room\.name \}/,
    );
    expect(journey).toMatch(
      /assertions\.roleConfirmAccount[\s\S]{0,300}?\{ text: `Account \$\{admin\.userId\}` \}/,
    );
    expect(journey).toMatch(
      /assertions\.detailModerator[\s\S]{0,260}?\{ text: 'Moderator' \}/,
    );
    expect(journey).toMatch(
      /assertions\.kickAbsentAfterDemotion[\s\S]{0,180}?elements\.length === 0/,
    );
    expect(journey).toMatch(
      /assertions\.banAbsentAfterDemotion[\s\S]{0,180}?elements\.length === 0/,
    );
    expect(journey).toMatch(/target: assertions\.kickConfirmTarget/);
    expect(journey).toMatch(/room: assertions\.kickConfirmRoom/);
    expect(journey).toMatch(/account: assertions\.kickConfirmAccount/);
    expect(journey).toMatch(
      /async function assertConfirmation[\s\S]*?\{ text: memberName \}[\s\S]*?\{ text: roomName \}[\s\S]*?\{ text: `Account \$\{accountId\}` \}/,
    );
    expect(journey).toContain(
      "client.fill('[placeholder=\"Reason (optional)\"]', 'cleanup')",
    );
    expect(journey).toMatch(
      /assertions\.rowAbsentAfterKick[\s\S]{0,300}?'leave'/,
    );
    expect(journey).toMatch(/assertions\.rowAbsentAfterBan[\s\S]{0,300}?'ban'/);
    expect(journey).toMatch(/assertions\.bannedRowAbsent[\s\S]{0,300}?'leave'/);
    expect(journey).toMatch(/membership === expectedMembership/);
    expect(journey).toMatch(
      /assertions\.memberFilterFocused[\s\S]*?elements\[0\]!\.focused/,
    );
  });

  it('registers bounded lifecycle-owned execution and diagnostics', () => {
    const journey = readIfPresent(journeyPath);
    const project = readIfPresent(resolve(root, 'e2e/android/project.json'));
    const packageJson = readIfPresent(resolve(root, 'package.json'));
    const commands = readIfPresent(resolve(root, 'e2e/registry/commands.mts'));
    const runners = readIfPresent(
      resolve(root, 'e2e/registry/suites/runners.mts'),
    );
    const workflow = readIfPresent(resolve(root, '.github/workflows/ci.yml'));
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room roster live-authority Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room roster live-authority Android WebView'/,
    );
    expect(project).toContain('"room-roster-live-authority"');
    expect(packageJson).toContain('"e2e:android:room-roster-live-authority"');
    expect(commands).toContain("'android.room-roster-live-authority'");
    expect(runners).toContain("id: 'android.room-roster-live-authority'");
    expect(workflow).toContain('room-roster-live-authority-started=true');
    expect(workflow).toContain('surface: android-room-roster-live-authority');
  });
});
