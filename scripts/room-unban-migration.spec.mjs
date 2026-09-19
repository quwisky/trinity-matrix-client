import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitionSource =
  'e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';
const openSettingsTabSource = 'e2e/support/app.mts';
const contractPath = resolve(root, 'e2e/android/room-unban-contract.mts');
const journeyPath = resolve(root, 'e2e/android/room-unban-journeys.mts');
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const directAssertionIds = [
  'unban.banned-surface-visible',
  'unban.target-row-visible',
  'unban.confirm-target',
  'unban.confirm-room',
  'unban.confirm-account',
  'unban.toast-visible',
  'unban.server-membership',
];
const helperAssertionIds = [
  'unban.room-timeline-visible',
  'unban.members-panel-visible',
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

describe('Android Room unban migration', () => {
  it('pins one definition, both transitive helpers, and exactly nine sites', () => {
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

    expect(definition[74]).toContain(
      "test('an admin unbans a member from the banned list'",
    );
    expect(definition[169]).toBe('  });');
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
    expect(expectSites(definition, 75, 170)).toBe(7);
    expect(expectSites(openRoom, 36, 44)).toBe(1);
    expect(expectSites(openSettingsTab, 228, 248)).toBe(1);
  });

  it('exports exact mappings and stable 7+2 identities', async () => {
    expect(existsSync(contractPath), 'room-unban-contract.mts must exist').toBe(
      true,
    );
    const contract = await import(contractPath);
    expect(contract.ROOM_UNBAN_SOURCES).toEqual({
      definition: `${definitionSource}:75-170`,
      openRoom: `${openRoomSource}:36-44`,
      openSettingsTab: `${openSettingsTabSource}:228-248`,
    });
    expect(Object.values(contract.roomUnbanHelperAssertions)).toEqual(
      helperAssertionIds,
    );
    expect(Object.values(contract.roomUnbanDirectAssertions)).toEqual(
      directAssertionIds,
    );
    expect(Object.values(contract.roomUnbanAssertions)).toEqual(assertionIds);
    expect(new Set(Object.values(contract.roomUnbanAssertions)).size).toBe(9);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?7,[\s\S]*?Exactly seven direct Room unban assertion identities are required/,
    );
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?2,[\s\S]*?Exactly two helper Room unban assertion identities are required/,
    );
  });

  it('adds only the narrow finite ban fixture operation', () => {
    const fixture = readIfPresent(fixturePath);
    expect(fixture).toMatch(
      /ban\([\s\S]*?owner: NodeWorkspaceAccount,[\s\S]*?roomId: string,[\s\S]*?member: NodeWorkspaceAccount,[\s\S]*?reason: string,[\s\S]*?Promise<void>/,
    );
    expect(fixture).toMatch(
      /async function ban\([\s\S]*?\/rooms\/\$\{encodeURIComponent\(roomId\)\}\/ban[\s\S]*?user_id: member\.userId,[\s\S]*?reason/,
    );
    expect(fixture).toContain('allowEndedMembershipCleanup(member, roomId);');
    expect(fixture).toMatch(/return \{[\s\S]*?ban,[\s\S]*?roomMembership/);
  });

  it('implements one Pixel 5 stage through all nine contract identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'room-unban-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('room-unban-contract.mts');
    expect(journey).toContain('ROOM_UNBAN_SOURCES.definition');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?1,[\s\S]*?Exactly one Room unban stage is required/,
    );
    for (const key of [
      'roomTimelineVisible',
      'membersPanelVisible',
      'bannedSurfaceVisible',
      'targetRowVisible',
      'confirmTarget',
      'confirmRoom',
      'confirmAccount',
      'toastVisible',
      'serverMembership',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('uses finite setup, native actions, and read-only observations', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('fixtures.setDisplayName(');
    expect(journey).toContain('fixtures.createRoom(');
    expect(journey).toContain('fixtures.join(');
    expect(journey).toContain("fixtures.ban(admin, room.id, target, 'spam')");
    expect(journey).toMatch(
      /assert\.equal\([\s\S]{0,120}?roomMembership\(admin, room\.id, target\)[\s\S]{0,80}?'ban'/,
    );
    for (const selector of [
      'rail-rooms',
      'room-actions-overflow',
      'overflow-open-room-settings',
      'room-settings-tab-members',
      'members-settings-banned',
      'banned-member-unban',
      'alert-confirm',
    ]) {
      expect(journey).toContain(`data-testid="${selector}"`);
    }
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins exact confirmation, feedback, and server result', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.confirmTarget[\s\S]{0,260}?\{ text: targetName \}/,
    );
    expect(journey).toMatch(
      /assertions\.confirmRoom[\s\S]{0,260}?\{ text: room\.name \}/,
    );
    expect(journey).toMatch(
      /assertions\.confirmAccount[\s\S]{0,280}?\{ text: `Account \$\{admin\.userId\}` \}/,
    );
    expect(journey).toMatch(
      /assertions\.toastVisible[\s\S]*?`Unbanned \$\{targetName\}\.`/,
    );
    expect(journey).toMatch(
      /assertions\.targetRowVisible[\s\S]*?elements\.length === 1/,
    );
    expect(journey).toMatch(
      /assertions\.serverMembership[\s\S]*?membership === 'leave'/,
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
      /matrixResources\.cleanup\(\s*'Room unban Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room unban Android WebView'/,
    );
    expect(project).toContain('"room-unban"');
    expect(packageJson).toContain('"e2e:android:room-unban"');
    expect(commands).toContain("'android.room-unban'");
    expect(runners).toContain("id: 'android.room-unban'");
    expect(workflow).toContain('room-unban-started=true');
    expect(workflow).toContain('surface: android-room-unban');
  });
});
