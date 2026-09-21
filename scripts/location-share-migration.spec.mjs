import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/location-share.spec.mts';
const androidFixtureSource = 'e2e/android/fixtures.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const workspaceFixturesSource = 'e2e/android/account-workspace-fixtures.mts';
const adapterPath = resolve(root, 'e2e/android/native-location-adapter.mts');
const contractPath = resolve(root, 'e2e/android/location-share-contract.mts');
const journeyPath = resolve(root, 'e2e/android/location-share-journeys.mts');

const assertionIds = [
  'location-share.room-ready',
  'location-share.server-echo-exact',
  'location-share.card-visible',
  'location-share.exact-coordinates',
  'location-share.osm-destination',
  'location-share.action-sheet-ready',
  'location-share.copy-link-visible',
  'location-share.edit-absent',
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
      /\.(?:click|focus|fill|submit|requestSubmit|scrollBy|scrollTo)\s*\(/u,
    );
    expect(expression).not.toMatch(
      /dispatchEvent\(|removeAttribute\(|setAttribute\(|\.value\s*=|\.scrollTop\s*=|\.scrollLeft\s*=|location\s*=|history\./u,
    );
  }
}

function assertRuntimeContract({ adapter, contract, fixtures, journey }) {
  const adapterFragments = [
    'export async function openNativeLocationAdapter(',
    "'android.permission.ACCESS_COARSE_LOCATION'",
    "'android.permission.ACCESS_FINE_LOCATION'",
    "'android:mock_location'",
    "'cmd',",
    "'location',",
    "'providers',",
    "'add-test-provider',",
    "'set-test-provider-enabled',",
    "'set-test-provider-location',",
    "'remove-test-provider',",
    "'--location',",
    'String(position.latitude)',
    'String(position.longitude)',
    'setInterval(',
    '1_000',
    'clearInterval(',
    'permissionBaselines',
    'providerBaseline',
    'mockLocationBaseline',
    "'grant'",
    "'revoke'",
    'restore',
    'close(): Promise<void>',
  ];
  for (const fragment of adapterFragments) expect(adapter).toContain(fragment);

  for (const id of assertionIds) expect(contract).toContain(id);
  expect(contract).toContain('LOCATION_SHARE_ASSERTION_RECORDS = 8');
  expect(contract).toContain('LOCATION_SHARE_LATITUDE = 40.7128');
  expect(contract).toContain('LOCATION_SHARE_LONGITUDE = -74.006');
  expect(contract).toContain(
    "LOCATION_SHARE_COORDINATES = '40.71280, -74.00600'",
  );
  expect(contract).toContain("LOCATION_SHARE_GEO_URI = 'geo:40.7128,-74.006'");

  const fixtureFragments = [
    'export interface WorkspaceLocationEvent',
    'latestLocationEvents(',
    "event['type'] !== 'm.room.message'",
    "content['msgtype'] !== 'm.location'",
    "content['geo_uri']",
    "content['org.matrix.msc3488.location']",
    "content['org.matrix.msc3488.asset']",
    '/messages?dir=b&limit=20',
  ];
  for (const fragment of fixtureFragments) expect(fixtures).toContain(fragment);

  const journeyFragments = [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "id: 'location-share'",
    "preset: 'private_chat'",
    'await openNativeLocationAdapter(',
    'LOCATION_SHARE_LATITUDE',
    'LOCATION_SHARE_LONGITUDE',
    'await client.login(account)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: room.name })",
    'await client.tapCurrent(\'[data-testid="composer-insert"]\')',
    'await client.tapCurrent(\'[data-testid="insert-location"]\')',
    'await fixtures.latestLocationEvents(account, roomId)',
    'events.length === 1',
    'event.sender === account.userId',
    "event.msgtype === 'm.location'",
    'event.geoUri === LOCATION_SHARE_GEO_URI',
    'event.msc3488Uri === LOCATION_SHARE_GEO_URI',
    "event.assetType === 'm.self'",
    'const rowSelector = `[data-mid=${JSON.stringify(event.eventId)}]`',
    'data-testid="location-card"',
    'LOCATION_SHARE_COORDINATES',
    "searchParams.get('mlat')",
    'String(LOCATION_SHARE_LATITUDE)',
    'await client.longPressCurrent(rowSelector)',
    'data-testid="action-sheet-surface"',
    'data-testid="sheet-copy-link"',
    'data-testid="sheet-edit"',
    'elements.length === 0',
    'expectedStages: 1',
    'expectedUniqueAssertions: 8',
    'expectedAssertionRecords: 8',
    'attempt: 1',
    'retries: 0',
    'redactMaestroArtifacts(output, secrets, true)',
    'scanLocationShareArtifacts(output, secrets)',
    'await locationAdapter.close()',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);
  expect(journey.indexOf('await client.close()')).toBeLessThan(
    journey.indexOf('await locationAdapter.close()'),
  );
  expect(journey.indexOf('await locationAdapter.close()')).toBeLessThan(
    journey.indexOf('await device.clearApplicationData(APPLICATION_ID)'),
  );

  expect(journey).not.toMatch(/fixtures\.sendMessage\s*\(/u);
  expect(journey).not.toMatch(/navigator\.geolocation|setGeolocation/u);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|focusCurrent|fill|replace|navigate|reload)\s*\(/u,
  );
  expect(journey).not.toMatch(
    /mouse\.|dispatchEvent\(|\.click\(\)|\.focus\(\)|\.value\s*=/u,
  );
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

describe('Android location-share migration', () => {
  it('pins the exact predecessor, Android adapter source and eight records', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '86e673e5bd86e014a6f5ee4b4eb1da11eb979013b6629a452153367405e76244',
    );
    const fixture = sourceLines(
      androidFixtureSource,
      '30f3489a4cac27685b03812e957a599d9ae4bef90985a55760f463fc702bfe8a',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    const geolocationHelper = predecessor.slice(18, 33).join('\n');
    const definition = predecessor.slice(37, 97).join('\n');
    expect(geolocationHelper).toContain("permissions: ['geolocation']");
    expect(geolocationHelper).toContain(
      'geolocation: { latitude: 40.7128, longitude: -74.006 }',
    );
    expect(geolocationHelper).toContain("getByTestId('rail-rooms')");
    expect(geolocationHelper).toContain("getByTestId('composer-input')");
    expect(definition).toContain("preset: 'private_chat'");
    expect(definition).toContain("getByTestId('composer-insert')");
    expect(definition).toContain("getByTestId('insert-location')");
    expect(definition).toContain("getByTestId('location-card')");
    expect(definition).toContain("toContainText('40.71280, -74.00600')");
    expect(definition).toContain('mlat=40\\.7128');
    expect(definition).toContain('await waitForSent(row.first())');
    expect(definition).toContain('await openMessageActionSheet(');
    expect(definition).toContain("getByTestId('sheet-copy-link')");
    expect(definition).toContain("getByTestId('sheet-edit')");
    expect(definition.match(/await expect\(/gu)).toHaveLength(7);
    const androidBranch = definition
      .slice(definition.indexOf('if (isAndroidE2E)'))
      .split('} else {', 1)[0];
    expect(androidBranch.match(/await expect\(/gu)).toHaveLength(2);
    expect(
      definition
        .slice(0, definition.indexOf('if (isAndroidE2E)'))
        .match(/await expect\(/gu),
    ).toHaveLength(3);

    const nativeLocationSource = fixture.slice(288, 297).join('\n');
    const nativeAdapter = fixture.slice(501, 617).join('\n');
    expect(nativeLocationSource).toContain(
      'cmd location providers set-test-provider-location gps',
    );
    expect(nativeAdapter).toContain(
      "'android.permission.ACCESS_COARSE_LOCATION'",
    );
    expect(nativeAdapter).toContain(
      "'android.permission.ACCESS_FINE_LOCATION'",
    );
    expect(nativeAdapter).toContain('android:mock_location allow');
    expect(nativeAdapter).toContain('add-test-provider gps');
    expect(nativeAdapter).toContain('setInterval(pulseLocation, 1_000)');
    expect(nativeAdapter).toContain('remove-test-provider gps');
    expect(nativeAdapter).toContain('android:mock_location default');
    expect(app.join('\n')).toContain('export async function login(');
    expect(account.join('\n')).toContain('export async function registerUser(');
    expect(new Set(assertionIds).size).toBe(8);
  });

  it('owns one exact native stage and rejects critical shortcut mutations', () => {
    const sources = {
      adapter: readIfPresent(adapterPath),
      contract: readIfPresent(contractPath),
      fixtures: read(workspaceFixturesSource),
      journey: readIfPresent(journeyPath),
    };
    assertRuntimeContract(sources);

    const mutations = [
      {
        adapter: sources.adapter.replace(
          "'android.permission.ACCESS_FINE_LOCATION'",
          "'android.permission.POST_NOTIFICATIONS'",
        ),
      },
      {
        adapter: sources.adapter.replaceAll(
          'permissionBaselines',
          'permissions',
        ),
      },
      {
        adapter: sources.adapter.replaceAll('providerBaseline', 'provider'),
      },
      {
        adapter: sources.adapter.replaceAll('mockLocationBaseline', 'mockMode'),
      },
      {
        adapter: sources.adapter.replace("'revoke'", "'grant'"),
      },
      {
        adapter: sources.adapter.replace('clearInterval(', 'void ('),
      },
      {
        contract: sources.contract.replace('40.7128', '40.7'),
      },
      {
        contract: sources.contract.replace('-74.006', '-74'),
      },
      {
        journey: sources.journey.replaceAll(
          'events.length === 1',
          'events.length > 0',
        ),
      },
      {
        journey: sources.journey.replaceAll(
          'event.sender === account.userId',
          'Boolean(event.sender)',
        ),
      },
      {
        journey: sources.journey.replaceAll(
          "event.msgtype === 'm.location'",
          'Boolean(event.msgtype)',
        ),
      },
      {
        journey: sources.journey.replaceAll(
          'event.geoUri === LOCATION_SHARE_GEO_URI',
          'Boolean(event.geoUri)',
        ),
      },
      {
        journey: sources.journey.replaceAll(
          'event.msc3488Uri === LOCATION_SHARE_GEO_URI',
          'Boolean(event.msc3488Uri)',
        ),
      },
      {
        journey: sources.journey.replace(
          'const rowSelector = `[data-mid=${JSON.stringify(event.eventId)}]`',
          "const rowSelector = '.scroll .msg'",
        ),
      },
      {
        journey: sources.journey.replace(
          "searchParams.get('mlat')",
          "searchParams.has('mlat')",
        ),
      },
      {
        journey: sources.journey.replace(
          'await client.longPressCurrent(rowSelector)',
          'void rowSelector',
        ),
      },
      {
        journey: sources.journey.replace(
          'elements.length === 0',
          'elements.length >= 0',
        ),
      },
      {
        journey: sources.journey.replace(
          'await locationAdapter.close()',
          'void locationAdapter',
        ),
      },
      {
        journey: sources.journey.replace(
          'scanLocationShareArtifacts(output, secrets)',
          'Promise.resolve()',
        ),
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      expect(
        () => assertRuntimeContract({ ...sources, ...mutation }),
        `critical negative control ${index + 1}`,
      ).toThrow();
    }
  });

  it('wires the serial target, registry, ordered CI diagnostics and ledger', () => {
    const project = read('e2e/android/project.json');
    const packageJson = read('package.json');
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const docs = read('e2e/android/MIGRATION.md');
    for (const source of [
      project,
      packageJson,
      runners,
      commands,
      workflow,
      docs,
    ]) {
      expect(source).toContain('location-share');
    }
    expect(project).toContain('--suite=android.location-share');
    expect(project).toContain('--timeout-ms=1200000');
    expect(project).toContain('--resource=android-avd --resource=synapse');
    expect(runners).toContain("id: 'android.location-share'");
    expect(runners).toContain("serializationKeys: ['android-avd', 'synapse']");
    expect(workflow).toContain('location-share-started=true');
    expect(workflow).toContain('--timeout-ms 1500000');
    expect(workflow).toContain('surface: android-location-share');
    expect(workflow).toContain(
      'dist/.playwright/trinity-e2e-android/*/android.location-share/**',
    );
    expect(
      workflow.indexOf('trinity-e2e-android:location-share'),
    ).toBeGreaterThan(workflow.indexOf('trinity-e2e-android:link-preview'));
  });

  it('does not weaken the retained predecessor while migration files are absent', () => {
    expect(readIfPresent(journeyPath)).not.toMatch(
      /mouse\.|dispatchEvent\(|\.click\(\)|\.focus\(\)|\.value\s*=/u,
    );
  });
});
