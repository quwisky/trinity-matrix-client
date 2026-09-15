import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitionSource =
  'e2e/browser/journeys/room-administration/room-profile-settings.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';
const contractPath = resolve(
  root,
  'e2e/android/room-profile-settings-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/room-profile-settings-journeys.mts',
);
const transitionPath = resolve(
  root,
  'e2e/android/room-profile-settings-account-transition.mts',
);
const pickerPath = resolve(root, 'e2e/android/maestro-document-picker.mts');
const accountClientPath = resolve(
  root,
  'e2e/android/account-workspace-client.mts',
);
const faultPath = resolve(root, 'e2e/android/matrix-http-fault.mts');
const predecessor = readFileSync(resolve(root, definitionSource), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const helperAssertionIds = [
  'rename.prior-room-timeline-visible',
  'rename.original-room-timeline-visible',
  'photo.room-timeline-visible',
  'partial.room-timeline-visible',
  'continuity.room-timeline-visible',
];
const directAssertionIds = [
  'rename.settings-visible',
  'rename.directory-visible',
  'rename.opening-account',
  'rename.heading-focused',
  'rename.desktop-width-minimum',
  'rename.desktop-width-maximum',
  'rename.compact-directory-hidden',
  'rename.compact-back-visible',
  'rename.compact-general-visible',
  'rename.desktop-directory-restored',
  'rename.desktop-back-hidden',
  'rename.scaled-cancel-visible',
  'rename.scaled-actions-absent',
  'rename.back-discard-visible',
  'rename.back-draft-retained',
  'rename.tab-discard-visible',
  'rename.tab-draft-retained',
  'rename.general-panel-retained',
  'rename.new-channel-visible',
  'rename.old-channel-absent',
  'photo.settings-visible',
  'photo.updated',
  'partial.failure-feedback',
  'partial.name-first-attempts',
  'partial.topic-first-attempts',
  'partial.retry-feedback',
  'partial.name-total-attempts',
  'partial.topic-total-attempts',
  'continuity.opening-account',
  'continuity.name-saving',
  'continuity.member-row-visible',
  'continuity.active-member',
  'continuity.account-retained',
  'continuity.name-saved',
  'continuity.topic-saved',
  'continuity.topic-persisted',
];
const assertionIds = [...helperAssertionIds, ...directAssertionIds];
const forbiddenJourneyMutations = [
  /\.click\s*\(/,
  /\.focus\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.(?:requestSubmit|submit)\s*\(/,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/,
  /\blocation\.(?:assign|replace|reload)\s*\(/,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/,
  /\bwindow\.open\s*\(/,
  /client\.(?:focusFixture|navigate|reload)\s*\(/,
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

describe('Android Room profile settings migration', () => {
  it('pins four definitions, the openRoom helper, and exactly 36 direct sites', () => {
    const definition = sourceLines(
      definitionSource,
      'f6ab33a1fc7160efb206c66f064ab158cea1c3969ad6ee5a55b8eb39299d1f96',
    );
    const openRoom = sourceLines(
      openRoomSource,
      'bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7',
    );

    expect(definition[15]).toContain(
      "test('an admin renames a room from the settings dialog'",
    );
    expect(definition[150]).toBe('  });');
    expect(definition[152]).toContain("test('an admin changes the room photo'");
    expect(definition[196]).toBe('  });');
    expect(definition[198]).toContain(
      "test('retains a partial General failure and retries only the unsaved field'",
    );
    expect(definition[255]).toBe('  });');
    expect(definition[257]).toContain(
      "test('keeps late and subsequent General writes on the opening Account after a shared-Room switch'",
    );
    expect(definition[357]).toBe('  });');
    expect(expectSites(definition, 16, 151)).toBe(20);
    expect(expectSites(definition, 153, 197)).toBe(2);
    expect(expectSites(definition, 199, 256)).toBe(6);
    expect(expectSites(definition, 258, 358)).toBe(8);
    expect(openRoom[35]).toContain('export async function openRoom');
    expect(openRoom[43]).toBe('}');
    expect(expectSites(openRoom, 36, 44)).toBe(1);
    expect(
      definition.filter((line) => line.includes('await openRoom(')),
    ).toHaveLength(5);
  });

  it('exports exact source mappings and stable 36+5 identities', async () => {
    expect(
      existsSync(contractPath),
      'room-profile-settings-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ROOM_PROFILE_SETTINGS_SOURCES).toEqual({
      rename: `${definitionSource}:16-151`,
      photo: `${definitionSource}:153-197`,
      partialFailure: `${definitionSource}:199-256`,
      accountContinuity: `${definitionSource}:258-358`,
      openRoom: `${openRoomSource}:36-44`,
      blockedAccountTransition: `${definitionSource}:324-335`,
    });
    expect(Object.values(contract.roomProfileSettingsHelperAssertions)).toEqual(
      helperAssertionIds,
    );
    expect(Object.values(contract.roomProfileSettingsDirectAssertions)).toEqual(
      directAssertionIds,
    );
    expect(Object.values(contract.roomProfileSettingsAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.roomProfileSettingsAssertions)).size,
    ).toBe(41);
  });

  it('implements four desktop stages through all 41 identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'room-profile-settings-journeys.mts must exist').not.toBe(
      '',
    );
    expect(journey).toContain('room-profile-settings-contract.mts');
    for (const source of [
      'rename',
      'photo',
      'partialFailure',
      'accountContinuity',
    ]) {
      expect(journey).toContain(`ROOM_PROFILE_SETTINGS_SOURCES.${source}`);
    }
    expect(journey.match(/profile: DESKTOP_ACCOUNT_PROFILE/g)).toHaveLength(4);
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?4,[\s\S]*?Exactly four Room profile settings stages are required/,
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'renamePriorRoomTimelineVisible',
      'renameOriginalRoomTimelineVisible',
      'photoRoomTimelineVisible',
      'partialRoomTimelineVisible',
      'continuityRoomTimelineVisible',
      'renameSettingsVisible',
      'renameDirectoryVisible',
      'renameOpeningAccount',
      'renameHeadingFocused',
      'renameDesktopWidthMinimum',
      'renameDesktopWidthMaximum',
      'renameCompactDirectoryHidden',
      'renameCompactBackVisible',
      'renameCompactGeneralVisible',
      'renameDesktopDirectoryRestored',
      'renameDesktopBackHidden',
      'renameScaledCancelVisible',
      'renameScaledActionsAbsent',
      'renameBackDiscardVisible',
      'renameBackDraftRetained',
      'renameTabDiscardVisible',
      'renameTabDraftRetained',
      'renameGeneralPanelRetained',
      'renameNewChannelVisible',
      'renameOldChannelAbsent',
      'photoSettingsVisible',
      'photoUpdated',
      'partialFailureFeedback',
      'partialNameFirstAttempts',
      'partialTopicFirstAttempts',
      'partialRetryFeedback',
      'partialNameTotalAttempts',
      'partialTopicTotalAttempts',
      'continuityOpeningAccount',
      'continuityNameSaving',
      'continuityMemberRowVisible',
      'continuityActiveMember',
      'continuityAccountRetained',
      'continuityNameSaved',
      'continuityTopicSaved',
      'continuityTopicPersisted',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
  });

  it('keeps Room interactions native and uses the real Android document picker', () => {
    const journey = readIfPresent(journeyPath);
    const picker = readFileSync(pickerPath, 'utf8');
    const accountClient = readFileSync(accountClientPath, 'utf8');
    expect(journey).toContain('client.tapCurrent(');
    expect(journey).toContain('client.fill(');
    expect(journey).toContain('client.replace(');
    expect(journey).toContain('e2e/android/flows/native-shell-back.yaml');
    expect(journey).toContain('client.tapDocumentTrigger(');
    expect(journey).toContain('pickAndroidDocument(');
    expect(journey).toContain("'room-photo.png'");
    expect(journey).toContain("'m.room.avatar'");
    expect(journey).toContain("'Room photo updated.'");
    expect(picker).toContain('com.google.android.photopicker');
    expect(picker).toContain(
      "join(workspaceRoot, 'e2e/android/flows/accounts-document-pick.yaml')",
    );
    expect(picker).toContain('await remove()');
    expect(accountClient).toMatch(
      /async replace\([\s\S]{0,180}?await this\.tapCurrent\(selector\)/,
    );
    for (const mutation of forbiddenJourneyMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins responsive, visual, fault, retry, and server outcomes', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('await client.resize(700, 800)');
    expect(journey).toContain('withSpaceSettingsVisualFixture(');
    expect(journey).toContain("fontSize: '125%'");
    expect(journey).toContain("theme: 'amethyst'");
    expect(journey.match(/'\[data-testid="alert-surface"\]'/g)).toHaveLength(2);
    expect(journey.match(/'\[data-testid="alert-cancel"\]'/g)).toHaveLength(2);
    expect(journey).not.toContain('\'[role="dialog"]\'');
    expect(journey).toContain(
      "client.capture('room-settings-desktop-general-light')",
    );
    expect(journey).toContain(
      "client.capture('room-settings-desktop-general-dark-amethyst')",
    );
    expect(journey).toContain('installFirstMatrixHttpFailure(');
    expect(journey).toContain('installMatrixRoomStateDelay(');
    expect(journey).toMatch(
      /kind: 'room-state',[\s\S]{0,180}?eventType: 'm\.room\.topic',[\s\S]{0,120}?status: 500,[\s\S]{0,120}?responseError: 'retry me'/,
    );
    expect(journey).toMatch(
      /installMatrixRoomStateDelay\([\s\S]{0,240}?eventType: 'm\.room\.name'/,
    );
    expect(journey).toContain("'still unsaved'");
    expect(journey).toContain("'Topic saved'");
    expect(journey).toContain("'Name saved'");
    expect(journey).toContain("'Owned by account A'");
    expect(journey).toContain('roomStateAttempts(');
    expect(journey).toContain('fixtures.roomState(');
    expect(readFileSync(faultPath, 'utf8')).toContain(
      "readonly eventType: 'm.room.name' | 'm.room.topic'",
    );
  });

  it('confines the blocked-modal exception to its exact two source clicks', () => {
    const transition = readIfPresent(transitionPath);
    expect(transition).toContain('room-profile-settings.spec.mts:324-335');
    expect(transition).toContain('[data-testid="user-menu-trigger"]');
    expect(transition).toContain('[data-testid="account-row"]');
    expect(transition.match(/\.click\(\)/g)).toHaveLength(2);
    expect(transition).toContain('active Account changed');
    expect(transition).toContain('client.record(');
    for (const mutation of [
      /\.focus\s*\(/,
      /\.dispatchEvent\s*\(/,
      /(?:document|window)\.location\s*=/,
      /history\.(?:back|forward|go|pushState|replaceState)\s*\(/,
      /window\.open\s*\(/,
    ]) {
      expect(transition).not.toMatch(mutation);
    }
  });

  it('owns one-attempt diagnostics, redaction, cleanup, and registration', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room profile settings Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room profile settings Android WebView'/,
    );
    expect(readFileSync(resolve(root, 'package.json'), 'utf8')).toContain(
      'e2e:android:room-profile-settings',
    );
    expect(
      readFileSync(resolve(root, 'e2e/android/project.json'), 'utf8'),
    ).toContain('android.room-profile-settings');
    expect(
      readFileSync(resolve(root, 'e2e/registry/suites/runners.mts'), 'utf8'),
    ).toContain("id: 'android.room-profile-settings'");
    expect(
      readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
    ).toContain('android-room-profile-settings');
    expect(predecessor).toContain(
      "test('an admin renames a room from the settings dialog'",
    );
  });
});
