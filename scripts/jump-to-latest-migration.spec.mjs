import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/jump-to-latest.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const clientSource = 'e2e/android/account-workspace-client.mts';
const fixturesSource = 'e2e/android/account-workspace-fixtures.mts';
const contractPath = resolve(root, 'e2e/android/jump-to-latest-contract.mts');
const journeyPath = resolve(root, 'e2e/android/jump-to-latest-journeys.mts');

const assertionIds = [
  'jump-to-latest.room-ready',
  'jump-to-latest.timeline-visible',
  'jump-to-latest.initial.bottom-settled',
  'jump-to-latest.initial.pill-hidden',
  'jump-to-latest.initial.scrollable-range',
  'jump-to-latest.scrolled.pill-visible',
  'jump-to-latest.result.pill-hidden',
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

function jumpToLatestFixture(source) {
  const tree = ts.createSourceFile(
    fixturesSource,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches = [];
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'createJumpToLatestHistory'
    )
      matches.push(node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(matches, 'one owned jump-to-latest fixture function').toHaveLength(1);
  return matches[0];
}

function assertRuntimeContract({ journey, client, fixtures }) {
  const journeyFragments = [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "id: 'jump-to-latest'",
    'await fixtures.createJumpToLatestHistory(',
    'await client.login(account)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: history.roomName })",
    "const scrollSelector = '.scroll'",
    'const pillSelector = \'[data-testid="jump-to-latest"]\'',
    'history.newestEventId',
    'history.eventIds',
    'history.messageCount',
    'initial.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX',
    'initial.scrollableRange > JUMP_TO_LATEST_MIN_RANGE_PX',
    'const initialPill = await pillIsHidden(client, pillSelector)',
    'await client.swipeCurrent(scrollSelector,',
    "'decrease-scroll-top'",
    'scrolled.scrollTop < initial.scrollTop',
    'scrolled.bottomDistance > initial.bottomDistance',
    'const visiblePill = await client.visible(pillSelector, {}, 15_000)',
    'await client.tapCurrent(pillSelector)',
    'result.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX',
    'const resultPill = await pillIsHidden(client, pillSelector)',
    'expectedStages: 1',
    'expectedUniqueAssertions: 7',
    'expectedAssertionRecords: 7',
    'attempt: 1',
    'retries: 0',
    "secrets['SECRET_ROOM_NAME'] = roomName",
    "secrets['SECRET_LONG_BODY'] = longBody",
    'redactMaestroArtifacts(output, secrets, true)',
    'scanJumpToLatestArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const clientFragments = [
    'async swipeCurrent(',
    'await this.visible(selector)',
    'const upper = Math.round(visibleTop + visibleHeight * 0.2)',
    'const lower = Math.round(visibleBottom - visibleHeight * 0.2)',
    "const decreases = options.direction === 'decrease-scroll-top'",
    'const cssStart = { x, y: decreases ? upper : lower }',
    'const cssEnd = { x, y: decreases ? lower : upper }',
    'const start = await this.owner.nativePoint(cssStart)',
    'const end = await this.owner.nativePoint(cssEnd)',
    'durationMs >= 300 && durationMs <= 1_500',
    'duration: ${durationMs}',
    'await this.device.runFlow(flow, {})',
    'await this.owner.apply()',
    'scrollTop < before.scrollTop',
    'native swipe changed its offset',
  ];
  for (const fragment of clientFragments) expect(client).toContain(fragment);

  const fixtureFragments = [
    'createJumpToLatestHistory(',
    'JUMP_TO_LATEST_MESSAGE_COUNT',
    'for (let index = 0; index < JUMP_TO_LATEST_MESSAGE_COUNT; index++)',
    'const eventId = await sendMessage(',
    'eventIds.push(eventId)',
    'assert.equal(eventIds.length, JUMP_TO_LATEST_MESSAGE_COUNT)',
    "'m.fully_read': newestEventId",
    "'m.read': newestEventId",
    '/read_markers',
    'new Set(eventIds).size',
    'newestEventId,',
    'messageCount: JUMP_TO_LATEST_MESSAGE_COUNT',
  ];
  const ownedFixture = jumpToLatestFixture(fixtures);
  for (const fragment of fixtureFragments)
    expect(ownedFixture).toContain(fragment);

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|focusCurrent|fill|replace|navigate|reload)\s*\(/u,
  );
  expect(journey).not.toMatch(
    /mouse\.|scrollBy\(|scrollTo\(|dispatchEvent\(|\.scrollTop\s*=|\.click\(\)|\.focus\(\)|\.value\s*=/u,
  );
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

describe('Android jump-to-latest migration', () => {
  it('pins the exact predecessor, helpers and six direct plus one helper identity shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '1ecfdf0aad6c13326b81b0103bc7f9793f4754438a77bc8098060910c01e3209',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    const constantsAndHelpers = predecessor.slice(23, 110).join('\n');
    const roomHelper = predecessor.slice(103, 110).join('\n');
    const definition = predecessor.slice(114, 167).join('\n');
    expect(constantsAndHelpers).toContain('const MESSAGE_COUNT = 20');
    expect(constantsAndHelpers).toContain(
      'const LONG_BODY = `lorem ipsum dolor sit amet `.repeat(18)',
    );
    expect(constantsAndHelpers).toContain('async function apiLogin(');
    expect(constantsAndHelpers).toContain('async function seedBusyRoom(');
    expect(constantsAndHelpers).toContain("'m.fully_read': lastEventId");
    expect(constantsAndHelpers).toContain("'m.read': lastEventId");
    expect(roomHelper).toContain('async function openRoom');
    expect(roomHelper.match(/await expect\(/gu)).toHaveLength(1);
    expect(definition).toContain(
      "test('offers a jump-to-latest pill after scrolling up and returns to the bottom'",
    );
    expect(definition.match(/\bexpect\b/gu)).toHaveLength(6);
    expect(definition).toContain('element.scrollBy({ top: -3000 })');
    expect(app.join('\n')).toContain('export async function login(');
    expect(account.join('\n')).toContain('export async function registerUser(');
  });

  it('exports exactly seven identities and the native-swipe replacement boundary', async () => {
    expect(contractPath, 'jump-to-latest-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.JUMP_TO_LATEST_SOURCES).toEqual({
      setup: `${predecessorSource}:24-110`,
      helper: `${predecessorSource}:104-110`,
      definition: `${predecessorSource}:115-167`,
      app: appSource,
      account: accountSource,
    });
    expect(contract.JUMP_TO_LATEST_ANDROID_REPLACEMENT).toEqual({
      source: `${predecessorSource}:153-161`,
      predecessor: 'Android DOM scroll workaround',
      replacement: 'measured Maestro native swipe',
    });
    expect(Object.values(contract.jumpToLatestAssertions)).toEqual(
      assertionIds,
    );
    expect(new Set(Object.values(contract.jumpToLatestAssertions)).size).toBe(
      7,
    );
    expect(contract.JUMP_TO_LATEST_ASSERTION_RECORDS).toBe(7);
    expect(contract.JUMP_TO_LATEST_MESSAGE_COUNT).toBe(20);
    expect(contract.JUMP_TO_LATEST_BOTTOM_BOUND_PX).toBe(50);
    expect(contract.JUMP_TO_LATEST_MIN_RANGE_PX).toBe(300);
  });

  it('requires ordered messages, exact read markers, geometry and native ownership', () => {
    expect(journeyPath, 'jump-to-latest-journeys.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(journeyPath)) return;
    assertRuntimeContract({
      journey: readFileSync(journeyPath, 'utf8'),
      client: read(clientSource),
      fixtures: read(fixturesSource),
    });
  });

  it('keeps effective negative controls for the critical proof boundaries', () => {
    if (!existsSync(journeyPath)) return;
    const sources = {
      journey: readFileSync(journeyPath, 'utf8'),
      client: read(clientSource),
      fixtures: jumpToLatestFixture(read(fixturesSource)),
    };
    assertRuntimeContract(sources);
    const mutations = [
      {
        journey: sources.journey.replace(
          'expectedUniqueAssertions: 7',
          'expectedUniqueAssertions: 6',
        ),
      },
      {
        journey: sources.journey.replace(
          'initial.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX',
          'initial.bottomDistance < 500',
        ),
      },
      {
        journey: sources.journey.replace(
          'initial.scrollableRange > JUMP_TO_LATEST_MIN_RANGE_PX',
          'initial.scrollableRange > 0',
        ),
      },
      {
        journey: sources.journey.replace(
          'const initialPill = await pillIsHidden(client, pillSelector)',
          'const initialPill = { matches: 0, visibleMatches: 0 }',
        ),
      },
      {
        journey: sources.journey.replace(
          'scrolled.scrollTop < initial.scrollTop',
          'scrolled.scrollTop === initial.scrollTop',
        ),
      },
      {
        journey: sources.journey.replace(
          'const visiblePill = await client.visible(pillSelector, {}, 15_000)',
          'const visiblePill = { visible: true }',
        ),
      },
      {
        journey: sources.journey.replace(
          'result.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX',
          'result.bottomDistance < 500',
        ),
      },
      {
        journey: sources.journey.replace(
          'const resultPill = await pillIsHidden(client, pillSelector)',
          'const resultPill = { matches: 0, visibleMatches: 0 }',
        ),
      },
      {
        journey: sources.journey.replace(
          'scanJumpToLatestArtifacts(output, secrets)',
          'Promise.resolve()',
        ),
      },
      {
        client: sources.client.replaceAll(
          'scrollTop < before.scrollTop',
          'scrollTop === before.scrollTop',
        ),
      },
      {
        client: sources.client.replaceAll(
          'this.owner.nativePoint',
          'Promise.resolve',
        ),
      },
      {
        client: sources.client.replace(
          'const upper = Math.round(visibleTop + visibleHeight * 0.2)',
          'const upper = Math.round(visibleTop - visibleHeight * 0.2)',
        ),
      },
      {
        client: sources.client.replace(
          "options.direction === 'decrease-scroll-top'",
          "options.direction === 'increase-scroll-top'",
        ),
      },
      {
        client: sources.client.replace(
          'durationMs >= 300 && durationMs <= 1_500',
          'durationMs >= 0',
        ),
      },
      {
        fixtures: sources.fixtures.replace(
          'index < JUMP_TO_LATEST_MESSAGE_COUNT',
          'index < JUMP_TO_LATEST_MESSAGE_COUNT - 1',
        ),
      },
      {
        fixtures: sources.fixtures.replace(
          "'m.fully_read': newestEventId",
          "'m.fully_read': eventIds[0]",
        ),
      },
      {
        fixtures: sources.fixtures.replace(
          'const eventId = await sendMessage(',
          'const eventId = void sendMessage(',
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
      expect(source).toContain('jump-to-latest');
    }
    expect(project).toContain('--suite=android.jump-to-latest');
    expect(project).toContain('--timeout-ms=1200000');
    expect(project).toContain('--resource=android-avd --resource=synapse');
    expect(runners).toContain("id: 'android.jump-to-latest'");
    expect(runners).toContain("serializationKeys: ['android-avd', 'synapse']");
    expect(workflow).toContain('jump-to-latest-started=true');
    expect(workflow).toContain('--timeout-ms 1500000');
    expect(workflow).toContain('surface: android-jump-to-latest');
    expect(workflow).toContain(
      'dist/.playwright/trinity-e2e-android/*/android.jump-to-latest/**',
    );
    expect(
      workflow.indexOf('trinity-e2e-android:jump-to-latest'),
    ).toBeGreaterThan(workflow.indexOf('trinity-e2e-android:jump-to-date'));
  });

  it('does not weaken the retained predecessor while implementation files are absent', () => {
    expect(readIfPresent(journeyPath)).not.toMatch(
      /mouse\.|scrollBy\(|scrollTo\(|dispatchEvent\(|\.scrollTop\s*=/u,
    );
  });
});
