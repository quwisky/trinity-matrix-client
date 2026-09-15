import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitionSource =
  'e2e/browser/journeys/room-administration/room-settings-for-you.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';
const multiAccountSource = 'e2e/browser/support/multi-account-journey.mts';
const appSource = 'e2e/support/app.mts';
const contractPath = resolve(root, 'e2e/android/room-for-you-contract.mts');
const journeyPath = resolve(root, 'e2e/android/room-for-you-journeys.mts');
const faultPath = resolve(root, 'e2e/android/matrix-http-fault.mts');
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const predecessor = readFileSync(resolve(root, definitionSource), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const inheritedAssertionIds = [
  'load.room-timeline-visible',
  'preferences.owner-room-timeline-visible',
  'preferences.member-room-timeline-visible',
];
const directAssertionIds = [
  'load.settings-visible',
  'load.error-heading-visible',
  'load.alert-not-live',
  'load.retry-enabled',
  'load.alert-box-present',
  'load.retry-box-present',
  'load.retry-left-contained',
  'load.retry-top-contained',
  'load.retry-right-contained',
  'load.retry-bottom-contained',
  'load.form-visible',
  'load.read-attempts-minimum',
  'preferences.settings-visible',
  'preferences.form-visible',
  'preferences.heading-focused',
  'preferences.expected-mode-checked',
  'preferences.other-modes-unchecked',
  'preferences.opening-account',
  'preferences.initial-favourite-unchecked',
  'preferences.partial-feedback',
  'preferences.notification-first-writes',
  'preferences.favourite-first-writes',
  'preferences.low-priority-first-writes',
  'preferences.retry-feedback',
  'preferences.notification-total-writes',
  'preferences.favourite-total-writes',
  'preferences.owner-mode-persisted',
  'preferences.owner-tags-persisted',
  'preferences.member-mode-persisted',
  'preferences.member-tags-persisted',
  'preferences.theme-form-visible',
  'preferences.scaled-form-visible',
  'preferences.member-account',
  'preferences.member-favourite-checked',
  'preferences.member-low-priority-unchecked',
];
const assertionIds = [...inheritedAssertionIds, ...directAssertionIds];
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

describe('Android Room For-you migration', () => {
  it('pins both definitions and the exact 35+3 source obligations', () => {
    const definition = sourceLines(
      definitionSource,
      '923fe4053badf040b9deaf9beba7da74bc27bf19277af4bb570462fed2c24f88',
    );
    const openRoom = sourceLines(
      openRoomSource,
      'bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7',
    );
    sourceLines(
      multiAccountSource,
      'd0eba322f61a8139fc0666dee5f0575a473f5bcd9007af619f22b740bc851306',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );

    expect(definition[149]).toContain(
      "test('shows a failed preference read and retries into the editable form'",
    );
    expect(definition[224]).toBe('  });');
    expect(definition[226]).toContain(
      "test('isolates staged preferences to the opening Account and retries only a failed field'",
    );
    expect(definition[390]).toBe('  });');
    expect(expectSites(definition, 150, 225)).toBe(12);
    expect(expectSites(definition, 227, 391)).toBe(18);
    expect(expectSites(definition, 80, 90)).toBe(3);
    expect(expectSites(definition, 92, 103)).toBe(2);
    expect(openRoom[35]).toContain('export async function openRoom');
    expect(openRoom[43]).toBe('}');
    expect(expectSites(openRoom, 36, 44)).toBe(1);
    expect(
      definition.filter((line) => line.includes('await openRoom(')),
    ).toHaveLength(3);
  });

  it('exports exact source mappings and stable 35+3 identities', async () => {
    expect(contractPath.endsWith('room-for-you-contract.mts')).toBe(true);
    expect(
      existsSync(contractPath),
      'room-for-you-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ROOM_FOR_YOU_SOURCES).toEqual({
      failedRead: `${definitionSource}:150-225`,
      accountIsolation: `${definitionSource}:227-391`,
      openForYou: `${definitionSource}:80-90`,
      expectMode: `${definitionSource}:92-103`,
      openRoom: `${openRoomSource}:36-44`,
      multiAccount: multiAccountSource,
      app: appSource,
    });
    expect(Object.values(contract.roomForYouInheritedAssertions)).toEqual(
      inheritedAssertionIds,
    );
    expect(Object.values(contract.roomForYouDirectAssertions)).toEqual(
      directAssertionIds,
    );
    expect(Object.values(contract.roomForYouAssertions)).toEqual(assertionIds);
    expect(new Set(Object.values(contract.roomForYouAssertions)).size).toBe(38);
  });

  it('implements two desktop stages through every contract identity', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'room-for-you-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('room-for-you-contract.mts');
    expect(journey).toContain('ROOM_FOR_YOU_SOURCES.failedRead');
    expect(journey).toContain('ROOM_FOR_YOU_SOURCES.accountIsolation');
    expect(journey.match(/profile: DESKTOP_ACCOUNT_PROFILE/g)).toHaveLength(2);
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?2,[\s\S]*?Exactly two Room For-you stages are required/,
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'loadRoomTimelineVisible',
      'preferencesOwnerRoomTimelineVisible',
      'preferencesMemberRoomTimelineVisible',
      'loadSettingsVisible',
      'loadErrorHeadingVisible',
      'loadAlertNotLive',
      'loadRetryEnabled',
      'loadAlertBoxPresent',
      'loadRetryBoxPresent',
      'loadRetryLeftContained',
      'loadRetryTopContained',
      'loadRetryRightContained',
      'loadRetryBottomContained',
      'loadFormVisible',
      'loadReadAttemptsMinimum',
      'preferencesSettingsVisible',
      'preferencesFormVisible',
      'preferencesHeadingFocused',
      'preferencesExpectedModeChecked',
      'preferencesOtherModesUnchecked',
      'preferencesOpeningAccount',
      'preferencesInitialFavouriteUnchecked',
      'preferencesPartialFeedback',
      'preferencesNotificationFirstWrites',
      'preferencesFavouriteFirstWrites',
      'preferencesLowPriorityFirstWrites',
      'preferencesRetryFeedback',
      'preferencesNotificationTotalWrites',
      'preferencesFavouriteTotalWrites',
      'preferencesOwnerModePersisted',
      'preferencesOwnerTagsPersisted',
      'preferencesMemberModePersisted',
      'preferencesMemberTagsPersisted',
      'preferencesThemeFormVisible',
      'preferencesScaledFormVisible',
      'preferencesMemberAccount',
      'preferencesMemberFavouriteChecked',
      'preferencesMemberLowPriorityUnchecked',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
  });

  it('keeps every reachable product interaction native', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('client.tapCurrent(');
    expect(journey).toMatch(
      /client\.tapCurrent\(\s*'\[data-testid="room-settings-notify-all"\]',?\s*\)/,
    );
    expect(journey).not.toMatch(
      /client\.tapCurrent\(\s*'\[data-testid="room-settings-notify-all"\] \[role="radio"\]',?\s*\)/,
    );
    expect(journey).toContain("client.key('arrowDown')");
    expect(journey).toContain("client.key('space')");
    expect(journey).toMatch(
      /client\.key\('arrowDown'\);\s*await client\.key\('arrowDown'\);\s*await client\.key\('space'\);\s*modeObservations\.push\(await observeMode\(client, 'mute'\)\)/,
    );
    expect(journey).toContain('client.addAccount(');
    for (const mutation of forbiddenJourneyMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins exact read/write faults, retry counts, Account isolation, and visuals', () => {
    const journey = readIfPresent(journeyPath);
    const fault = readFileSync(faultPath, 'utf8');
    const fixture = readFileSync(fixturePath, 'utf8');
    expect(journey).toContain('installFirstMatrixHttpFailure(');
    expect(journey).toMatch(
      /kind: 'push-rules',[\s\S]{0,160}?status: 500,[\s\S]{0,120}?responseError: 'offline'/,
    );
    expect(journey).toMatch(
      /const lowPriorityTarget:[\s\S]{0,260}?method: 'PUT',[\s\S]{0,160}?tag: 'm\.lowpriority'/,
    );
    expect(journey).toMatch(
      /kind: 'room-tag',[\s\S]{0,100}?\.\.\.lowPriorityTarget,[\s\S]{0,120}?status: 500,[\s\S]{0,120}?responseError: 'retry me'/,
    );
    expect(journey).toContain("'Couldn’t read Room preferences'");
    expect(journey).toContain(
      "'Notifications and favourite saved. Low priority is still unsaved; retry saves only what remains.'",
    );
    expect(journey).toContain("'Low priority saved for the opening Account.'");
    expect(journey).toContain('withSpaceSettingsVisualFixture(');
    expect(journey).toContain("fontSize: '125%'");
    expect(journey).toMatch(/\[null, 'amethyst', 'onyx'\] as const/);
    expect(journey).toContain('fixtures.roomNotificationMode(');
    expect(journey).toContain('fixtures.roomTags(');
    expect(journey).toContain(
      "fixtures.setRoomNotificationMode(member, room.id, 'mentions')",
    );
    expect(journey).toMatch(
      /fault\.roomTagAttempts\(lowPriorityTarget\),\s*2,\s*'Only the exact low-priority field retries once'/,
    );
    expect(journey).toMatch(
      /assertions\.preferencesOwnerModePersisted,[\s\S]{0,180}?\(mode\) => mode === 'mute'/,
    );
    expect(journey).toMatch(
      /assertions\.preferencesMemberModePersisted,[\s\S]{0,180}?\(mode\) => mode === 'mentions'/,
    );
    expect(fault).toContain("readonly kind: 'push-rules'");
    expect(fault).toContain("readonly kind: 'room-tag'");
    expect(fixture).toContain('roomNotificationMode(');
    expect(fixture).toContain('roomTags(');
  });

  it('owns one-attempt diagnostics, redaction, cleanup, and registration', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room For-you Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room For-you Android WebView'/,
    );
    expect(readFileSync(resolve(root, 'package.json'), 'utf8')).toContain(
      'e2e:android:room-for-you',
    );
    expect(
      readFileSync(resolve(root, 'e2e/android/project.json'), 'utf8'),
    ).toContain('android.room-for-you');
    expect(
      readFileSync(resolve(root, 'e2e/registry/suites/runners.mts'), 'utf8'),
    ).toContain("id: 'android.room-for-you'");
    expect(
      readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
    ).toContain('android-room-for-you');
    expect(predecessor).toContain(
      "test('shows a failed preference read and retries into the editable form'",
    );
  });

  it('documents every identity and keeps predecessor retirement out of scope', () => {
    const migration = readFileSync(
      resolve(root, 'e2e/android/MIGRATION.md'),
      'utf8',
    );
    expect(migration).toContain('## Room For-you preferences batch');
    expect(migration).toContain('exactly 35 direct plus three inherited');
    expect(migration).toContain('does not authorize predecessor retirement');
    expect(migration).toContain('does not authorize merging PR #677');
    for (const identity of assertionIds) {
      expect(migration).toContain(`\`${identity}\``);
    }
  });
});
