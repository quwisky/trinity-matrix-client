import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-action-sheet.spec.mts';
const paths = {
  contract: 'e2e/android/message-action-sheet-contract.mts',
  observer: 'e2e/android/message-action-sheet-observer.mts',
  artifacts: 'e2e/android/message-action-sheet-artifacts.mts',
  journey: 'e2e/android/message-action-sheet-journeys.mts',
  fixture: 'e2e/android/account-workspace-fixtures.mts',
  client: 'e2e/android/account-workspace-client.mts',
};
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readPresent = (path) =>
  existsSync(resolve(root, path)) ? read(path) : '';

// These are independently mapped from the pinned predecessor's assertion sites.
const stageAssertions = {
  reply: [
    'room-ready',
    'toolbar-absent',
    'body-wide',
    'sheet-visible',
    'revealed-row-absent',
    'single-named-dialog',
    'sheet-box-present',
    'clearance.sheet-present',
    'clearance.row-inside-top',
    'clearance.row-inside-bottom',
    'clearance.eight-pixel-gap',
    'sheet-top-in-viewport',
    'sheet-bottom-in-viewport',
    'cancel-visible',
    'cancel-box-present',
    'cancel-bottom-in-viewport',
    'sheet-closed',
    'reply-banner',
  ],
  'quick-reaction': [
    'room-ready',
    'sheet-visible',
    'sheet-closed',
    'reaction-ready',
  ],
  'backdrop-dismiss': [
    'room-ready',
    'sheet-visible',
    'sheet-closed',
    'no-action',
  ],
  'virtualized-latest': [
    'room-ready',
    'virtual-list-visible',
    'oldest-filler-rendered',
    'jump-visible',
    'latest-target-visible',
    'jump-hidden-before',
    'virtual-row-cap',
    'sheet-visible',
    'single-connected-target',
    'clearance.sheet-present',
    'clearance.row-inside-top',
    'clearance.row-inside-bottom',
    'clearance.eight-pixel-gap',
    'jump-hidden-during',
    'sheet-closed',
    'target-visible-after',
    'position-restored',
    'jump-hidden-after',
  ],
  'thread-target': [
    'room-ready',
    'thread-visible',
    'thread-row-visible',
    'sheet-visible',
    'clearance.sheet-present',
    'clearance.row-inside-top',
    'clearance.row-inside-bottom',
    'clearance.eight-pixel-gap',
    'sheet-closed',
    'position-restored',
  ],
};
const expectedIdentities = Object.entries(stageAssertions).flatMap(
  ([stage, ids]) => ids.map((id) => `message-action-sheet.${stage}.${id}`),
);
const definitions = [
  [
    'reply',
    151,
    214,
    13,
    'a long press opens a sheet, and picking Reply starts a reply',
  ],
  [
    'quick-reaction',
    216,
    239,
    3,
    'reacting from the sheet puts the reaction on the message',
  ],
  [
    'backdrop-dismiss',
    241,
    259,
    3,
    'tapping outside closes the sheet without acting',
  ],
  [
    'virtualized-latest',
    261,
    306,
    12,
    'keeps a windowed target connected and restores the latest state on close',
  ],
  [
    'thread-target',
    308,
    334,
    4,
    'keeps the acted-on thread reply above the same sheet',
  ],
];

function expectCalls(source) {
  const tree = ts.createSourceFile(
    'source.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let count = 0;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        (ts.isIdentifier(expression) && expression.text === 'expect') ||
        (ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === 'expect' &&
          expression.name.text === 'poll')
      )
        count++;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return count;
}

function requireFragments(source, fragments) {
  for (const fragment of fragments) expect(source).toContain(fragment);
}

