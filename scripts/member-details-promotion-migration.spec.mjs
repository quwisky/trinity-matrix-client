import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const memberInfoSource =
  'e2e/browser/journeys/room-administration/member-info.spec.mts';
const promotionSource =
  'e2e/browser/journeys/room-administration/promote-member.spec.mts';
const contractPath = resolve(
  root,
  'e2e/android/member-details-promotion-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/member-details-promotion-journeys.mts',
);
const pasteFlowPath = resolve(
  root,
  'e2e/android/flows/accounts-focused-paste.yaml',
);
const clientPath = resolve(root, 'e2e/android/account-workspace-client.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const assertionIds = [
  'member-info.room-timeline-visible',
  'member-info.members-panel-visible',
  'member-info.members-initially-hidden',
  'member-info.row-height',
  'member-info.header-height',
  'member-info.panel-visible',
  'member-info.name',
  'member-info.handle',
  'member-info.role',
  'member-info.message-action-visible',
  'member-info.surface-display',
  'member-info.surface-opaque',
  'member-info.surface-row-positive',
  'member-info.surface-full-height',
  'member-info.copy-toast',
  'member-info.clipboard-mxid',
  'member-info.panel-closed',
  'member-info.roster-restored',
  'promotion.room-timeline-visible',
  'promotion.members-initially-hidden',
  'promotion.members-panel-visible',
  'promotion.moderator-absent',
  'promotion.member-info-visible',
  'promotion.moderator-section-visible',
  'promotion.member-row-and-server-power',
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

describe('Android member details and promotion migration', () => {
  it('pins both canonical sources, helpers, titles, and all direct assertion sites', () => {
    const memberInfo = readFileSync(resolve(root, memberInfoSource));
    const promotion = readFileSync(resolve(root, promotionSource));
    const memberInfoLines = memberInfo.toString('utf8').split('\n');
    const promotionLines = promotion.toString('utf8').split('\n');

    expect(createHash('sha256').update(memberInfo).digest('hex')).toBe(
      'cca86e8d3c5925ff2358e6efbcf229ca4f32095379385d9539698dedd1c2200d',
    );
    expect(createHash('sha256').update(promotion).digest('hex')).toBe(
      '649c05090a92bf48036530ea3738c55ad40f0ebc06a0200745e48b3b6903f7c3',
    );
    expect(memberInfoLines[48]).toContain('async function openRoom');
    expect(memberInfoLines[56]).toBe('}');
    expect(memberInfoLines[58]).toContain('async function openMembers');
    expect(memberInfoLines[67]).toBe('}');
    expect(memberInfoLines[72]).toContain(
      "test('clicking a member opens their info panel'",
    );
    expect(memberInfoLines[217]).toBe('  });');
    expect(promotionLines[48]).toContain('async function openRoom');
    expect(promotionLines[56]).toBe('}');
    expect(promotionLines[61]).toContain(
      "test('an admin promotes a member to moderator'",
    );
    expect(promotionLines[133]).toBe('  });');

    const directExpectSites = (lines) =>
      lines.filter((line) => line.includes('expect(')).length;
    expect(
      directExpectSites([
        ...memberInfoLines.slice(48, 57),
        ...memberInfoLines.slice(58, 68),
        ...memberInfoLines.slice(72, 218),
      ]),
    ).toBe(18);
    expect(
      directExpectSites([
        ...promotionLines.slice(48, 57),
        ...promotionLines.slice(61, 134),
      ]),
    ).toBe(7);
  });

  it('exports exact source mappings and exactly 25 stable identities', async () => {
    expect(
      existsSync(contractPath),
      'member-details-promotion-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);

    expect(contract.MEMBER_DETAILS_PROMOTION_SOURCES).toEqual({
      memberInfo: {
        roomHelper: `${memberInfoSource}:49-57`,
        membersHelper: `${memberInfoSource}:59-68`,
        definition: `${memberInfoSource}:73-218`,
      },
      promotion: {
        roomHelper: `${promotionSource}:49-57`,
        definition: `${promotionSource}:62-134`,
      },
    });
    expect(Object.values(contract.memberDetailsPromotionAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.memberDetailsPromotionAssertions)).size,
    ).toBe(25);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?25,[\s\S]*?Exactly 25 member details and promotion assertion identities are required/,
    );
  });

  it('implements two Pixel 5 stages and records every identity through the contract', () => {
    const journey = readIfPresent(journeyPath);

    expect(
      journey,
      'member-details-promotion-journeys.mts must exist',
    ).not.toBe('');
    expect(journey).toContain('member-details-promotion-contract.mts');
    expect(journey).toContain(
      'MEMBER_DETAILS_PROMOTION_SOURCES.memberInfo.definition',
    );
    expect(journey).toContain(
      'MEMBER_DETAILS_PROMOTION_SOURCES.promotion.definition',
    );
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?2,[\s\S]*?Exactly two member details and promotion stages are required/,
    );
    for (const key of [
      'memberInfoRoomTimelineVisible',
      'memberInfoMembersPanelVisible',
      'memberInfoMembersInitiallyHidden',
      'memberInfoRowHeight',
      'memberInfoHeaderHeight',
      'memberInfoPanelVisible',
      'memberInfoName',
      'memberInfoHandle',
      'memberInfoRole',
      'memberInfoMessageActionVisible',
      'memberInfoSurfaceDisplay',
      'memberInfoSurfaceOpaque',
      'memberInfoSurfaceRowPositive',
      'memberInfoSurfaceFullHeight',
      'memberInfoCopyToast',
      'memberInfoClipboardMxid',
      'memberInfoPanelClosed',
      'memberInfoRosterRestored',
      'promotionRoomTimelineVisible',
      'promotionMembersInitiallyHidden',
      'promotionMembersPanelVisible',
      'promotionModeratorAbsent',
      'promotionMemberInfoVisible',
      'promotionModeratorSectionVisible',
      'promotionMemberRowAndServerPower',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('seeds exact fixtures and uses compact native navigation', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain('invite: [member.userId]');
    expect(journey).toContain('fixtures.setDisplayName(member, memberName)');
    expect(journey).toContain('fixtures.join(member, room.id)');
    expect(journey).toContain('client.login(fixture.admin)');
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
    expect(journey).toContain(
      'stageAssertions.membersPanelVisible,\n    \'[data-testid="member-list"]\',\n    visibleOne,',
    );
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('binds member details identities to exact geometry, content, and surface observations', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.memberInfoRowHeight,[\s\S]*?'\[data-testid="member-row"\]'[\s\S]*?elements\[0\]!\.rect\.height === 44/,
    );
    expect(journey).toMatch(
      /assertions\.memberInfoHeaderHeight,[\s\S]*?'\.members__section-label'[\s\S]*?elements\[0\]!\.rect\.height === 34/,
    );
    expect(journey).toMatch(
      /assertions\.memberInfoName,[\s\S]*?'\[data-testid="member-info-name"\]'[\s\S]*?exactText: fixture\.memberName/,
    );
    expect(journey).toMatch(
      /assertions\.memberInfoHandle,[\s\S]*?'\[data-testid="member-info-handle"\]'[\s\S]*?exactText: fixture\.member\.userId/,
    );
    expect(journey).toMatch(
      /assertions\.memberInfoRole,[\s\S]*?'\[data-testid="member-info"\]'[\s\S]*?text: 'Member'/,
    );
    expect(journey).toMatch(
      /assertions\.memberInfoMessageActionVisible,[\s\S]*?'\[data-testid="member-info-message"\]'/,
    );
    expect(journey).toContain("document.querySelector('trn-member-info')");
    expect(journey).toContain('getComputedStyle(host)');
    expect(journey).toContain("display === 'flex'");
    expect(journey).toContain(
      '!/rgba\\(0, 0, 0, 0\\)|transparent/.test(background)',
    );
    expect(journey).toContain('row > 0');
    expect(journey).toContain('Math.abs(height - viewport) <= 1');
  });

  it('uses the native foreground clipboard without replacing or probing it', () => {
    const journey = readIfPresent(journeyPath);
    const client = readIfPresent(clientPath);
    const flow = readIfPresent(pasteFlowPath);

    expect(journey).toMatch(
      /exactFeedbackDuringNativeAction\([\s\S]*?assertions\.memberInfoCopyToast,[\s\S]*?'User ID copied\.',[\s\S]*?client\.tapCurrent\('\[data-testid="member-info-copy"\]'\)/,
    );
    expect(journey).toContain('new MutationObserver(sample)');
    expect(journey).toContain('window[capture]?.observer?.disconnect()');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="member-info-close"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="composer-input"]\')',
    );
    expect(journey).toMatch(
      /client\.pasteSystemClipboardFocused\([\s\S]*?'\[data-testid="composer-input"\]'[\s\S]*?\)/,
    );
    expect(journey).toMatch(
      /assertions\.memberInfoClipboardMxid,[\s\S]*?'\[data-testid="composer-input"\]'[\s\S]*?element\.value === fixture\.member\.userId/,
    );
    expect(client).toContain('async pasteSystemClipboardFocused(');
    expect(client).toContain('accounts-focused-paste.yaml');
    expect(client).toContain('e instanceof HTMLTextAreaElement');
    expect(flow).toBe(
      'appId: ${APP_ID}\n---\n- hideKeyboard\n- evalScript: ${output.pointResponse = http.get(POINT_URL)}\n- assertTrue: ${output.pointResponse.status === 200}\n- longPressOn:\n    point: ${output.pointResponse.body}\n- tapOn: Paste\n- hideKeyboard\n',
    );
    expect(`${journey}\n${client}\n${flow}`).not.toContain('setClipboard');
    expect(`${journey}\n${client}\n${flow}`).not.toContain('- pasteText');
    expect(journey).not.toContain('clipboard-probe');
  });

  it('promotes natively, proves the regrouped row and exact server power, then preserves lifecycle evidence', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.promotionModeratorAbsent,[\s\S]*?'\.members__section-label'[\s\S]*?elements\.length === 0[\s\S]*?text: 'Moderator'/,
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="member-info-role-50"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="alert-confirm"]\')',
    );
    expect(journey).toContain('fixtures.roomState(');
    expect(journey).toContain("'m.room.power_levels'");
    expect(journey).toContain('power === 50');
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
      /matrixResources\.cleanup\(\s*'Member details and promotion Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Member details and promotion Android WebView'/,
    );
  });
});
