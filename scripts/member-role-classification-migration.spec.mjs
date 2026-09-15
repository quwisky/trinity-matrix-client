import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const source = 'e2e/browser/journeys/room-administration/member-roles.spec.mts';
const contractPath = resolve(
  root,
  'e2e/android/member-role-classification-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/member-role-classification-journeys.mts',
);
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const assertionIds = [
  'open-members.room-timeline-visible',
  'open-members.roster-initially-hidden',
  'open-members.roster-visible',
  'grouping.member-count',
  'grouping.section-labels',
  'grouping.header-heights',
  'grouping.row-heights',
  'grouping.group-labels',
  'grouping.owner-member',
  'grouping.moderator-member',
  'grouping.plain-member',
  'grouping.moderator-name',
  'direct-message.room-timeline-visible',
  'direct-message.roster-initially-hidden',
  'direct-message.roster-visible',
  'direct-message.member-count',
  'direct-message.admin-section',
  'direct-message.owner-absent',
  'direct-message.panel-visible',
  'direct-message.role-admin',
  'owner-panel.member-count',
  'owner-panel.panel-visible',
  'owner-panel.role-owner',
  'owner-admin.member-count',
  'owner-admin.section-labels',
  'owner-admin.owner-member',
  'owner-admin.admin-member',
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
  /\bdocument\.(?:createElement|write|writeln)\s*\(/,
  /\.(?:append|appendChild|prepend|remove|removeChild|replaceChildren)\s*\(/,
  /(?:documentElement|body|host|element|node)\.(?:style|classList|setAttribute|removeAttribute)/,
  /Page\.navigate/,
];

describe('Android member role classification migration', () => {
  it('pins the canonical helper, four definitions, and all 27 assertion sites', () => {
    const contents = readFileSync(resolve(root, source));
    const lines = contents.toString('utf8').split('\n');
    expect(createHash('sha256').update(contents).digest('hex')).toBe(
      '58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f',
    );
    expect(lines[172]).toContain('async function openRoomWithMembers');
    expect(lines[192]).toBe('}');
    expect(lines[204]).toContain(
      "test('groups members under Owner / Moderator / Member headers'",
    );
    expect(lines[280]).toBe('  });');
    expect(lines[282]).toContain(
      "test('a direct message has no owner — both people are equals'",
    );
    expect(lines[360]).toBe('  });');
    expect(lines[362]).toContain(
      "test('the member info panel calls the creator the owner'",
    );
    expect(lines[392]).toBe('  });');
    expect(lines[394]).toContain(
      "test('separates the creator from an admin they promoted'",
    );
    expect(lines[432]).toBe('  });');

    const expectSites = (from, to) =>
      lines.slice(from - 1, to).filter((line) => line.includes('expect('))
        .length;
    expect(expectSites(173, 193)).toBe(3);
    expect(expectSites(205, 281)).toBe(9);
    expect(expectSites(283, 361)).toBe(8);
    expect(expectSites(363, 393)).toBe(3);
    expect(expectSites(395, 433)).toBe(4);
  });

  it('exports exact source mappings and exactly 27 stable identities', async () => {
    expect(
      existsSync(contractPath),
      'member-role-classification-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.MEMBER_ROLE_CLASSIFICATION_SOURCES).toEqual({
      sharedHelper: `${source}:173-193`,
      grouping: `${source}:205-281`,
      directMessage: `${source}:283-361`,
      ownerPanel: `${source}:363-393`,
      ownerAdmin: `${source}:395-433`,
    });
    expect(Object.values(contract.memberRoleClassificationAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.memberRoleClassificationAssertions)).size,
    ).toBe(27);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?27,[\s\S]*?Exactly 27 member role classification assertion identities are required/,
    );
  });

  it('implements four Pixel 5 stages and records each identity through the contract', () => {
    const journey = readIfPresent(journeyPath);
    expect(
      journey,
      'member-role-classification-journeys.mts must exist',
    ).not.toBe('');
    expect(journey).toContain('member-role-classification-contract.mts');
    for (const sourceKey of [
      'grouping',
      'directMessage',
      'ownerPanel',
      'ownerAdmin',
    ]) {
      expect(journey).toContain(
        `MEMBER_ROLE_CLASSIFICATION_SOURCES.${sourceKey}`,
      );
    }
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?4,[\s\S]*?Exactly four member role classification stages are required/,
    );
    for (const key of [
      'openMembersRoomTimelineVisible',
      'openMembersRosterInitiallyHidden',
      'openMembersRosterVisible',
      'groupingMemberCount',
      'groupingSectionLabels',
      'groupingHeaderHeights',
      'groupingRowHeights',
      'groupingGroupLabels',
      'groupingOwnerMember',
      'groupingModeratorMember',
      'groupingPlainMember',
      'groupingModeratorName',
      'directMessageRoomTimelineVisible',
      'directMessageRosterInitiallyHidden',
      'directMessageRosterVisible',
      'directMessageMemberCount',
      'directMessageAdminSection',
      'directMessageOwnerAbsent',
      'directMessagePanelVisible',
      'directMessageRoleAdmin',
      'ownerPanelMemberCount',
      'ownerPanelPanelVisible',
      'ownerPanelRoleOwner',
      'ownerAdminMemberCount',
      'ownerAdminSectionLabels',
      'ownerAdminOwnerMember',
      'ownerAdminAdminMember',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('uses real role fixtures, trusted direct-message state, and compact native navigation', () => {
    const journey = readIfPresent(journeyPath);
    const fixture = readIfPresent(fixturePath);
    expect(journey).toContain('fixtures.setDisplayName(');
    expect(journey).toContain('fixtures.setRoomPower(');
    expect(journey).toContain('fixtures.createDirectRoom(');
    expect(journey).toContain("preset: 'trusted_private_chat'");
    expect(fixture).toContain("'trusted_private_chat'");
    expect(journey).toContain(
      'openMembers(client, themName, directMessageOpenAssertions, false)',
    );
    expect(journey).toMatch(
      /stageAssertions\.roomTimelineVisible,[\s\S]*?'\.scroll',[\s\S]*?visibleOne/,
    );
    expect(journey).toMatch(
      /stageAssertions\.rosterVisible,[\s\S]*?'\[data-testid="member-list"\]',[\s\S]*?visibleOne/,
    );
    expect(journey).toContain('client.login(');
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

  it('binds grouping identities to exact order, accessibility, geometry, and people', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.groupingSectionLabels[\s\S]*?Owner — 1[\s\S]*?Moderator — 1[\s\S]*?Member — 1/,
    );
    expect(journey).toMatch(
      /assertions\.groupingHeaderHeights[\s\S]*?\[34, 34, 34\]/,
    );
    expect(journey).toMatch(
      /assertions\.groupingRowHeights[\s\S]*?\[44, 44, 44\]/,
    );
    expect(journey).toMatch(
      /assertions\.groupingGroupLabels[\s\S]*?Owner, 1 member[\s\S]*?Moderator, 1 member[\s\S]*?Member, 1 member/,
    );
    for (const key of [
      'groupingOwnerMember',
      'groupingModeratorMember',
      'groupingPlainMember',
      'groupingModeratorName',
    ]) {
      expect(journey).toMatch(
        new RegExp(`assertions\\.${key}[\\s\\S]*?member-row`),
      );
    }
  });

  it('proves trusted-DM equality, creator ownership, owner/admin separation, and lifecycle evidence', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.directMessageAdminSection[\s\S]*?Admin — 2/,
    );
    expect(journey).toMatch(
      /assertions\.directMessageOwnerAbsent[\s\S]*?elements\.length === 0/,
    );
    expect(journey).toMatch(
      /assertions\.directMessageRoleAdmin[\s\S]*?member-info-role[\s\S]*?Admin/,
    );
    expect(journey).toMatch(
      /assertions\.ownerPanelRoleOwner[\s\S]*?member-info-role[\s\S]*?Owner/,
    );
    expect(journey).toMatch(
      /assertions\.ownerAdminSectionLabels[\s\S]*?Owner — 1[\s\S]*?Admin — 1/,
    );
    expect(journey).toContain(
      "exactVisibleTexts(elements, ['Owner — 1', 'Admin — 1'])",
    );
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey.indexOf('await save();')).toBeLessThan(
      journey.indexOf('await openMaestroDevice({'),
    );
    expect(journey.indexOf('await openMaestroDevice({')).toBeLessThan(
      journey.indexOf('await device.install('),
    );
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain(
      "stage.status = failures.length ? 'failed' : 'passed'",
    );
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toMatch(
      /try \{\s*await save\(\);\s*\} catch \(error\) \{\s*failures\.push\(error\);\s*\}/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Member role classification Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Member role classification Android WebView'/,
    );
  });
});
