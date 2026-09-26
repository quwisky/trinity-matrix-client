import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const source = 'e2e/browser/journeys/room-administration/member-roles.spec.mts';
const contractPath = resolve(
  root,
  'e2e/android/member-role-live-updates-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/member-role-live-updates-journeys.mts',
);
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const assertionIds = [
  'live-promotion.member-count',
  'live-promotion.initial-section-labels',
  'live-promotion.final-section-labels',
  'live-promotion.moderator-member',
  'permission-loss.kick-initially-enabled',
  'permission-loss.kick-disabled',
  'permission-loss.kick-description',
  'permission-loss.tooltip',
  'permission-loss.remove-dialog-absent',
  'permission-loss.invite-disabled',
  'permission-loss.invite-dialog-absent',
  'settings-demotion.surface-visible',
  'settings-demotion.name-initially-enabled',
  'settings-demotion.name-text',
  'settings-demotion.name-paragraph',
  'settings-demotion.general-actions-absent',
  'settings-demotion.aliases-read-only',
  'settings-demotion.alias-input-absent',
  'settings-demotion.alias-add-absent',
  'settings-demotion.alias-set-main-absent',
  'settings-demotion.alias-remove-absent',
  'touch-feedback.kick-disabled',
  'touch-feedback.kick-visible',
  'touch-feedback.exact-copy',
  'touch-feedback.remove-dialog-absent',
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

describe('Android member role live updates migration', () => {
  it('pins four definitions and exactly 25 newly owned assertion sites', () => {
    const contents = readFileSync(resolve(root, source));
    const lines = contents.toString('utf8').split('\n');
    expect(createHash('sha256').update(contents).digest('hex')).toBe(
      '58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f',
    );
    expect(lines[172]).toContain('async function openRoomWithMembers');
    expect(lines[192]).toBe('}');
    expect(lines[434]).toContain(
      "test('re-partitions live when a member is promoted to moderator'",
    );
    expect(lines[479]).toBe('  });');
    expect(lines[481]).toContain(
      "test('disables member actions live when the viewer loses power'",
    );
    expect(lines[542]).toBe('  });');
    expect(lines[544]).toContain(
      "test('shows plain General values after remote demotion'",
    );
    expect(lines[582]).toBe('  });');
    expect(lines[589]).toContain(
      "test('explains a blocked member action after a touch tap'",
    );
    expect(lines[625]).toBe('  });');

    const expectSites = (from, to) =>
      lines
        .slice(from - 1, to)
        .filter((line) => /\bexpect(?:\(|\s*$)/.test(line)).length;
    expect(expectSites(173, 193)).toBe(3);
    expect(expectSites(435, 480)).toBe(4);
    expect(expectSites(482, 543)).toBe(7);
    expect(expectSites(545, 583)).toBe(10);
    expect(expectSites(590, 626)).toBe(4);
  });

  it('exports exact mappings and exactly 25 stable direct identities', async () => {
    expect(
      existsSync(contractPath),
      'member-role-live-updates-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.MEMBER_ROLE_LIVE_UPDATE_SOURCES).toEqual({
      sharedHelper: `${source}:173-193`,
      livePromotion: `${source}:435-480`,
      permissionLoss: `${source}:482-543`,
      settingsDemotion: `${source}:545-583`,
      touchFeedback: `${source}:590-626`,
    });
    expect(Object.values(contract.memberRoleLiveUpdateAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.memberRoleLiveUpdateAssertions)).size,
    ).toBe(25);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?25,[\s\S]*?Exactly 25 member role live-update assertion identities are required/,
    );
  });

  it('implements four Pixel 5 stages through contract identities and inherited readiness', () => {
    const journey = readIfPresent(journeyPath);
    expect(
      journey,
      'member-role-live-updates-journeys.mts must exist',
    ).not.toBe('');
    expect(journey).toContain('member-role-live-updates-contract.mts');
    expect(journey).toContain('member-role-classification-contract.mts');
    for (const sourceKey of [
      'livePromotion',
      'permissionLoss',
      'settingsDemotion',
      'touchFeedback',
    ]) {
      expect(journey).toContain(`MEMBER_ROLE_LIVE_UPDATE_SOURCES.${sourceKey}`);
    }
    for (const inheritedKey of [
      'openMembersRoomTimelineVisible',
      'openMembersRosterInitiallyHidden',
      'openMembersRosterVisible',
    ]) {
      expect(journey).toMatch(
        new RegExp(`inheritedAssertions\\.${inheritedKey}\\b`),
      );
    }
    expect(journey).toMatch(
      /inheritedAssertions\.openMembersRoomTimelineVisible,[\s\S]{0,160}?'\.scroll'/,
    );
    expect(journey).toMatch(
      /inheritedAssertions\.openMembersRosterInitiallyHidden,[\s\S]{0,160}?'.chat-members'/,
    );
    expect(journey).toMatch(
      /inheritedAssertions\.openMembersRosterVisible,[\s\S]{0,160}?'\[data-testid="member-list"\]'/,
    );
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?4,[\s\S]*?Exactly four member role live-update stages are required/,
    );
    for (const key of [
      'livePromotionMemberCount',
      'livePromotionInitialSectionLabels',
      'livePromotionFinalSectionLabels',
      'livePromotionModeratorMember',
      'permissionLossKickInitiallyEnabled',
      'permissionLossKickDisabled',
      'permissionLossKickDescription',
      'permissionLossTooltip',
      'permissionLossRemoveDialogAbsent',
      'permissionLossInviteDisabled',
      'permissionLossInviteDialogAbsent',
      'settingsDemotionSurfaceVisible',
      'settingsDemotionNameInitiallyEnabled',
      'settingsDemotionNameText',
      'settingsDemotionNameParagraph',
      'settingsDemotionGeneralActionsAbsent',
      'settingsDemotionAliasesReadOnly',
      'settingsDemotionAliasInputAbsent',
      'settingsDemotionAliasAddAbsent',
      'settingsDemotionAliasSetMainAbsent',
      'settingsDemotionAliasRemoveAbsent',
      'touchFeedbackKickDisabled',
      'touchFeedbackKickVisible',
      'touchFeedbackExactCopy',
      'touchFeedbackRemoveDialogAbsent',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('uses exact remote transitions and native navigation, focus, keys, and touch', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('fixtures.setRoomPower(');
    expect(journey).toMatch(
      /fixtures\.setRoomState\([\s\S]{0,300}?'m\.room\.power_levels'[\s\S]{0,300}?invite: 50/,
    );
    expect(journey).toMatch(
      /fixtures\.setRoomPower\(\s*fixture\.owner,\s*fixture\.room\.id,\s*fixture\.member\.userId,\s*50,\s*\)[\s\S]*?assertions\.livePromotionFinalSectionLabels/,
    );
    expect(journey).toMatch(/fixtures\.setRoomPower\([\s\S]*?userId,[\s\S]*?0/);
    expect(journey).toContain('focusByNativeTab(');
    expect(journey).toContain("client.key('tab')");
    expect(journey).toContain("client.key('enter')");
    expect(journey).toContain("client.key('space')");
    expect(journey).toContain(
      "client.device.adb('shell', 'input', 'keyevent', '4')",
    );
    expect(
      journey.match(
        /client\.device\.adb\('shell', 'input', 'keyevent', '4'\)/g,
      ),
    ).toHaveLength(2);
    expect(
      journey.match(/await dismissCompactRoster\(client\);/g),
    ).toHaveLength(2);
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="member-info-kick"]\')',
    );
    expect(journey).toContain('await Promise.allSettled(operations)');
    expect(journey).toMatch(
      /await settleConcurrentOperations\(\[\s*client\.tapCurrent\('\[data-testid="member-info-kick"\]'\),\s*observedElements\([\s\S]{0,300}?assertions\.touchFeedbackExactCopy/,
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(journey).toContain("client.tapCurrent('.channel'");
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="room-actions-overflow"]\')',
    );
    expect(journey).toMatch(
      /member-info-close[\s\S]{0,500}?member-info[\s\S]{0,500}?dismissCompactRoster\(client\)/,
    );
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins exact live, read-only settings, and blocked-action outcomes', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.livePromotionInitialSectionLabels[\s\S]*?Owner — 1[\s\S]*?Member — 1/,
    );
    expect(journey).toMatch(
      /assertions\.livePromotionFinalSectionLabels[\s\S]*?Owner — 1[\s\S]*?Moderator — 1/,
    );
    expect(journey).toMatch(
      /assertions\.permissionLossKickDisabled[\s\S]*?aria-disabled[\s\S]*?true/,
    );
    expect(journey).toMatch(
      /assertions\.permissionLossKickDescription[\s\S]*?You can only manage members with a lower role\./,
    );
    expect(journey).toMatch(
      /assertions\.permissionLossRemoveDialogAbsent[\s\S]{0,300}?elements\.length === 0/,
    );
    expect(journey).toMatch(
      /assertions\.permissionLossInviteDialogAbsent[\s\S]{0,300}?elements\.length === 0/,
    );
    expect(journey).toMatch(
      /assertions\.settingsDemotionNameParagraph[\s\S]*?tagName[\s\S]*?=== 'P'/,
    );
    expect(journey).toContain("Your role cannot change this room's addresses.");
    expect(journey).toMatch(
      /assertions\.touchFeedbackExactCopy[\s\S]*?You can only manage members with a lower role\./,
    );
    expect(journey).toMatch(
      /assertions\.touchFeedbackRemoveDialogAbsent[\s\S]{0,300}?elements\.length === 0/,
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
      /matrixResources\.cleanup\(\s*'Member role live updates Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Member role live updates Android WebView'/,
    );
    expect(project).toContain('"member-role-live-updates"');
    expect(packageJson).toContain('"e2e:android:member-role-live-updates"');
    expect(commands).toContain("'android.member-role-live-updates'");
    expect(runners).toContain("id: 'android.member-role-live-updates'");
    expect(workflow).toContain('member-role-live-updates-started=true');
    expect(workflow).toContain('surface: android-member-role-live-updates');
  });
});
