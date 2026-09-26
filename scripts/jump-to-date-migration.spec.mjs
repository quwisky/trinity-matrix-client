import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/jump-to-date.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const fixturesSource = 'e2e/android/account-workspace-fixtures.mts';
const contractPath = resolve(root, 'e2e/android/jump-to-date-contract.mts');
const observerPath = resolve(
  root,
  'e2e/android/jump-to-date-network-observer.mts',
);
const journeyPath = resolve(root, 'e2e/android/jump-to-date-journeys.mts');

const assertionIds = [
  'jump-to-date.room-ready',
  'jump-to-date.initial.newest-visible',
  'jump-to-date.initial.marker-absent',
  'jump-to-date.dialog.current-date',
  'jump-to-date.result.marker-visible',
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
      /dispatchEvent\(|removeAttribute\(|setAttribute\(|\.value\s*=|location\s*=|history\./u,
    );
  }
}

function assertRuntimeContract({ journey, observer, fixtures }) {
  const journeyFragments = [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "id: 'history-backfill'",
    'await fixtures.createJumpToDateHistory(',
    'await client.login(account)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: history.roomName })",
    '\'[data-testid="composer-input"]\'',
    'history.newestFillerBody',
    'history.markerEventId',
    'await readDeviceLocalDate(device)',
    'await openJumpToDateNetworkObserver(',
    'await client.tapCurrent(\'[data-testid="room-actions-overflow"]\')',
    'await client.tapCurrent(\'[data-testid="overflow-jump-to-date"]\')',
    '\'[data-testid="jump-to-date-input"]\'',
    'await client.tapCurrent(\'[data-testid="jump-to-date-confirm"]\')',
    'await observer.waitForLookup()',
    'await observer.close()',
    'expectedStages: 1',
    'expectedUniqueAssertions: 5',
    'expectedAssertionRecords: 5',
    'attempt: 1',
    'retries: 0',
    "secrets['SECRET_ROOM_NAME'] = roomName",
    "secrets['SECRET_MARKER_BODY'] = markerBody",
    "secrets['SECRET_FILLER_PREFIX'] = fillerPrefix",
    'redactMaestroArtifacts(output, secrets, true)',
    'scanJumpToDateArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const observerFragments = [
    "connection.on('Network.requestWillBeSent'",
    "await connection.send('Network.enable')",
    "await connection.send('Network.disable')",
    "request.method !== 'GET'",
    "url.searchParams.get('dir') !== 'f'",
    "url.searchParams.get('ts')",
    "pathname.endsWith('/timestamp_to_event')",
    'decodeURIComponent(roomSegment) !== roomId',
    'waitForNativeShellState(',
    'unsubscribe()',
    'connection.close()',
    "device.adb('shell', 'date', '+%F')",
  ];
  for (const fragment of observerFragments)
    expect(observer).toContain(fragment);

  const fixtureFragments = [
    'createJumpToDateHistory(',
    'const markerEventId = await sendMessage(',
    'const fillerEventIds:',
    'FILLER_COUNT - 1',
    'await Promise.all(',
    'const newestFillerEventId = await sendMessage(',
    'assert.equal(fillerEventIds.length, FILLER_COUNT)',
    'new Set([markerEventId, ...fillerEventIds]).size',
    'FILLER_COUNT + 1',
    'markerEventId,',
    'newestFillerEventId,',
  ];
  for (const fragment of fixtureFragments) expect(fixtures).toContain(fragment);

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|focusCurrent|fill|replace|navigate|reload)\s*\(/u,
  );
  expect(journey).not.toMatch(
    /removeAttribute\(['"]max['"]\)|dispatchEvent\(|setDate\(|tomorrow|future-date/iu,
  );
  expect(observer).not.toMatch(
    /Fetch\.|setBlockedURLs|continueRequest|fulfillRequest/u,
  );
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

describe('Android jump-to-date migration', () => {
  it('pins the exact predecessor and four direct plus one helper identity shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '99a1ae1ec8873d2a45795003604d9c83c162d5d33c5415899e41581e97d4fd04',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    const helper = predecessor.slice(21, 30).join('\n');
    const applicable = predecessor.slice(41, 119).join('\n');
    const browserOnly = predecessor.slice(120, 176).join('\n');
    expect(helper).toContain('async function openRoom');
    expect(helper.match(/await expect\(/gu)).toHaveLength(1);
    expect(applicable).toContain(
      "test('pages history back to reach a message that was not loaded'",
    );
    expect(applicable.match(/await expect\(/gu)).toHaveLength(4);
    expect(applicable).toContain(
      'for (let batch = 0; batch < 120; batch += 20)',
    );
    expect(browserOnly).toContain(
      "test('reports a date with nothing on it instead of jumping'",
    );
    expect(browserOnly).toContain("field.removeAttribute('max')");
    expect(browserOnly).toContain("field.dispatchEvent(new Event('input'");
    expect(app.join('\n')).toContain('export async function login(');
    expect(account.join('\n')).toContain('export async function registerUser(');
  });

  it('exports exactly five identities and the explicit browser-only boundary', async () => {
    expect(contractPath, 'jump-to-date-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.JUMP_TO_DATE_SOURCES).toEqual({
      helper: `${predecessorSource}:22-30`,
      applicable: `${predecessorSource}:42-119`,
      browserOnly: `${predecessorSource}:121-176`,
      app: appSource,
      account: accountSource,
    });
    expect(contract.JUMP_TO_DATE_BROWSER_ONLY).toEqual({
      source: `${predecessorSource}:121-176`,
      reason: 'requires forbidden future-date DOM mutation',
    });
    expect(Object.values(contract.jumpToDateAssertions)).toEqual(assertionIds);
    expect(new Set(Object.values(contract.jumpToDateAssertions)).size).toBe(5);
    expect(contract.JUMP_TO_DATE_ASSERTION_RECORDS).toBe(5);
    expect(contract.JUMP_TO_DATE_FILLER_COUNT).toBe(120);
  });

  it('requires ordered event setup, exact lookup evidence and native ownership', () => {
    expect(
      observerPath,
      'jump-to-date-network-observer.mts must exist',
    ).toSatisfy(existsSync);
    expect(journeyPath, 'jump-to-date-journeys.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(observerPath) || !existsSync(journeyPath)) return;
    assertRuntimeContract({
      journey: readFileSync(journeyPath, 'utf8'),
      observer: readFileSync(observerPath, 'utf8'),
      fixtures: read(fixturesSource),
    });
  });

  it('keeps effective negative controls for the critical proof boundaries', () => {
    if (!existsSync(observerPath) || !existsSync(journeyPath)) return;
    const sources = {
      journey: readFileSync(journeyPath, 'utf8'),
      observer: readFileSync(observerPath, 'utf8'),
      fixtures: read(fixturesSource),
    };
    const mutations = [
      {
        journey: sources.journey.replace(
          'expectedUniqueAssertions: 5',
          'expectedUniqueAssertions: 4',
        ),
      },
      {
        journey: sources.journey.replaceAll(
          'history.markerEventId',
          'history.newestFillerEventId',
        ),
      },
      {
        journey: sources.journey.replace(
          'await observer.close()',
          'void observer',
        ),
      },
      {
        journey: sources.journey.replace(
          'scanJumpToDateArtifacts(output, secrets)',
          'Promise.resolve()',
        ),
      },
      {
        observer: sources.observer.replace(
          "request.method !== 'GET'",
          "request.method !== 'POST'",
        ),
      },
      {
        observer: sources.observer.replace(
          "url.searchParams.get('dir') !== 'f'",
          "url.searchParams.get('dir') !== 'b'",
        ),
      },
      {
        observer: sources.observer.replace(
          'decodeURIComponent(roomSegment) !== roomId',
          'decodeURIComponent(roomSegment) === roomId',
        ),
      },
      {
        observer: sources.observer.replace(
          "await connection.send('Network.disable')",
          'void connection',
        ),
      },
      {
        fixtures: sources.fixtures.replaceAll(
          'FILLER_COUNT - 1',
          'FILLER_COUNT - 2',
        ),
      },
      {
        fixtures: sources.fixtures.replace('FILLER_COUNT + 1', 'FILLER_COUNT'),
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      expect(
        () => assertRuntimeContract({ ...sources, ...mutation }),
        `critical negative control ${index + 1}`,
      ).toThrow();
    }
  });

  it('wires the uncached serial target, registry, CI diagnostics and ledger', () => {
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
      expect(source).toContain('jump-to-date');
    }
    expect(project).toContain('--suite=android.jump-to-date');
    expect(project).toContain('--timeout-ms=1200000');
    expect(project).toContain('--resource=android-avd --resource=synapse');
    expect(runners).toContain("id: 'android.jump-to-date'");
    expect(runners).toContain("serializationKeys: ['android-avd', 'synapse']");
    expect(workflow).toContain('jump-to-date-started=true');
    expect(workflow).toContain('--timeout-ms 1500000');
    expect(workflow).toContain('surface: android-jump-to-date');
    expect(workflow).toContain(
      'dist/.playwright/trinity-e2e-android/*/android.jump-to-date/**',
    );
    expect(
      workflow.indexOf('trinity-e2e-android:jump-to-date'),
    ).toBeGreaterThan(
      workflow.indexOf('trinity-e2e-android:hide-system-messages'),
    );
  });

  it('does not weaken the retained predecessor while implementation files are absent', () => {
    expect(readIfPresent(journeyPath)).not.toContain("removeAttribute('max')");
    expect(readIfPresent(observerPath)).not.toContain('Fetch.enable');
  });
});