function assertReadOnly(source) {
  // Observer/journey renderer expressions must never perform product actions.
  expect(source).not.toMatch(
    /\.(?:dispatchEvent|click|focus|fill|submit|requestSubmit|scrollTo|scrollBy|scrollIntoView|scrollIntoViewIfNeeded)\s*\(/u,
  );
  expect(source).not.toMatch(
    /\.(?:scrollTop|scrollLeft|location|value)\s*=(?!=)/u,
  );
  expect(source).not.toMatch(
    /Input\.dispatchTouchEvent|Runtime\.callFunctionOn|\.goto\s*\(/u,
  );
}

function functionSource(source, name) {
  const tree = ts.createSourceFile(
    'journey.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const matches = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      matches.push(node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(matches, `one owned ${name} function`).toHaveLength(1);
  return matches[0];
}

function assertNativeRuntime(sources) {
  requireFragments(sources.journey, [
    'installWithAndroidRuntimeProvenance(',
    'runtime-provenance.json',
    'messageActionSheetCases',
    'expectedUniqueAssertions: 54',
    'expectedAssertionRecords: 54',
    'attempt: 1',
    'retries: 0',
    'await client.login(',
    'await client.longPressCurrent(',
    'await client.swipeCurrent(',
    'await client.tapCurrentExposed(',
    'sheet-reply',
    'sheet-react-👍',
    'sheet-thread',
    'jump-to-latest',
    'thread-view',
    '.cdk-overlay-backdrop',
    'Cancel',
    'Replying to',
    'assertSheetClearance(',
    'assertSheetViewport(',
    'assertSheetPositionRestored(',
    'assertSheetReaction(',
    'createMessageActionSheetHistory(',
    'messageActionSheetReactionEvents(',
    'rowCount < 80',
    'bodyWidth > 200',
    'toolbarCount === 0',
    'revealedCount === 0',
    'dialogCount === 1',
    'bannerCount === 0',
    'reactionEvents.length === 0',
    'cancelBottom <= viewportHeight + 1',
    'client.capture(',
    'await client.close()',
    'await device.clearApplicationData(',
    'redactMaestroArtifacts(',
    "matrixResources.cleanup('Scan message-action-sheet diagnostics', () => scanArtifacts(output, secrets));",
    'scanMessageActionSheetArtifacts as scanArtifacts',
    'Object.assign(secrets, messageActionSheetSecrets(entry.id, account, roomName));',
    'Object.assign(secrets, messageActionSheetSecrets(entry.id, account, roomName, history));',
  ]);
  requireFragments(functionSource(sources.journey, 'reply'), [
    "values[0]!.text.replace(/\\s+/gu, ' ').trim() === `Replying to ${author.text}`",
  ]);
  requireFragments(functionSource(sources.journey, 'virtualizedLatest'), [
    "positionReference: 'bottom'",
    "'history-initial-position'",
    'const before = await relativeTop(client, selector);',
    'await dismissSheet(client);',
    'await restored(context, selector, before);',
  ]);
  requireFragments(functionSource(sources.journey, 'threadTarget'), [
    'const before = await relativeTop(client, threadRow);',
    'await dismissSheet(client);',
    'await restored(context, threadRow, before);',
  ]);
  requireFragments(functionSource(sources.journey, 'restored'), [
    '() => relativeTop(context.client, selector)',
    'assertSheetPositionRestored(before, after);',
  ]);
  requireFragments(sources.artifacts, [
    'nativeStorageMethodDataIsRedacted(',
    'SECRET_',
    'JSON.stringify(value).slice(1, -1)',
  ]);
  const install = sources.journey.indexOf(
    'await installWithAndroidRuntimeProvenance(',
  );
  const stages = sources.journey.indexOf(
    'for (const entry of messageActionSheetCases)',
  );
  expect(install).toBeGreaterThan(-1);
  expect(stages).toBeGreaterThan(install);
  expect(sources.journey).not.toContain('await device.install(');
  assertReadOnly(sources.journey);
  assertReadOnly(sources.observer);
  requireFragments(sources.observer, [
    'evaluateNative(',
    'getBoundingClientRect()',
    'isConnected',
    'data-message-scroller',
    'action-sheet-surface',
    'Message actions',
    'rowTop >= scrollerTop - 1',
    'rowBottom <= scrollerBottom + 1',
    'rowBottom + 8 <= sheetTop + 0.5',
    'sheetTop >= 0',
    'sheetBottom <= viewportHeight + 1,',
    'Math.abs(after - before) <= 2,',
    "assert.equal(receipt.key, '👍'",
  ]);
  requireFragments(sources.fixture, [
    'createMessageActionSheetHistory(',
    'messageActionSheetReactionEvents(',
    'index < 80',
    'sheet filler v',
    'act on me',
    "event['type'] === 'm.reaction'",
    "event['sender'] === account.userId",
    "relation['rel_type'] === 'm.annotation'",
    "relation['event_id'] === eventId",
    "key: typeof relation['key'] === 'string' ? relation['key'] : ''",
  ]);
  requireFragments(sources.client, [
    'const LONG_PRESS_DURATION_MS = 750',
    'event.trusted === true',
    'event.matched === true',
    'durationMs >= LONG_PRESS_THRESHOLD_MS',
    'allowBlankPadding: options.allowBlankPadding === true',
    'if(!allowBlankPadding){\n            const candidates=',
    'if(!allowBlankPadding)return null',
    "assert(target.paddingBounds, 'Opt-in blank-padding press must use measured row padding')",
    'nativeLongPressPaddingCandidates.toString()',
    'points.every(({x,y})=>document.elementFromPoint(x,y)===element)',
    'point.x + LONG_PRESS_DRIFT_PX < end.x',
    'Native padding long press requires no existing text selection',
    'Native padding long-press path stayed inside the measured blank envelope',
    "assert.equal(length, 0, 'Native padding long press must not select text')",
    'async swipeCurrent(',
    "const positionReference = options.positionReference ?? 'top'",
    'nativeSwipeAdvanced(before, rows[0]!, options.direction, positionReference)',
    'nativeSwipeAdvanced(before, after, options.direction, positionReference)',
    'Native swipe coordinates must be exact integers',
    'Native swipe changed its offset in the expected direction',
    'async tapCurrentExposed(',
    'exposedPoint: true',
  ]);
}

async function observerModule() {
  const path = resolve(root, paths.observer);
  expect(existsSync(path), 'message-action-sheet observer must exist').toBe(
    true,
  );
  return import(path);
}

const validGeometry = {
  rowCount: 1,
  rowConnected: true,
  scrollerPresent: true,
  rowTop: 100,
  rowBottom: 180,
  scrollerTop: 50,
  scrollerBottom: 200,
  sheetPresent: true,
  sheetTop: 188,
  sheetBottom: 700,
  viewportHeight: 727,
};

describe('Android message-action-sheet migration', () => {
  it('pins five predecessors, 35 direct sites and all 19 helper expansions', () => {
    for (const [path, digest] of [
      [
        predecessor,
        'df1d0bdb6a3ea0e2b16227d26b00b5b8138485cfba27b8ee4782945c22cb91aa',
      ],
      [
        'e2e/support/touch-platform.mts',
        '8bbf71ffc3e83010599c30ed5c2c347972f5a7b559daa6394613e33af2c43ee1',
      ],
      [
        'e2e/support/app.mts',
        '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
      ],
      [
        'e2e/support/account.mts',
        'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
      ],
    ])
      expect(createHash('sha256').update(read(path)).digest('hex')).toBe(
        digest,
      );
    const lines = read(predecessor).split('\n');
    for (const [, start, end, direct, title] of definitions) {
      const span = lines.slice(start - 1, end).join('\n');
      expect(span).toContain(`test('${title}'`);
      expect(expectCalls(span)).toBe(direct);
      expect(span.match(/await openRoomWithMessage\(/gu)).toHaveLength(1);
    }
    const fixture = lines.slice(38, 92).join('\n');
    const clearance = lines.slice(93, 118).join('\n');
    const restoration = lines.slice(132, 143).join('\n');
    expect(expectCalls(fixture)).toBe(1);
    expect(expectCalls(clearance)).toBe(4);
    expect(expectCalls(restoration)).toBe(1);
    expect(
      read(predecessor).match(/await expectMessageClearOfSheet\(/gu),
    ).toHaveLength(3);
    expect(
      read(predecessor).match(/await expectScrollerPositionRestored\(/gu),
    ).toHaveLength(2);
    expect(read('e2e/support/touch-platform.mts')).toContain(
      'await page.waitForTimeout(700)',
    );
    expect(Object.values(stageAssertions).map((ids) => ids.length)).toEqual([
      18, 4, 4, 18, 10,
    ]);
    expect(expectedIdentities).toHaveLength(54);
    expect(new Set(expectedIdentities).size).toBe(54);
  });

  it('exports exact stage/source mappings and each uniquely owned assertion', async () => {
    const path = resolve(root, paths.contract);
    expect(existsSync(path), 'message-action-sheet contract must exist').toBe(
      true,
    );
    const contract = await import(path);
    expect(contract.MESSAGE_ACTION_SHEET_ASSERTION_RECORDS).toBe(54);
    expect(contract.messageActionSheetAssertions).toEqual(expectedIdentities);
    expect(
      contract.messageActionSheetCases.map(({ id, source, assertions }) => ({
        id,
        source,
        assertions,
      })),
    ).toEqual(
      definitions.map(([id, start, end]) => ({
        id,
        source: `${predecessor}:${start}-${end}`,
        assertions: stageAssertions[id].map(
          (name) => `message-action-sheet.${id}.${name}`,
        ),
      })),
    );
  });

  it('rejects disconnected, clipped or covered targets instead of vacuous clearance', async () => {
    const { assertSheetClearance, assertSheetViewport } =
      await observerModule();
    expect(() => assertSheetClearance(validGeometry)).not.toThrow();
    expect(() => assertSheetViewport(validGeometry)).not.toThrow();
    // Literal edge fixtures preserve exactly one-pixel scroller and half-pixel gap tolerance.
    expect(() =>
      assertSheetClearance({
        ...validGeometry,
        rowTop: 49,
        rowBottom: 201,
        sheetTop: 208.5,
      }),
    ).not.toThrow();
    for (const mutation of [
      { rowCount: 0 },
      { rowCount: 2 },
      { rowConnected: false },
      { scrollerPresent: false },
      { sheetPresent: false },
      { rowTop: 48.9 },
      { rowBottom: 201.1, sheetTop: 220 },
      { sheetTop: 187.4 },
      { rowTop: 180 },
      { scrollerBottom: 50 },
      { rowTop: NaN },
      { rowBottom: Infinity },
      { sheetTop: NaN },
    ])
      expect(() =>
        assertSheetClearance({ ...validGeometry, ...mutation }),
      ).toThrow();
    expect(() =>
      assertSheetViewport({ ...validGeometry, sheetBottom: 728 }),
    ).not.toThrow();
    for (const mutation of [
      { sheetPresent: false },
      { sheetTop: -0.1 },
      { sheetBottom: 728.1 },
      { viewportHeight: 0 },
      { viewportHeight: NaN },
      { sheetBottom: Infinity },
      { sheetBottom: 180 },
    ])
      expect(() =>
        assertSheetViewport({ ...validGeometry, ...mutation }),
      ).toThrow();
  });

  it('requires actual latest and Thread restoration within two finite CSS pixels', async () => {
    const { assertSheetPositionRestored } = await observerModule();
    for (const [before, after] of [
      [100, 100],
      [100, 102],
      [100, 98],
      [-20, -18],
    ]) {
      expect(() => assertSheetPositionRestored(before, after)).not.toThrow();
    }
    for (const [before, after] of [
      [100, 102.01],
      [100, 97.99],
      [NaN, 100],
      [100, NaN],
      [Infinity, Infinity],
    ]) {
      expect(() => assertSheetPositionRestored(before, after)).toThrow();
    }
  });

  it('requires a ready exact server-backed reaction rather than optimistic UI', async () => {
    const { assertSheetReaction } = await observerModule();
    const receipt = {
      eventIdPresent: true,
      senderMatches: true,
      targetMatches: true,
      annotation: true,
      key: '👍',
      ready: true,
    };
    expect(() => assertSheetReaction(receipt)).not.toThrow();
    for (const mutation of [
      { eventIdPresent: false },
      { senderMatches: false },
      { targetMatches: false },
      { annotation: false },
      { key: '❤' },
      { ready: false },
    ])
      expect(() => assertSheetReaction({ ...receipt, ...mutation })).toThrow();
  });

  it('requires native gestures, exact semantics, provenance and bounded cleanup', () => {
    const sources = Object.fromEntries(
      Object.entries(paths).map(([name, path]) => [name, readPresent(path)]),
    );
    assertNativeRuntime(sources);
  });

  it('detects realistic ownership, geometry, semantic and cleanup mutations', () => {
    const sources = Object.fromEntries(
      Object.entries(paths).map(([name, path]) => [name, readPresent(path)]),
    );
    assertNativeRuntime(sources);
    const mutations = [
      [
        'client',
        'const LONG_PRESS_DURATION_MS = 750',
        'const LONG_PRESS_DURATION_MS = 400',
      ],
      ['client', 'event.trusted === true', 'event.trusted !== undefined'],
      ['client', 'if(!allowBlankPadding)return null', ''],
      [
        'client',
        'if(!allowBlankPadding){\n            const candidates=',
        'if(true){\n            const candidates=',
      ],
      [
        'client',
        "assert(target.paddingBounds, 'Opt-in blank-padding press must use measured row padding')",
        '',
      ],
      [
        'client',
        'nativeLongPressPaddingCandidates.toString()',
        '(() => []).toString()',
      ],
      [
        'client',
        'points.every(({x,y})=>document.elementFromPoint(x,y)===element)',
        'true',
      ],
      ['client', 'point.x + LONG_PRESS_DRIFT_PX < end.x', 'true'],
      [
        'client',
        "assert.equal(length, 0, 'Native padding long press must not select text')",
        'void length',
      ],
      [
        'client',
        'nativeSwipeAdvanced(before, rows[0]!, options.direction, positionReference)',
        'true',
      ],
      [
        'client',
        'nativeSwipeAdvanced(before, after, options.direction, positionReference)',
        'true',
      ],
      ['observer', 'rowTop >= scrollerTop - 1', 'rowTop >= -10000'],
      ['observer', 'rowBottom <= scrollerBottom + 1', 'rowBottom <= 10000'],
      [
        'observer',
        'rowBottom + 8 <= sheetTop + 0.5',
        'rowBottom <= sheetTop + 8',
      ],
      ['observer', 'sheetTop >= 0', 'sheetTop >= -1000'],
      [
        'observer',
        'sheetBottom <= viewportHeight + 1',
        'sheetBottom <= viewportHeight + 1000',
      ],
      [
        'observer',
        'Math.abs(after - before) <= 2',
        'Math.abs(after - before) <= 20',
      ],
      ['journey', 'toolbarCount === 0', 'toolbarCount >= 0'],
      ['journey', 'revealedCount === 0', 'revealedCount >= 0'],
      ['journey', 'dialogCount === 1', 'dialogCount >= 0'],
      ['journey', 'sheet-react-👍', 'sheet-react-more'],
      ['journey', 'rowCount < 80', 'rowCount <= 81'],
      ['journey', 'reactionEvents.length === 0', 'reactionEvents.length >= 0'],
      ['journey', 'await client.swipeCurrent(', 'await client.scrollTo('],
      [
        'journey',
        'await client.tapCurrentExposed(',
        'await client.tapCurrent(',
      ],
      ['journey', 'await device.clearApplicationData(', 'void skippedCleanup('],
      ['journey', 'redactMaestroArtifacts(', 'skipRedaction('],
      [
        'journey',
        'installWithAndroidRuntimeProvenance(',
        'installWithoutReceipt(',
      ],
      ['fixture', 'index < 80', 'index < 79'],
      [
        'observer',
        "assert.equal(receipt.key, '👍'",
        'assert.equal(receipt.key, receipt.key',
      ],
      [
        'journey',
        'await restored(context, selector, before)',
        "await record(context, 'position-restored', { unchecked: true })",
      ],
      ['journey', "positionReference: 'bottom'", "positionReference: 'top'"],
      [
        'journey',
        'await restored(context, threadRow, before)',
        "await record(context, 'position-restored', { unchecked: true })",
      ],
      [
        'journey',
        "values[0]!.text.replace(/\\s+/gu, ' ').trim() === `Replying to ${author.text}`",
        'true',
      ],
      [
        'journey',
        "matrixResources.cleanup('Scan message-action-sheet diagnostics', () => scanArtifacts(output, secrets));",
        '// Artifact scan registration removed',
      ],
    ];
    for (const [file, before, after] of mutations) {
      const changed = sources[file].replaceAll(before, after);
      expect(changed, `mutation replaces ${file}: ${before}`).not.toBe(
        sources[file],
      );
      expect(
        () => assertNativeRuntime({ ...sources, [file]: changed }),
        `rejects ${file}: ${before} -> ${after}`,
      ).toThrow();
    }
  });

  it('registers one uncached serialized suite after media retention with owned diagnostics', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['message-action-sheet'];
    expect(target, 'message-action-sheet Nx target must exist').toBeDefined();
    expect(target?.cache).toBe(false);
    expect(target?.parallelism).toBe(false);
    requireFragments(JSON.stringify(target ?? {}), [
      'android.message-action-sheet',
      'trinity-android',
      '--timeout-ms=3000000',
      '--resource=android-avd',
      '--resource=synapse',
    ]);
    requireFragments(read('e2e/registry/suites/runners.mts'), [
      "'android.message-action-sheet'",
      "'android-avd'",
      "'synapse'",
      paths.journey,
      paths.contract,
      paths.observer,
    ]);
    expect(
      JSON.parse(read('package.json')).scripts[
        'e2e:android:message-action-sheet'
      ],
    ).toContain('trinity-e2e-android:message-action-sheet');
    requireFragments(read('e2e/registry/commands.mts'), [
      "'android.message-action-sheet'",
      "name: 'e2e:android:message-action-sheet'",
      "command: 'nx run trinity-e2e-android:message-action-sheet'",
    ]);
    const workflow = read('.github/workflows/ci.yml');
    requireFragments(workflow, [
      'message-action-sheet-started=true',
      'surface: android-message-action-sheet',
      'android.message-action-sheet/**',
    ]);
    requireFragments(read('e2e/android/MIGRATION.md'), [
      'android.message-action-sheet',
      '18 + 4 + 4 + 18 + 10',
      'runtime-provenance.json',
    ]);
    expect(
      workflow.indexOf('trinity-e2e-android:message-action-sheet'),
    ).toBeGreaterThan(workflow.indexOf('trinity-e2e-android:media-retention'));
  });
});
