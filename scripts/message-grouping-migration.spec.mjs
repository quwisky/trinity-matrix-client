import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-grouping.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const digest = (path) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');
const loadContract = () =>
  import('../e2e/android/message-grouping-contract.mts');
const loadPreference = () =>
  import('../e2e/android/appearance-density-preference.mts');

function xmlWithDensity(value) {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<map><string name="trinity.appearance.density">${escaped}</string></map>`;
}

function assertionLines(source, start, end) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect'
    ) {
      const line =
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      if (line >= start && line <= end) lines.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

const bodies = [
  'First message',
  'Second message with enough text to reach the trailing action track without the reserved inset',
  'Third message',
];
const events = bodies.map((body, index) => ({ id: `$group-${index}`, body }));
const expectedAssertions = [
  'message-grouping.room-visible',
  'message-grouping.body-first',
  'message-grouping.body-second',
  'message-grouping.body-third',
  'message-grouping.avatar-count',
  'message-grouping.continuation-count',
  'message-grouping.lead-first',
  'message-grouping.lead-second',
  'message-grouping.lead-third',
  'message-grouping.text-left-first',
  'message-grouping.text-left-second',
  'message-grouping.text-left-third',
  'message-grouping.cosy-start-padding',
  'message-grouping.cosy-continuation-padding',
  'message-grouping.cosy-start-margin',
  'message-grouping.phone-no-toolbar',
  'message-grouping.compact-column-gap',
  'message-grouping.compact-total-height',
  'message-grouping.compact-start-padding',
  'message-grouping.compact-start-margin',
  'message-grouping.compact-continuation-padding',
  'message-grouping.compact-body-end-gap',
];

function validGeometry(density) {
  return {
    rows: events.map((event, index) => ({
      ...event,
      visible: true,
      continuation: index !== 0,
      avatarCount: index === 0 ? 1 : 0,
      leadWidth: 40,
      textLeft: 80,
      paddingTop: index === 0 ? (density === 'cosy' ? 16 : 12) : 0,
      marginTop: 0,
      height:
        density === 'cosy' ? (index === 0 ? 56 : 32) : index === 0 ? 48 : 26,
      columnGap: density === 'cosy' ? 12 : 8,
      bodyEndGap: 0,
    })),
    toolbarCount: 0,
  };
}

function changedRow(geometry, index, change) {
  return {
    ...geometry,
    rows: geometry.rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...change } : row,
    ),
  };
}

describe('Android message-grouping migration contract', () => {
  it('pins the exact Android branch, helper sources and desktop return boundary', () => {
    const source = read(predecessor);
    expect(digest(predecessor)).toBe(
      '9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f',
    );
    expect(digest('e2e/support/app.mts')).toBe(
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    expect(digest('e2e/support/account.mts')).toBe(
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );
    expect(assertionLines(source, 57, 234)).toEqual([
      99, 103, 109, 110, 123, 130, 132, 166, 167, 178, 184, 198, 228, 229, 230,
      231, 232, 233,
    ]);
    expect(source).toContain('const LEAD_WIDTH = 40;');
    expect(source).toContain('if (isAndroidE2E) {');
    expect(source).toContain("html.setAttribute('data-density', 'compact')");
    expect(source.split('\n')[233]?.trim()).toBe('return;');
    expect(source.split('\n')[236]).toContain('hover toolbar');
  });

  it('requires the 22 unique source-ordered Android identities', async () => {
    const { MESSAGE_GROUPING_ASSERTIONS, assertGroupingRecords } =
      await loadContract();
    expect(MESSAGE_GROUPING_ASSERTIONS).toEqual(expectedAssertions);
    expect(() => assertGroupingRecords(expectedAssertions)).not.toThrow();
    expect(() =>
      assertGroupingRecords(expectedAssertions.slice(0, -1)),
    ).toThrow();
    expect(() =>
      assertGroupingRecords([
        ...expectedAssertions.slice(0, -1),
        expectedAssertions[0],
      ]),
    ).toThrow();
    expect(() =>
      assertGroupingRecords([...expectedAssertions].reverse()),
    ).toThrow();
  });

  it('requires the exact native Room route and Account after both Room openings', async () => {
    const { assertGroupingRoomRoute } = await loadContract();
    const roomId = '!grouping:localhost';
    const userId = '@grouping:localhost';
    const encoded = Buffer.from(roomId).toString('base64url');
    const route = `https://localhost/rooms/${encoded}?account=%40grouping%3Alocalhost&view=rooms`;
    expect(() => assertGroupingRoomRoute(route, roomId, userId)).not.toThrow();
    for (const wrong of [
      route.replace(
        encoded,
        Buffer.from('!other:localhost').toString('base64url'),
      ),
      route.replace('%40grouping%3Alocalhost', '%40other%3Alocalhost'),
      route.replace('view=rooms', 'view=spaces'),
    ])
      expect(() => assertGroupingRoomRoute(wrong, roomId, userId)).toThrow();
  });

  it('rejects unrelated, reordered, pending, duplicate, hidden or wrong-body rows', async () => {
    const { assertExactRows } = await loadContract();
    const rows = validGeometry('cosy').rows;
    expect(() => assertExactRows(rows, events)).not.toThrow();
    for (const invalid of [
      rows.slice(0, 2),
      [rows[1], rows[0], rows[2]],
      [rows[0], rows[0], rows[2]],
      changedRow({ rows }, 1, { id: '$unrelated' }).rows,
      changedRow({ rows }, 1, { id: '~pending' }).rows,
      changedRow({ rows }, 1, { body: 'Wrong text' }).rows,
      changedRow({ rows }, 1, { visible: false }).rows,
    ])
      expect(() => assertExactRows(invalid, events)).toThrow();
  });

  it('rejects malformed or non-finite renderer measurements', async () => {
    const { parseGroupingGeometry } = await loadContract();
    const cosy = validGeometry('cosy');
    expect(parseGroupingGeometry(cosy)).toEqual(cosy);
    for (const invalid of [
      null,
      { rows: cosy.rows.slice(0, 2), toolbarCount: 0 },
      changedRow(cosy, 1, { leadWidth: Number.NaN }),
      changedRow(cosy, 1, { height: Number.POSITIVE_INFINITY }),
      changedRow(cosy, 1, { textLeft: undefined }),
      { ...cosy, toolbarCount: -1 },
    ])
      expect(() => parseGroupingGeometry(invalid)).toThrow();
  });

  it('measures one header avatar, two continuations and exact 40px leads', async () => {
    const { assertCosyGrouping } = await loadContract();
    const cosy = validGeometry('cosy');
    expect(() => assertCosyGrouping(cosy)).not.toThrow();
    for (const invalid of [
      changedRow(cosy, 0, { avatarCount: 0 }),
      changedRow(cosy, 1, { avatarCount: 1 }),
      changedRow(cosy, 1, { continuation: false }),
      changedRow(cosy, 2, { leadWidth: 39.9 }),
    ])
      expect(() => assertCosyGrouping(invalid)).toThrow();
  });

  it('rejects misaligned text and non-border-box cosy spacing', async () => {
    const { assertCosyGrouping } = await loadContract();
    const cosy = validGeometry('cosy');
    for (const invalid of [
      changedRow(cosy, 1, { textLeft: 81.1 }),
      changedRow(cosy, 0, { paddingTop: 15.9 }),
      changedRow(cosy, 1, { paddingTop: 0.1 }),
      changedRow(cosy, 0, { marginTop: 16 }),
      { ...cosy, toolbarCount: 1 },
    ])
      expect(() => assertCosyGrouping(invalid)).toThrow();
  });

  it('requires non-vacuous exact Compact geometry and a present trailing gap', async () => {
    const { assertCompactGrouping } = await loadContract();
    const cosy = validGeometry('cosy');
    const compact = validGeometry('compact');
    expect(() => assertCompactGrouping(cosy, compact)).not.toThrow();
    for (const invalid of [
      changedRow(compact, 0, { columnGap: 8.1 }),
      changedRow(compact, 0, { height: 100 }),
      changedRow(compact, 0, { paddingTop: 11.9 }),
      changedRow(compact, 0, { marginTop: 1 }),
      changedRow(compact, 1, { paddingTop: 1 }),
      changedRow(compact, 1, { bodyEndGap: null }),
      changedRow(compact, 1, { bodyEndGap: 1.1 }),
    ])
      expect(() => assertCompactGrouping(cosy, invalid)).toThrow();
  });
});

