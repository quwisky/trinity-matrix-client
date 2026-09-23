import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-edit-history.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readPresent = (path) =>
  existsSync(resolve(root, path)) ? read(path) : '';
const digest = (path) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');

const coreLines = [
  232, 237, 244, 248, 249, 253, 263, 270, 271, 273, 279, 281, 282, 283, 286,
  287, 289, 292, 299, 301, 305, 306, 311, 312, 313, 316, 321, 322, 323, 324,
  339, 342, 344, 346, 350, 353, 358, 361, 362, 373, 377, 379, 382, 393, 394,
  395,
];
const pixelLines = [
  108, 111, 116, 511, 512, 513, 514, 521, 522, 523, 526, 527, 535, 542, 544,
  545,
];
const coreSuffixes = [
  'room-ready',
  'latest-text',
  'marker-visible',
  'dialog-visible',
  'three-revisions',
  'oldest-first-labels',
  'insertion-visible',
  'inserted-final',
  'deleted-second',
  'original-no-diff',
  'toggle-default-on',
  'toggle-off',
  'no-insertions-off',
  'exact-versions-off',
  'insertions-restored',
  'no-error',
  'not-truncated',
  'closed-first',
  'formatted-dialog',
  'bold-insert-mon',
  'bold-delete-fri',
  'bold-retain-day',
  'bold-monday-off',
  'formatted-no-diff-off',
  'formatted-no-old-word',
  'formatted-closed',
  'plain-reopened',
  'plain-reopened-three',
  'two-remove-actions',
  'original-not-removable',
  'two-after-current-remove',
  'final-absent-after-remove',
  'no-error-after-remove',
  'closed-after-current-remove',
  'timeline-second-draft',
  'marker-remains',
  'reopened-two',
  'removed-final-still-absent',
  'second-still-present',
  'one-after-last-remove',
  'closed-after-last-remove',
  'timeline-original',
  'marker-absent',
  'deleted-row-visible',
  'deleted-marker-absent',
  'deleted-body-absent',
];
const pixelSuffixes = [
  'room-ready',
  'latest-text',
  'dialog-visible',
  'dialog-box-present',
  'fullscreen-width',
  'fullscreen-height',
  'close-visible',
  'close-width-44',
  'close-height-44',
  'dialog-no-overflow',
  'toggle-visible',
  'revisions-visible',
  'reading-no-overflow',
  'remove-in-viewport',
  'remove-left-inside',
  'remove-right-inside',
];

