import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/hide-system-messages.spec.mts';
const navigationSource = 'e2e/support/journeys/navigation.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const clientSource = 'e2e/android/account-workspace-client.mts';
const fixturesSource = 'e2e/android/account-workspace-fixtures.mts';
const contractPath = resolve(
  root,
  'e2e/android/hide-system-messages-contract.mts',
);
const preferencePath = resolve(
  root,
  'e2e/android/timeline-membership-preference.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/hide-system-messages-journeys.mts',
);

const assertionIds = [
  'hide-system-messages.initial.room-ready',
  'hide-system-messages.initial.join-visible',
  'hide-system-messages.initial.message-visible',
  'hide-system-messages.settings.rooms-route-ready',
  'hide-system-messages.settings.sections-visible',
  'hide-system-messages.settings.detail-ready',
  'hide-system-messages.settings.toggle-visible',
  'hide-system-messages.filtered.room-ready',
  'hide-system-messages.filtered.message-visible',
  'hide-system-messages.filtered.join-absent',
  'hide-system-messages.relaunch.room-ready',
  'hide-system-messages.relaunch.message-visible',
  'hide-system-messages.relaunch.join-absent',
];

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

function assertReadOnlyRendererExpressions(source, path) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const expressions = [];
  function collect(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'evaluateNative'
    ) {
      expect(node.arguments).toHaveLength(2);
      expressions.push(node.arguments[1].getText(sourceFile));
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);
  for (const expression of expressions) {
    expect(expression).not.toMatch(
      /\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
    );
    expect(expression).not.toMatch(
      /dispatchEvent\(|setAttribute\(|\.value\s*=|location\s*=|history\./u,
    );
  }
}

function assertRuntimeContract({ journey, preference, fixtures, client }) {
  const journeyFragments = [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "const MEMBERSHIP_KEY = 'trinity.timeline.show-membership'",
    "id: 'membership-filter-persistence'",
    "preset: 'private_chat'",
    'invite: [joiner.userId]',
    'await fixtures.setDisplayName(joiner, joinerName)',
    'await fixtures.join(joiner, room.id)',
    'await fixtures.sendMessage(joiner, room.id, body, transactionId)',
    'await client.login(host)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: roomName })",
    '\'[data-testid="composer-input"]\'',
    '\'[data-testid="timeline-event"]\'',
    "'trn-message-row .msg__text'",
    'await client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
    'await client.tapCurrent(\'[data-testid="open-settings"]\')',
    'await client.tapCurrent(\'[data-testid="settings-nav-appearance"]\')',
    'await client.scrollIntoViewIfNeeded(',
    '\'[data-testid="timeline-show-membership"] trn-switch\'',
    'await readNativeTimelineMembershipPreference(',
    'await client.tapCurrent(\'[data-testid="timeline-show-membership"] trn-switch\')',
    'await pressNativeBack(client)',
    'await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)',
    'expectedStages: 1',
    'expectedUniqueAssertions: 13',
    'expectedAssertionRecords: 13',
    'attempt: 1',
    'retries: 0',
    'redactMaestroArtifacts(output, secrets, true)',
    'scanHideSystemMessagesArtifacts(output, secrets)',
    "nativeStorageMethodDataIsRedacted(text, 'Preferences')",
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const preferenceFragments = [
    "const MEMBERSHIP_KEY = 'trinity.timeline.show-membership'",
    "const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml'",
    'parseNativeTimelineMembershipPreference',
    'readNativeTimelineMembershipPreference',
    "'run-as'",
    'waitForNativeShellState(',
    'candidate.effectiveValue === expectedValue',
    'preferenceKeyPresent:',
    'effectiveValue:',
  ];
  for (const fragment of preferenceFragments)
    expect(preference).toContain(fragment);

  const fixtureFragments = [
    'setDisplayName(',
    'createRoom(',
    'invite?: readonly string[]',
    'join(',
    'sendMessage(',
    '/displayname',
    '/join',
    '/send/m.room.message/',
  ];
  for (const fragment of fixtureFragments) expect(fixtures).toContain(fragment);

  const relaunch = client.slice(
    client.indexOf('async relaunch('),
    client.indexOf('async elements(', client.indexOf('async relaunch(')),
  );
  expect(relaunch).toContain("'am'");
  expect(relaunch).toContain("'force-stop'");
  expect(relaunch).toContain('startNativeShellClient(');

  for (const assertionName of [
    'initialRoomReady',
    'initialJoinVisible',
    'initialMessageVisible',
    'settingsRoomsRouteReady',
    'settingsSectionsVisible',
    'settingsDetailReady',
    'settingsToggleVisible',
    'filteredRoomReady',
    'filteredMessageVisible',
    'filteredJoinAbsent',
    'relaunchRoomReady',
    'relaunchMessageVisible',
    'relaunchJoinAbsent',
  ]) {
    expect(journey).toContain(`assertions.${assertionName}`);
  }
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|navigate|reload)\s*\(|evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toContain('localStorage');
  expect(journey).not.toContain('sessionStorage');
  expect(preference).not.toMatch(
    /localStorage|sessionStorage|evaluateNative|\.Plugins\?\.Preferences/u,
  );
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

describe('Android hide-system-messages migration', () => {
  it('pins the exact predecessor, helper spans, and 7 + 3 + 3 parity shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      'f1f88eb542b48cfa461132a730b7fea1120977d771ade96565d0ae5fb64329c0',
    );
    const navigation = sourceLines(
      navigationSource,
      '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[26]).toContain('async function apiLogin');
    expect(predecessor[47]).toContain('async function openRoom');
    expect(predecessor[52]).toContain("getByTestId('composer-input')");
    expect(predecessor[60]).toContain(
      "test('hiding joins removes the system line but keeps the messages'",
    );
    expect(predecessor[143]).toBe('  });');
    const definition = predecessor.slice(60, 144).join('\n');
    expect(definition.match(/await openRoom\(/gu)).toHaveLength(3);
    expect(definition.match(/await expect\(/gu)).toHaveLength(7);
    expect(definition).toContain(
      "await openSettingsSection(page, 'appearance')",
    );
    expect(definition).toContain("await page.goto('/rooms')");
    expect(definition).toContain('await page.reload()');

    const settingsHelper = navigation.slice(10, 60).join('\n');
    expect(settingsHelper).toContain("getByTestId('open-settings')");
    expect(settingsHelper).toContain("name: 'Settings sections'");
    expect(settingsHelper).toContain("getByTestId('settings-detail')");
    expect(app.join('\n')).toContain('export async function readPreference(');
    expect(account.join('\n')).toContain('export async function registerUser(');
  });

  it('exports the exact thirteen identities and source mapping', async () => {
    expect(
      contractPath,
      'hide-system-messages-contract.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.HIDE_SYSTEM_MESSAGES_SOURCES).toEqual({
      helpers: `${predecessorSource}:27-56`,
      definition: `${predecessorSource}:61-144`,
      navigation: navigationSource,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.hideSystemMessagesAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.hideSystemMessagesAssertions)).size,
    ).toBe(13);
    expect(contract.HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS).toBe(13);
  });

  it('parses only the exact native key and fails closed on malformed values', async () => {
    expect(
      preferencePath,
      'timeline-membership-preference.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(preferencePath)) return;
    const { parseNativeTimelineMembershipPreference } = await import(
      preferencePath
    );
    expect(
      parseNativeTimelineMembershipPreference(`<?xml version='1.0'?>
<map><string name="other">false</string></map>`),
    ).toEqual({ preferenceKeyPresent: false, effectiveValue: true });
    expect(
      parseNativeTimelineMembershipPreference(`<?xml version='1.0'?>
<map><string name="trinity.timeline.show-membership">false</string></map>`),
    ).toEqual({ preferenceKeyPresent: true, effectiveValue: false });
    expect(
      parseNativeTimelineMembershipPreference(`<?xml version='1.0'?>
<map><string name="trinity.timeline.show-membership">true</string></map>`),
    ).toEqual({ preferenceKeyPresent: true, effectiveValue: true });
    expect(() =>
      parseNativeTimelineMembershipPreference(`<?xml version='1.0'?>
<map><string name="trinity.timeline.show-membership">maybe</string></map>`),
    ).toThrow();
    expect(() =>
      parseNativeTimelineMembershipPreference(`<?xml version='1.0'?>
<map><string name="trinity.timeline.show-membership">false</string><string name="trinity.timeline.show-membership">false</string></map>`),
    ).toThrow();
  });

  it('implements one native stage with exact filtering and durable storage proof', () => {
    const journey = readIfPresent(journeyPath);
    const preference = readIfPresent(preferencePath);
    const fixtures = read(fixturesSource);
    const client = read(clientSource);
    expect(journey, 'hide-system-messages-journeys.mts must exist').not.toBe(
      '',
    );
    expect(
      preference,
      'timeline-membership-preference.mts must exist',
    ).not.toBe('');
    assertRuntimeContract({ journey, preference, fixtures, client });
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when filtering, relaunch, ownership, cleanup, or redaction is weakened', () => {
    const journey = readIfPresent(journeyPath);
    const preference = readIfPresent(preferencePath);
    const fixtures = read(fixturesSource);
    const client = read(clientSource);
    expect(() =>
      assertRuntimeContract({ journey, preference, fixtures, client }),
    ).not.toThrow();
    const mutations = [
      ["preset: 'private_chat'", "preset: 'public_chat'"],
      ['invite: [joiner.userId]', 'invite: []'],
      [
        'await fixtures.setDisplayName(joiner, joinerName)',
        'await Promise.resolve(joinerName)',
      ],
      [
        'await fixtures.sendMessage(joiner, room.id, body, transactionId)',
        'await Promise.resolve(body)',
      ],
      ["'trn-message-row .msg__text'", "'body'"],
      [
        'await client.tapCurrent(\'[data-testid="timeline-show-membership"] trn-switch\')',
        'await Promise.resolve()',
      ],
      [
        'await client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
        'await Promise.resolve()',
      ],
      [
        'await readNativeTimelineMembershipPreference(',
        'await Promise.resolve(',
      ],
      [
        'await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)',
        'await client.reload()',
      ],
      [
        'redactMaestroArtifacts(output, secrets, true)',
        'redactMaestroArtifacts(output, secrets, false)',
      ],
      ['scanHideSystemMessagesArtifacts(output, secrets)', 'Promise.resolve()'],
      [
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
    ];
    for (const [before, after] of mutations) {
      expect(journey).toContain(before);
      expect(() =>
        assertRuntimeContract({
          journey: journey.replaceAll(before, after),
          preference,
          fixtures,
          client,
        }),
      ).toThrow();
    }
    expect(() =>
      assertRuntimeContract({
        journey,
        preference: preference.replace("'run-as'", "'echo'"),
        fixtures,
        client,
      }),
    ).toThrow();
    expect(() =>
      assertRuntimeContract({
        journey,
        preference: preference.replace(
          'candidate.effectiveValue === expectedValue',
          'Boolean(candidate.effectiveValue) === expectedValue',
        ),
        fixtures,
        client,
      }),
    ).toThrow();
  });

  it('registers one uncached serialized suite with started-only diagnostics', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['hide-system-messages'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain(
      '--suite=android.hide-system-messages',
    );
    expect(target.options.command).toContain('--timeout-ms=1200000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/hide-system-messages-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:hide-system-messages']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:hide-system-messages',
    );

    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.hide-system-messages'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:hide-system-messages'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:hide-system-messages'",
    );
    expect(runners).toContain("'maestro'");
    expect(commands).toContain("name: 'e2e:android:hide-system-messages'");
    expect(commands).toContain("suiteIds: ['android.hide-system-messages']");
    expect(workflow).toContain('hide-system-messages-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:hide-system-messages',
    );
    expect(workflow).toContain('surface: android-hide-system-messages');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.hide-system-messages/**',
    );
  });
});
