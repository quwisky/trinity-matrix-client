import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitionSource =
  'e2e/browser/journeys/room-administration/room-access-settings.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';
const openSettingsTabSource = 'e2e/support/app.mts';
const contractPath = resolve(
  root,
  'e2e/android/room-access-policy-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/room-access-policy-journeys.mts',
);
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const directAssertionIds = [
  'admin.settings-visible',
  'admin.access-panel-initially-absent',
  'admin.general-panel-absent',
  'admin.section-heading-focused',
  'admin.aliases-absent',
  'admin.save-visible-scaled',
  'admin.save-focused',
  'admin.join-rule-public',
  'admin.history-world-readable',
  'admin.addresses-visible',
  'restricted.timeline-visible',
  'restricted.settings-visible',
  'restricted.space-option-visible',
  'restricted.join-rule',
  'restricted.allow',
  'revoke.timeline-visible',
  'revoke.dropped-option-visible',
  'revoke.allow',
  'member.join-rule-text',
  'member.history-text',
  'member.join-rule-read-only-message',
  'member.history-read-only-message',
  'member.actions-absent',
];
const helperAssertionIds = [
  'admin.room-timeline-visible',
  'admin.access-panel-visible',
  'restricted.access-panel-visible',
  'revoke.access-panel-visible',
  'member.room-timeline-visible',
  'member.access-panel-visible',
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

function expectSites(lines, from, to) {
  return lines
    .slice(from - 1, to)
    .filter((line) => /\bexpect(?:\.poll)?(?:\(|\s*$)/.test(line)).length;
}

describe('Android Room access policy migration', () => {
  it('pins four definitions, helper sources, and exactly 23 direct sites', () => {
    const definition = sourceLines(
      definitionSource,
      '3ae190d7814f8e3e2fda6640bcbfb77e089b1da8605b11645b7e79c2df0bcb6c',
    );
    const openRoom = sourceLines(
      openRoomSource,
      'bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7',
    );
    const openSettingsTab = sourceLines(
      openSettingsTabSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );

    expect(definition[19]).toContain(
      "test('an admin changes who can join and read history'",
    );
    expect(definition[136]).toBe('  });');
    expect(definition[138]).toContain(
      "test('an admin lets a space’s members join the room'",
    );
    expect(definition[214]).toBe('  });');
    expect(definition[216]).toContain(
      "test('an admin revokes a space’s access by unticking it'",
    );
    expect(definition[313]).toBe('  });');
    expect(definition[315]).toContain(
      "test('a member reads Room policy without a disabled Save footer'",
    );
    expect(definition[389]).toBe('  });');
    expect(expectSites(definition, 20, 137)).toBe(10);
    expect(expectSites(definition, 139, 215)).toBe(5);
    expect(expectSites(definition, 217, 314)).toBe(3);
    expect(expectSites(definition, 316, 390)).toBe(5);
    expect(openRoom[35]).toContain('export async function openRoom');
    expect(openRoom[43]).toBe('}');
    expect(expectSites(openRoom, 36, 44)).toBe(1);
    expect(openSettingsTab[227]).toContain(
      'export async function openSettingsTab',
    );
    expect(openSettingsTab[247]).toBe('}');
    expect(expectSites(openSettingsTab, 228, 248)).toBe(1);
    expect(
      definition.filter((line) => line.includes('await openRoom(')),
    ).toHaveLength(2);
    expect(
      definition.filter((line) => line.includes('await openSettingsTab(')),
    ).toHaveLength(5);
  });

  it('exports exact source mappings and stable 23+6 identities', async () => {
    expect(
      existsSync(contractPath),
      'room-access-policy-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ROOM_ACCESS_POLICY_SOURCES).toEqual({
      adminPublicHistory: `${definitionSource}:20-137`,
      restrictedSpace: `${definitionSource}:139-215`,
      revokeSpace: `${definitionSource}:217-314`,
      memberReadOnly: `${definitionSource}:316-390`,
      openRoom: `${openRoomSource}:36-44`,
      openSettingsTab: `${openSettingsTabSource}:228-248`,
    });
    expect(Object.values(contract.roomAccessPolicyHelperAssertions)).toEqual(
      helperAssertionIds,
    );
    expect(Object.values(contract.roomAccessPolicyDirectAssertions)).toEqual(
      directAssertionIds,
    );
    expect(Object.values(contract.roomAccessPolicyAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.roomAccessPolicyAssertions)).size,
    ).toBe(29);
  });

  it('implements four desktop stages through all 29 identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'room-access-policy-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('room-access-policy-contract.mts');
    for (const source of [
      'adminPublicHistory',
      'restrictedSpace',
      'revokeSpace',
      'memberReadOnly',
    ]) {
      expect(journey).toContain(`ROOM_ACCESS_POLICY_SOURCES.${source}`);
    }
    expect(journey.match(/profile: DESKTOP_ACCOUNT_PROFILE/g)).toHaveLength(4);
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?4,[\s\S]*?Exactly four Room access policy stages are required/,
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'adminRoomTimelineVisible',
      'adminAccessPanelVisible',
      'restrictedAccessPanelVisible',
      'revokeAccessPanelVisible',
      'memberRoomTimelineVisible',
      'memberAccessPanelVisible',
      'adminSettingsVisible',
      'adminAccessPanelInitiallyAbsent',
      'adminGeneralPanelAbsent',
      'adminSectionHeadingFocused',
      'adminAliasesAbsent',
      'adminSaveVisibleScaled',
      'adminSaveFocused',
      'adminJoinRulePublic',
      'adminHistoryWorldReadable',
      'adminAddressesVisible',
      'restrictedTimelineVisible',
      'restrictedSettingsVisible',
      'restrictedSpaceOptionVisible',
      'restrictedJoinRule',
      'restrictedAllow',
      'revokeTimelineVisible',
      'revokeDroppedOptionVisible',
      'revokeAllow',
      'memberJoinRuleText',
      'memberHistoryText',
      'memberJoinRuleReadOnlyMessage',
      'memberHistoryReadOnlyMessage',
      'memberActionsAbsent',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
  });

  it('uses bounded fixtures, native product actions, and reversible captures', () => {
    const journey = readIfPresent(journeyPath);
    const fixture = readFileSync(fixturePath, 'utf8');
    expect(fixture).toContain("readonly roomVersion?: '9'");
    expect(fixture).toContain('room_version: content.roomVersion');
    expect(journey.match(/roomVersion: '9'/g)).toHaveLength(2);
    expect(journey).toContain('fixtures.setSpaceChild(');
    expect(journey.match(/fixtures\.setSpaceChild\(/g)).toHaveLength(3);
    expect(journey).toContain("'m.room.join_rules'");
    expect(journey).toContain("'m.room.history_visibility'");
    expect(journey).toContain('withSpaceSettingsVisualFixture(');
    expect(journey).toContain("fontSize: '125%'");
    expect(journey).toContain("theme: 'amethyst'");
    expect(journey).toContain(
      "client.capture('room-access-admin-light-text-scale')",
    );
    expect(journey).toContain(
      "client.capture('room-access-admin-dark-amethyst')",
    );
    expect(journey).toContain("client.capture('room-access-member-read-only')");
    for (const selector of [
      'rail-rooms',
      'open-room-settings',
      'room-settings-tab-access',
      'room-settings-tab-addresses',
      'room-settings-join-rule',
      'join-rule-public',
      'join-rule-restricted',
      'room-settings-history',
      'history-world_readable',
      'room-settings-save',
    ]) {
      expect(journey).toContain(`data-testid="${selector}"`);
    }
    expect(journey).toContain("client.key('enter')");
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins exact server and read-only outcomes', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.adminJoinRulePublic[\s\S]{0,360}?value\?\.\['join_rule'\] === 'public'/,
    );
    expect(journey).toMatch(
      /assertions\.adminHistoryWorldReadable[\s\S]{0,380}?value\?\.\['history_visibility'\] === 'world_readable'/,
    );
    expect(journey).toContain("join_rule: 'restricted'");
    expect(journey).toContain("type: 'm.room_membership'");
    expect(journey).toContain("type: 'org.example.membership_claim'");
    expect(journey).toContain("issuer: 'example.org'");
    expect(journey).toContain("import { isDeepStrictEqual } from 'node:util'");
    expect(journey).toMatch(
      /function sameJson[\s\S]{0,180}?return isDeepStrictEqual\(value, expected\)/,
    );
    expect(journey).not.toContain('JSON.stringify(value)');
    expect(
      journey.match(/sameJson\(value\?\.\['allow'\], expectedAllow\)/g),
    ).toHaveLength(2);
    expect(journey).toMatch(
      /assertions\.memberJoinRuleText[\s\S]{0,300}?exactText: 'Invite only'/,
    );
    expect(journey).toMatch(
      /assertions\.memberHistoryText[\s\S]{0,320}?exactText: 'Members — since they joined'/,
    );
    expect(journey).toContain("Your role cannot change this room's join rule.");
    expect(journey).toContain(
      "Your role cannot change this room's history visibility.",
    );
    expect(journey.match(/'\.room-settings__restriction'/g)).toHaveLength(2);
    expect(journey).toMatch(
      /assertions\.memberActionsAbsent[\s\S]{0,260}?elements\.length === 0/,
    );
  });

  it('owns one-attempt diagnostics, redaction, cleanup, and registration', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room access policy Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room access policy Android WebView'/,
    );
    expect(readFileSync(resolve(root, 'package.json'), 'utf8')).toContain(
      'e2e:android:room-access-policy',
    );
    expect(
      readFileSync(resolve(root, 'e2e/android/project.json'), 'utf8'),
    ).toContain('android.room-access-policy');
    expect(
      readFileSync(resolve(root, 'e2e/registry/suites/runners.mts'), 'utf8'),
    ).toContain("id: 'android.room-access-policy'");
    expect(
      readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
    ).toContain('android-room-access-policy');
  });
});
