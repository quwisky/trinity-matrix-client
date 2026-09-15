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
  'e2e/android/room-address-lifecycle-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/room-address-lifecycle-journeys.mts',
);
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const directAssertionIds = [
  'address.panel-visible',
  'address.row-visible',
  'address.directory-resolves',
  'address.primary-visible',
  'address.canonical-state',
  'address.settings-within-viewport',
  'address.primary-toast-hidden',
  'address.remove-joining-effect',
  'address.remove-room-retained',
  'address.cancel-keeps-row',
  'address.row-removed',
  'address.directory-removed',
  'address.canonical-cleared',
  'address.rejected-toast-visible',
  'address.retry-draft-retained',
];
const helperAssertionIds = [
  'address.room-timeline-visible',
  'address.addresses-panel-visible',
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

describe('Android Room address lifecycle migration', () => {
  it('pins one definition, both transitive helpers, and exactly 17 sites', () => {
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

    expect(definition[402]).toContain(
      "test('an admin adds a room address and makes it the main one'",
    );
    expect(definition[535]).toBe('  });');
    expect(openRoom[35]).toContain('export async function openRoom');
    expect(openRoom[43]).toBe('}');
    expect(openSettingsTab[227]).toContain(
      'export async function openSettingsTab',
    );
    expect(openSettingsTab[247]).toBe('}');
    expect(expectSites(definition, 403, 536)).toBe(15);
    expect(expectSites(openRoom, 36, 44)).toBe(1);
    expect(expectSites(openSettingsTab, 228, 248)).toBe(1);
  });

  it('exports exact source mappings and stable 15+2 identities', async () => {
    expect(
      existsSync(contractPath),
      'room-address-lifecycle-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ROOM_ADDRESS_LIFECYCLE_SOURCES).toEqual({
      definition: `${definitionSource}:403-536`,
      openRoom: `${openRoomSource}:36-44`,
      openSettingsTab: `${openSettingsTabSource}:228-248`,
    });
    expect(
      Object.values(contract.roomAddressLifecycleHelperAssertions),
    ).toEqual(helperAssertionIds);
    expect(
      Object.values(contract.roomAddressLifecycleDirectAssertions),
    ).toEqual(directAssertionIds);
    expect(Object.values(contract.roomAddressLifecycleAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.roomAddressLifecycleAssertions)).size,
    ).toBe(17);
  });

  it('implements one desktop stage through all 17 identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'room-address-lifecycle-journeys.mts must exist').not.toBe(
      '',
    );
    expect(journey).toContain('room-address-lifecycle-contract.mts');
    expect(journey).toContain('ROOM_ADDRESS_LIFECYCLE_SOURCES.definition');
    expect(journey).toContain('DESKTOP_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?1,[\s\S]*?Exactly one Room address lifecycle stage is required/,
    );
    for (const key of [
      'roomTimelineVisible',
      'addressesPanelVisible',
      'panelVisible',
      'rowVisible',
      'directoryResolves',
      'primaryVisible',
      'canonicalState',
      'settingsWithinViewport',
      'primaryToastHidden',
      'removeJoiningEffect',
      'removeRoomRetained',
      'cancelKeepsRow',
      'rowRemoved',
      'directoryRemoved',
      'canonicalCleared',
      'rejectedToastVisible',
      'retryDraftRetained',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('uses finite setup and Maestro-native product actions', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain("fixtures.account('room-address-owner')");
    expect(journey).toContain('fixtures.createRoom(');
    expect(journey).toContain("resources.aliasLocalpart('ral')");
    expect(journey).toContain('await client.login(owner)');
    for (const selector of [
      'rail-rooms',
      'open-room-settings',
      'room-settings-tab-addresses',
      'room-alias-input',
      'room-alias-set-main',
      'room-alias-remove',
      'alert-cancel',
      'alert-confirm',
    ]) {
      expect(journey).toContain(`data-testid="${selector}"`);
    }
    expect(journey).toContain("client.key('enter')");
    expect(journey.match(/client\.key\('enter'\)/g)).toHaveLength(4);
    expect(
      journey.match(
        /client\.tapCurrent\('\[data-testid="room-alias-remove"\]'\)/g,
      ),
    ).toHaveLength(2);
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('pins exact UI, server, geometry, removal, and retry outcomes', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(
      /assertions\.rowVisible[\s\S]{0,260}?\{ text: alias \}/,
    );
    expect(journey).toMatch(
      /assertions\.directoryResolves[\s\S]{0,260}?roomId === room\.id/,
    );
    expect(journey).toMatch(
      /assertions\.primaryVisible[\s\S]{0,280}?\{ exactText: 'Primary' \}/,
    );
    expect(journey).toMatch(
      /assertions\.canonicalState[\s\S]{0,360}?value\?\.\['alias'\] === alias/,
    );
    expect(journey).toContain('async function observedSettingsGeometry');
    expect(journey).toContain('assertions.settingsWithinViewport');
    expect(journey).toMatch(
      /geometry\.surface\.right <= geometry\.viewport\.width/,
    );
    expect(journey).toMatch(
      /assertions\.primaryToastHidden[\s\S]{0,260}?elements\.length === 0[\s\S]{0,180}?exactText: `\$\{alias\} is now the primary address\.`/,
    );
    expect(journey).toMatch(
      /assertions\.removeJoiningEffect[\s\S]*?`People will no longer be able to join or link to this room with \$\{alias\}\.`/,
    );
    expect(journey).toMatch(
      /assertions\.removeRoomRetained[\s\S]{0,280}?\{ text: 'This does not delete the Room\.' \}/,
    );
    expect(journey).toMatch(
      /assertions\.cancelKeepsRow[\s\S]{0,260}?\{ text: alias \}/,
    );
    expect(journey).toMatch(
      /assertions\.rowRemoved[\s\S]{0,240}?elements\.length === 0/,
    );
    expect(journey).toMatch(
      /assertions\.directoryRemoved[\s\S]{0,280}?roomId === undefined/,
    );
    expect(journey).toMatch(
      /assertions\.canonicalCleared[\s\S]{0,380}?typeof value\?\.\['alias'\] !== 'string'/,
    );
    expect(journey).toContain("kind: 'room-alias'");
    expect(journey).toContain('alias: retryAlias');
    expect(journey).toContain("responseError: 'retry me'");
    expect(journey).toMatch(
      /assertions\.rejectedToastVisible[\s\S]*?`Could not add \$\{retryAlias\}\.`/,
    );
    expect(journey).toMatch(
      /responseStatus === 500[\s\S]{0,220}?bodyMatchesInjected === true/,
    );
    expect(journey).not.toMatch(
      /assertions\.rejectedToastVisible[\s\S]{0,650}?handlerReported/,
    );
    expect(journey).toMatch(
      /assertions\.retryDraftRetained[\s\S]{0,300}?elements\[0\]!\.value === retryLocalpart/,
    );
  });

  it('owns one-attempt diagnostics, redaction, and cleanup', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('expectedStages: cases.length');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room address lifecycle Android device'/,
    );
    expect(journey).toMatch(
      /matrixResources\.cleanup\(\s*'Room address lifecycle Android WebView'/,
    );
  });
});