function assertionLines(source, start, end) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isExpect =
        (ts.isIdentifier(expression) && expression.text === 'expect') ||
        (ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === 'expect' &&
          expression.name.text === 'poll');
      if (isExpect) {
        const line =
          tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        if (line >= start && line <= end) found.push(line);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

function assertReadOnlyObserver(source) {
  expect(source).not.toMatch(
    /\.(?:click|focus|dispatchEvent|scrollIntoView|scrollTo|scrollBy|submit|requestSubmit)\s*\(/u,
  );
  expect(source).not.toMatch(
    /(?:\.scrollTop|\.scrollLeft|\.style\.[\w]+)\s*=(?!=)/u,
  );
  expect(source).not.toMatch(
    /Input\.dispatchTouchEvent|\.goto\s*\(|window\.location\s*=|window\.location\.assign\s*\(|\.style\.(?:setProperty|removeProperty)\s*\(/u,
  );
}

function functionSource(source, name) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  let match;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      match = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(match, `${name} must be declared`).toBeDefined();
  return match.getText(tree);
}

function assertNativeLifecycle(source) {
  const body = functionSource(source, 'runRevisionLifecycle');
  expect(body).toContain('await openHistoryMarker(client, marker)');
  expect(body).toContain('await client.login(account)');
  expect(body).toContain('await client.tapCurrent(');
  expect(body).toContain('assertNativeTarget(await client.elements(');
  expect(body).toContain('await fixtures.serverState(');
  expect(body.match(/await fixtures\.serverState\(/gu)).toHaveLength(4);
  expect(body).toContain('await fixtures.liveEditEvent(');
  expect(body).toContain('await fixtures.redactedOriginal(');
  expect(body).toContain('await client.tapCurrent(CONFIRM)');
  expect(body).toContain(
    'assert(repairedMarker.length === 1 && repairedMarker[0]!.visible',
  );
  expect(body).toMatch(
    /await closeHistory\(client\);\s*const firstClosed = await client\.elements\(DIALOG\);\s*await record\(context, 'closed-first'/u,
  );
  expect(body).toMatch(
    /await closeHistory\(client\);\s*const formattedClosed = await client\.elements\(DIALOG\);\s*await record\(context, 'formatted-closed'/u,
  );
  expect(source).toContain('const CONFIRM = \'[data-testid="alert-confirm"]\'');
  expect(source).toContain(
    'const CLOSE = \'[data-testid="edit-history-close"]\'',
  );
  expect(source).toContain(
    'const REMOVE = \'[data-testid="edit-history"] .revision:last-child [data-testid="revision-remove"]\'',
  );
  const records = [
    ...body.matchAll(/await record\(context,\s*'([^']+)'/gu),
  ].map((match) => match[1]);
  expect(records).toEqual(coreSuffixes);
  assertReadOnlyObserver(body);
}

function assertNativePixelStage(source) {
  const body = functionSource(source, 'runPixel5LargeText');
  expect(body).toContain('await openHistoryMarker(client, marker)');
  const records = [
    ...body.matchAll(/await record\(context,\s*'([^']+)'/gu),
  ].map((match) => match[1]);
  expect(records).toEqual(pixelSuffixes);
  expect(body).toContain('await client.reset(PIXEL_5_ACCOUNT_PROFILE)');
  expect(body).toContain('await client.login(account)');
  expect(body).toContain('await readPixelGeometry(client)');
  expect(body).toContain('assertPixelBaselineGeometry(baseline)');
  expect(body).toContain("await client.device.setFontScale('1.5')");
  expect(body).toMatch(
    /try\s*\{\s*await client\.close\(\);\s*scale = await client\.device\.setFontScale\('1\.5'\)/u,
  );
  expect(body).toContain('await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)');
  expect(body).toContain('assertScaledReading(initialFont, scaled)');
  expect(body).toContain("await client.record('font-scale-applied'");
  expect(body).toContain('await reachPixelRemove(client, scaled,');
  expect(body).toContain('assertPixelGeometry(scaled)');
  expect(body).toMatch(
    /finally\s*\{[\s\S]*?await client\.close\(\);[\s\S]*?await scale\?\.restore\(\)/u,
  );
  expect(body).toContain('assert.equal(restored.rootPx, initialFont.rootPx)');
  expect(body).toContain("await client.record('font-scale-restored'");
  expect(body).toContain(
    'assert.equal(restored.inlineRootSize, initialFont.inlineRootSize)',
  );
  assertReadOnlyObserver(body);
}

function assertFailureSafeRunner(source) {
  const body = functionSource(source, 'runEditHistorySuite');
  expect(body).toContain('expectedStages: 2');
  expect(body).toContain('expectedUniqueAssertions: 62');
  expect(body).toContain('expectedAssertionRecords: 62');
  expect(body).toContain('attempt: 1');
  expect(body).toContain('retries: 0');
  expect(body).toContain("join(output, 'publication-safe')");
  expect(body).toContain("guardedCleanup('Scan edit-history diagnostics'");
  expect(body).toContain("guardedCleanup('Scrub edit-history diagnostics'");
  expect(body).toContain("guardedCleanup('Edit-history Android device'");
  expect(body).toContain('await scanEditHistoryArtifacts(output, secrets)');
  expect(body).toContain('await scrubEditHistoryArtifacts(output, secrets)');
  expect(body).toContain('await installWithAndroidRuntimeProvenance(');
  expect(body).toContain('assertEditHistoryRecords(entry.id, records)');
  expect(body).toContain("entry.id === 'pixel5-large-text' ? 'e'");
  expect(body).toContain(
    "stage.status = failures.length ? 'failed' : 'passed'",
  );
  expect(body).toContain("report.status = 'failed'");
  expect(body).toContain("report.status = 'passed'");
  expect(body).toContain('if (unsafeSecrets || scrubFailed)');
}

describe('Android edit-history migration contract', () => {
  it('wires one serial suite, bounded CI run and started-plus-safe diagnostics', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['edit-history'];
    expect(target?.cache).toBe(false);
    expect(target?.parallelism).toBe(false);
    expect(target?.dependsOn).toContainEqual({
      projects: ['trinity-android'],
      target: 'build-prebuilt',
    });
    expect(target?.options.command).toContain('--suite=android.edit-history');
    expect(target?.options.command).toContain('--timeout-ms=2400000');
    expect(target?.options.command).toContain(
      '--entrypoint=e2e/android/edit-history-journeys.mts',
    );
    expect(target?.options.command).toContain(
      '--resource=android-avd --resource=synapse',
    );
    expect(target?.options.command).toContain('web-bundle-manifest.mjs verify');
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['e2e:android:edit-history']).toContain(
      'trinity-e2e-android:edit-history',
    );
    const workflow = read('.github/workflows/ci.yml');
    expect(
      workflow.indexOf('trinity-e2e-android:edit-history'),
    ).toBeGreaterThan(
      workflow.indexOf('trinity-e2e-android:message-action-sheet'),
    );
    expect(workflow).toContain('edit-history-started=true');
    expect(workflow).toContain(
      'ci-run-command.mjs --timeout-ms 2700000 -- pnpm nx run trinity-e2e-android:edit-history',
    );
    expect(workflow).toContain(
      "steps.android.outputs.edit-history-started == 'true'",
    );
    expect(workflow).toContain(
      "steps.edit-history-artifact-gate.outputs.edit-history-safe == 'true'",
    );
    expect(workflow).toContain('android-edit-history');
    expect(workflow).toContain('publication-safe');
    expect(read('e2e/android/MIGRATION.md')).toContain('android.edit-history');
    expect(read(predecessor)).toContain(
      "test('renders the history as a fullscreen, touch-sized surface'",
    );
  });

  it('keeps cleanup, scan and incomplete-secret failures from publishing a pass', () => {
    const journey = read('e2e/android/edit-history-journeys.mts');
    assertFailureSafeRunner(journey);
    expect(() =>
      assertFailureSafeRunner(
        journey.replace(
          "guardedCleanup('Scan edit-history diagnostics'",
          "guardedCleanup('Skipped edit-history diagnostics'",
        ),
      ),
    ).toThrow();
    expect(() =>
      assertFailureSafeRunner(
        journey.replace(
          'await scanEditHistoryArtifacts(output, secrets)',
          'await Promise.resolve()',
        ),
      ),
    ).toThrow();
    expect(() =>
      assertFailureSafeRunner(
        journey.replace(
          "stage.status = failures.length ? 'failed' : 'passed'",
          "stage.status = 'passed'",
        ),
      ),
    ).toThrow();
  });

  it('owns all 16 Pixel identities, Android font scale, native swipe and restoration', () => {
    const journey = read('e2e/android/edit-history-journeys.mts');
    assertNativePixelStage(journey);
    expect(() =>
      assertNativePixelStage(
        journey.replace(
          "await client.device.setFontScale('1.5')",
          "await client.device.setFontScale('1.0')",
        ),
      ),
    ).toThrow();
    expect(() =>
      assertNativePixelStage(
        journey.replace(
          'await reachPixelRemove(client, scaled,',
          'await fakeScroll(client, scaled,',
        ),
      ),
    ).toThrow();
    expect(() =>
      assertNativePixelStage(
        journey.replace('await scale?.restore()', 'await Promise.resolve()'),
      ),
    ).toThrow();
    expect(() =>
      assertNativePixelStage(
        journey.replace(
          "await record(context, 'remove-right-inside'",
          "await record(context, 'remove-left-inside'",
        ),
      ),
    ).toThrow();
  });

  it('owns every lifecycle product action and all 46 source-order records', () => {
    const journey = read('e2e/android/edit-history-journeys.mts');
    assertNativeLifecycle(journey);
    expect(() =>
      assertNativeLifecycle(
        journey.replaceAll('await client.tapCurrent(', 'await client.tap('),
      ),
    ).toThrow();
    expect(() =>
      assertNativeLifecycle(
        journey.replaceAll(
          'await fixtures.serverState(',
          'await fixtures.roomEvent(',
        ),
      ),
    ).toThrow();
    expect(() =>
      assertNativeLifecycle(
        journey.replace(
          "await record(context, 'timeline-second-draft'",
          "await record(context, 'room-ready'",
        ),
      ),
    ).toThrow();
  });

  it('cannot emit a duplicate, out-of-order, or unproved lifecycle identity', async () => {
    const { editHistoryCases } =
      await import('../e2e/android/edit-history-contract.mts');
    const { record } = await import('../e2e/android/edit-history-journeys.mts');
    const written = [];
    const context = {
      entry: editHistoryCases[0],
      records: [],
      client: {
        async record(identity, value) {
          written.push({ identity, value });
        },
      },
    };
    await record(context, 'room-ready', () => {}, { ready: true });
    expect(context.records).toEqual([
      'edit-history.revision-lifecycle.room-ready',
    ]);
    expect(written).toHaveLength(1);
    await expect(
      record(
        context,
        'latest-text',
        () => {
          throw new Error('proof failed');
        },
        { ready: false },
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    expect(written).toHaveLength(1);
    await expect(
      record(context, 'room-ready', () => {}, { ready: true }),
    ).rejects.toThrow();
    await expect(
      record(context, 'marker-visible', () => {}, { ready: true }),
    ).rejects.toThrow();
  });

  it('keeps WebView observations read-only while permitting an inline-style read', () => {
    const observer = read('e2e/android/edit-history-observer.mts');
    expect(observer).toContain('root.style.fontSize');
    assertReadOnlyObserver(observer);
    const journey = readPresent('e2e/android/edit-history-journeys.mts');
    if (journey) assertReadOnlyObserver(journey);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'window.dispatchEvent(new Event("resize"))',
      'element.scrollIntoView()',
      'element.scrollTop = 300',
      'documentElement.style.fontSize = "24px"',
      'root.style.fontSize = "24px"',
      'root.style.setProperty("font-size", "24px")',
      'Input.dispatchTouchEvent',
      'window.location.assign("/rooms")',
    ])
      expect(() =>
        assertReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
  });

  it('pins the exact two Android assertion spans and excludes desktop-only sites', () => {
    const source = read(predecessor);
    expect(assertionLines(source, 123, 396)).toEqual(coreLines);
    expect(assertionLines(source, 91, 118)).toEqual(pixelLines.slice(0, 3));
    expect(assertionLines(source, 500, 552)).toEqual(pixelLines.slice(3));
    expect(assertionLines(source, 398, 495)).toHaveLength(25);
    expect(digest(predecessor)).toBe(
      '66b251c72f0939a9913fb31641107f500d22cf627ff7b566740e15e744c37153',
    );
    expect(digest('e2e/support/app.mts')).toBe(
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    expect(digest('e2e/support/account.mts')).toBe(
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );
  });

  it('maps each applicable site to one ordered and unique record', async () => {
    const {
      EDIT_HISTORY_ASSERTION_RECORDS,
      editHistoryCases,
      editHistoryAssertion,
      assertEditHistoryRecords,
    } = await import('../e2e/android/edit-history-contract.mts');
    const expected = [
      {
        id: 'revision-lifecycle',
        source: `${predecessor}:123-396`,
        expectedAssertionRecords: 46,
        sites: coreLines,
        suffixes: coreSuffixes,
      },
      {
        id: 'pixel5-large-text',
        source: `${predecessor}:500-552`,
        expectedAssertionRecords: 16,
        sites: pixelLines,
        suffixes: pixelSuffixes,
      },
    ];
    expect(EDIT_HISTORY_ASSERTION_RECORDS).toBe(62);
    expect(editHistoryCases).toHaveLength(2);
    for (const [index, item] of expected.entries()) {
      const entry = editHistoryCases[index];
      const identities = item.suffixes.map(
        (suffix) => `edit-history.${item.id}.${suffix}`,
      );
      expect(entry.id).toBe(item.id);
      expect(entry.source).toBe(item.source);
      expect(entry.expectedAssertionRecords).toBe(
        item.expectedAssertionRecords,
      );
      expect(entry.sites.map(([line]) => line)).toEqual(item.sites);
      expect(entry.assertions).toEqual(identities);
      expect(new Set(entry.assertions).size).toBe(entry.assertions.length);
      expect(editHistoryAssertion(item.id, item.suffixes[0])).toBe(
        identities[0],
      );
      expect(() => editHistoryAssertion(item.id, 'not-owned')).toThrow();
      expect(() => assertEditHistoryRecords(item.id, identities)).not.toThrow();
      expect(() =>
        assertEditHistoryRecords(item.id, identities.slice(1)),
      ).toThrow();
      expect(() =>
        assertEditHistoryRecords(item.id, [...identities, identities[0]]),
      ).toThrow();
      expect(() =>
        assertEditHistoryRecords(item.id, [
          identities[1],
          identities[0],
          ...identities.slice(2),
        ]),
      ).toThrow();
    }
  });
});