describe('Android appearance-density native persistence', () => {
  it('reads absent default Cosy and exact version-one Cosy or Compact', async () => {
    const { parseNativeAppearanceDensityPreference: parse } =
      await loadPreference();
    expect(parse('<map/>')).toEqual({
      present: false,
      version: null,
      value: 'cosy',
    });
    expect(parse('<map></map>')).toEqual({
      present: false,
      version: null,
      value: 'cosy',
    });
    expect(parse(xmlWithDensity('{"version":1,"value":"cosy"}'))).toEqual({
      present: true,
      version: 1,
      value: 'cosy',
    });
    expect(parse(xmlWithDensity('{"version":1,"value":"compact"}'))).toEqual({
      present: true,
      version: 1,
      value: 'compact',
    });
  });

  it('rejects a duplicate, bare, wrong-version, wrong-value or extra-key entry', async () => {
    const { parseNativeAppearanceDensityPreference: parse } =
      await loadPreference();
    const valid = xmlWithDensity('{"version":1,"value":"compact"}');
    const duplicate = valid.replace(
      '</map>',
      '<string name="trinity.appearance.density">compact</string></map>',
    );
    for (const invalid of [
      duplicate,
      xmlWithDensity('compact'),
      xmlWithDensity('{"version":2,"value":"compact"}'),
      xmlWithDensity('{"version":1,"value":"large"}'),
      xmlWithDensity('{"version":1,"value":"compact","other":true}'),
      xmlWithDensity('not-json'),
    ])
      expect(() => parse(invalid)).toThrow();
  });

  it('rejects malformed XML, unknown entities and malformed named entries without leaking XML', async () => {
    const { parseNativeAppearanceDensityPreference: parse } =
      await loadPreference();
    for (const invalid of [
      '<map><string name="trinity.appearance.density">compact</map>',
      '<map><string name="trinity.appearance.density"/></map>',
      '<map><string name="trinity.appearance.density">&bogus;</string></map>',
      '<map><string name="trinity.appearance.density">SECRET_DENSITY_XML</string></map>',
    ]) {
      let error;
      try {
        parse(invalid);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain('SECRET_DENSITY_XML');
      expect(error.message).not.toContain('<map>');
    }
    expect(() =>
      parse(
        '<map><string name="trinity.appearance.density">&bogus;</string></map>',
      ),
    ).toThrow(/unsupported XML entity/u);
  });

  it('uses read-only run-as for the package-owned file and publishes only a sanitized observation', async () => {
    const { readNativeAppearanceDensityPreference: readNative } =
      await loadPreference();
    const calls = [];
    const client = {
      applicationId: 'eu.qwky.trinity',
      signal: new AbortController().signal,
      device: {
        adb: async (...args) => {
          calls.push(args);
          return xmlWithDensity('{"version":1,"value":"compact"}');
        },
      },
    };
    expect(await readNative(client, 'compact', 500)).toEqual({
      present: true,
      version: 1,
      value: 'compact',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('shell');
    expect(calls[0].join(' ')).toContain('run-as eu.qwky.trinity');
    expect(calls[0].join(' ')).toContain(
      'cat shared_prefs/CapacitorStorage.xml',
    );
    expect(calls[0].join(' ')).not.toMatch(/\b(?:set|put|write)\b|>/u);
  });

  it('does not accept an absent key as persisted Compact', async () => {
    const { readNativeAppearanceDensityPreference: readNative } =
      await loadPreference();
    const client = {
      applicationId: 'eu.qwky.trinity',
      signal: new AbortController().signal,
      device: { adb: async () => '<map/>' },
    };
    await expect(readNative(client, 'compact', 25)).rejects.toThrow(
      /Timed out waiting for native trinity\.appearance\.density=compact/u,
    );
  });
});

describe('installed Android message-grouping ownership and publication', () => {
  it('seeds the exact ordered events and uses native-only actions with read-only proof', () => {
    const journey = read('e2e/android/message-grouping-journeys.mts');
    const flow = read('e2e/android/flows/native-shell-appearance-compact.yaml');
    for (const body of bodies) expect(journey).toContain(body);
    expect(journey).toContain('fixtures.sendMessage(account, room.id, body,');
    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain('client.login(account)');
    expect(journey).toContain('client.tapCurrent');
    expect(journey).toContain('native-shell-settings.yaml');
    const leaveRoom = journey.indexOf(
      'client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
    );
    expect(leaveRoom).toBeGreaterThan(-1);
    expect(leaveRoom).toBeLessThan(
      journey.indexOf('native-shell-settings.yaml'),
    );
    expect(journey).toContain('native-shell-appearance.yaml');
    expect(journey).toContain('native-shell-appearance-compact.yaml');
    expect(journey).toContain(
      "readNativeAppearanceDensityPreference(client, 'compact'",
    );
    expect(journey.match(/assertGroupingRoomRoute\(/gu)).toHaveLength(2);
    expect(journey.match(/assertExactRows\(/gu)).toHaveLength(2);
    expect(journey).toContain('getBoundingClientRect()');
    expect(journey).toContain('getComputedStyle(');
    expect(journey).toContain('assertGroupingRecords(records)');
    expect(journey).toContain('roomDigest: digest(room.id)');
    expect(
      journey.match(/eventDigest: digest\(events\[\d\]!\.id\)/gu),
    ).toHaveLength(3);
    expect(journey).toContain('persistenceVersion: 1');
    expect(journey).toContain("client.capture('passed')");
    expect(journey).toContain("client.capture('failed')");
    expect(journey).toContain('runGroupingStageCleanup(');
    expect(journey).not.toMatch(
      /setAttribute\(['"]data-density|\.click\(|\.scrollIntoView\(|\.focus\(|\.scrollTo\(/u,
    );
    expect(flow).toContain('scrollUntilVisible:');
    expect(flow).toContain('id: ${DENSITY_TRIGGER_ID}');
    expect(flow).toContain('tapOn: Compact');
    expect(flow).not.toMatch(/evalScript|runScript|inputText/u);
  });

  it('rejects bearer, registered secret, raw Preferences XML and raster proof', async () => {
    const { scanGroupingArtifacts } =
      await import('../e2e/android/message-grouping-artifacts.mts');
    const output = await mkdtemp(join(tmpdir(), 'trinity-grouping-scan-'));
    const receipt = join(output, 'receipt.json');
    try {
      for (const unsafe of [
        'Bearer unregistered-token',
        'password-for-grouping',
        '<map><string name="trinity.appearance.density">compact</string></map>',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(
          scanGroupingArtifacts(output, {
            SECRET_PASSWORD: 'password-for-grouping',
          }),
        ).rejects.toThrow();
      }
      await writeFile(receipt, '{}\n');
      await writeFile(join(output, 'capture.png'), 'raster');
      await expect(scanGroupingArtifacts(output, {})).rejects.toThrow();
      await rm(join(output, 'capture.png'));
      await writeFile(join(output, 'capture.bmp'), 'raster');
      await expect(scanGroupingArtifacts(output, {})).rejects.toThrow();
      await rm(join(output, 'capture.bmp'));
      await writeFile(join(output, 'opaque.bin'), 'binary');
      await expect(scanGroupingArtifacts(output, {})).rejects.toThrow();
      await rm(join(output, 'opaque.bin'));
      await writeFile(
        join(output, 'junit.xml'),
        '<?xml version="1.0"?><testsuites/>',
      );
      await expect(scanGroupingArtifacts(output, {})).resolves.toBeUndefined();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('requires a clean complete 22-record report and actual pass capture before publication', async () => {
    const { markGroupingDiagnosticsSafe } =
      await import('../e2e/android/message-grouping-artifacts.mts');
    const output = await mkdtemp(join(tmpdir(), 'trinity-grouping-gate-'));
    const valid = {
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 22,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: 'message-grouping',
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 22,
          assertionRecords: 22,
          assertions: [...expectedAssertions],
          failureCount: 0,
        },
      ],
    };
    const flags = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    try {
      await writeFile(join(output, 'journeys.json'), JSON.stringify(valid));
      await writeFile(join(output, 'runtime-provenance.json'), '{}\n');
      await expect(
        markGroupingDiagnosticsSafe(output, {}, flags),
      ).rejects.toThrow();
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      const stageDir = join(output, 'message-grouping');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(stageDir));
      for (const name of [
        'passed.json',
        'passed-ui.json',
        'passed-surface.json',
      ])
        await writeFile(join(stageDir, name), '{}\n');
      await markGroupingDiagnosticsSafe(output, {}, flags);
      expect(await readFile(join(output, 'publication-safe'), 'utf8')).toBe(
        'scanned\n',
      );
      for (const invalid of [
        { ...valid, status: 'failed' },
        { ...valid, stages: [{ ...valid.stages[0], assertionRecords: 21 }] },
        {
          ...valid,
          stages: [
            { ...valid.stages[0], assertions: expectedAssertions.slice(0, -1) },
          ],
        },
      ]) {
        await writeFile(join(output, 'journeys.json'), JSON.stringify(invalid));
        await expect(
          markGroupingDiagnosticsSafe(output, {}, flags),
        ).rejects.toThrow();
        expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      }
      await writeFile(join(output, 'journeys.json'), JSON.stringify(valid));
      await expect(
        markGroupingDiagnosticsSafe(
          output,
          {},
          { ...flags, cleanupFailed: true },
        ),
      ).rejects.toThrow();
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('aggregates cleanup faults and revokes cancelled publication', async () => {
    const { runGroupingStageCleanup, revokeGroupingPublicationOnAbort } =
      await import('../e2e/android/message-grouping-artifacts.mts');
    const output = await mkdtemp(join(tmpdir(), 'trinity-grouping-cleanup-'));
    try {
      const failures = [];
      let secondRan = false;
      await runGroupingStageCleanup(
        [
          async () => {
            throw new Error('first cleanup failed');
          },
          async () => {
            secondRan = true;
          },
        ],
        failures,
      );
      expect(secondRan).toBe(true);
      expect(failures).toHaveLength(1);
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'stale\n');
      const controller = new AbortController();
      controller.abort();
      await revokeGroupingPublicationOnAbort(output, report, controller.signal);
      expect(report.status).toBe('failed');
      expect(report.stages[0].status).toBe('failed');
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});

describe('Android message-grouping hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target and canonical command', async () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const pkg = JSON.parse(read('package.json'));
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS } =
      await import('../e2e/registry/commands.mts');
    const target = project.targets['message-grouping'];
    expect(target.cache).toBe(false);
    expect(target.parallelism).toBe(false);
    expect(target.dependsOn).toEqual([
      { projects: ['trinity-android'], target: 'build-prebuilt' },
    ]);
    expect(target.options.command).toContain(
      '--suite=android.message-grouping --timeout-ms=1200000 --entrypoint=e2e/android/message-grouping-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse',
    );
    expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
    expect(pkg.scripts['e2e:android:message-grouping']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:message-grouping',
    );
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-grouping',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      currentTarget: 'trinity-e2e-android:message-grouping',
      canonicalScript: 'e2e:android:message-grouping',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect(suites[0].sourceEntrypoints).toContain(
      'e2e/android/message-grouping-journeys.mts',
    );
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-grouping',
      ),
    ).toHaveLength(1);
  });

  it('runs in shard two after message-forward and uploads only started safe diagnostics', () => {
    const workflow = read('.github/workflows/ci.yml');
    const runner = workflow.indexOf('message-grouping-started=true');
    expect(runner).toBeGreaterThan(
      workflow.indexOf('message-forward-started=true'),
    );
    expect(runner).toBeLessThan(
      workflow.indexOf('cross-user-verification-started=true'),
    );
    expect(workflow).toContain(
      'node scripts/ci-run-command.mjs --timeout-ms 1500000 -- pnpm nx run trinity-e2e-android:message-grouping',
    );
    expect(workflow).toContain(
      "steps.android.outputs.message-grouping-started == 'true'",
    );
    expect(workflow).toContain(
      "steps.message-grouping-artifact-gate.outputs.message-grouping-safe == 'true'",
    );
    expect(workflow).toContain(
      "-path '*/android.message-grouping/message-grouping/publication-safe'",
    );
    expect(workflow).toContain('surface: android-message-grouping');
  });

  it('documents all 22 exact Android records and excludes the desktop tail', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration.split('## Message-grouping journey')[1];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(/^\|[^\n]+\| `(message-grouping\.[^`]+)` \|$/gmu),
    ].map((match) => match[1]);
    expect(rows).toEqual(expectedAssertions);
    expect(section).toContain('desktop-only tail');
    expect(section).toContain(
      '9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f',
    );
  });
});
