import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-forward.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readPresent = (path) =>
  existsSync(resolve(root, path)) ? read(path) : '';
const digest = (path) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');

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

const sourceEvent = {
  event_id: '$source',
  room_id: '!source:localhost',
  sender: '@forward:localhost',
  content: { msgtype: 'm.text', body: 'forward this run-1' },
};
const targetEvent = {
  ...sourceEvent,
  event_id: '$target',
  room_id: '!target:localhost',
};
const expectedSource = {
  eventId: '$source',
  roomId: '!source:localhost',
  sender: '@forward:localhost',
  body: 'forward this run-1',
};
const expectedTarget = {
  sourceEventId: '$source',
  roomId: '!target:localhost',
  sender: '@forward:localhost',
  body: 'forward this run-1',
};

describe('Android message-forward migration contract', () => {
  it('pins exact predecessor/helper shape and retains the Android sheet branch', () => {
    const source = read(predecessor);
    expect(digest(predecessor)).toBe(
      '4776cbb08bea3b92eb5d0e2203b50b77261e4e3191acad94595b5db2f190fcd3',
    );
    expect(digest('e2e/support/app.mts')).toBe(
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    expect(digest('e2e/support/account.mts')).toBe(
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );
    expect(assertionLines(source, 31, 95)).toEqual([72, 86, 92]);
    expect(assertionLines(source, 18, 26)).toEqual([23]);
    expect(source).toContain('if (isAndroidE2E) {');
    expect(source).toContain('openMessageActionSheet(page, row.first())');
    expect(source).toContain("sheet.getByTestId('sheet-forward').click()");
    expect(source).toContain('waitForSent(row.first())');
  });

  it('requires seven unique source-ordered identities', async () => {
    const { MESSAGE_FORWARD_ASSERTIONS, assertForwardRecords } =
      await import('../e2e/android/message-forward-contract.mts');
    const expected = [
      'message-forward.source-room-ready',
      'message-forward.source-row-visible',
      'message-forward.source-server-ready',
      'message-forward.sheet-ready',
      'message-forward.picker-visible',
      'message-forward.target-room-ready',
      'message-forward.target-row-and-event',
    ];
    expect(MESSAGE_FORWARD_ASSERTIONS).toEqual(expected);
    expect(() => assertForwardRecords(expected)).not.toThrow();
    expect(() => assertForwardRecords(expected.slice(0, -1))).toThrow();
    expect(() =>
      assertForwardRecords([...expected.slice(0, -1), expected[0]]),
    ).toThrow();
    expect(() => assertForwardRecords([...expected].reverse())).toThrow();
  });

  it('rejects a pending or mismatched source event before native Forward', async () => {
    const { assertReadySourceEvent } =
      await import('../e2e/android/message-forward-contract.mts');
    expect(() =>
      assertReadySourceEvent(sourceEvent, expectedSource),
    ).not.toThrow();
    for (const invalid of [
      { ...sourceEvent, event_id: '~pending' },
      { ...sourceEvent, event_id: '$other' },
      { ...sourceEvent, room_id: '!other:localhost' },
      { ...sourceEvent, sender: '@other:localhost' },
      { ...sourceEvent, content: { ...sourceEvent.content, body: 'wrong' } },
      {
        ...sourceEvent,
        content: { ...sourceEvent.content, msgtype: 'm.notice' },
      },
    ])
      expect(() => assertReadySourceEvent(invalid, expectedSource)).toThrow();
  });

  it('rejects a stale relation or wrong target event identity, Room, sender, or body', async () => {
    const { assertForwardTargetEvent } =
      await import('../e2e/android/message-forward-contract.mts');
    expect(() =>
      assertForwardTargetEvent(targetEvent, expectedTarget),
    ).not.toThrow();
    for (const invalid of [
      { ...targetEvent, event_id: '$source' },
      { ...targetEvent, event_id: '~pending' },
      { ...targetEvent, room_id: '!other:localhost' },
      { ...targetEvent, sender: '@other:localhost' },
      { ...targetEvent, content: { ...targetEvent.content, body: 'wrong' } },
      {
        ...targetEvent,
        content: { ...targetEvent.content, msgtype: 'm.notice' },
      },
      {
        ...targetEvent,
        content: {
          ...targetEvent.content,
          'm.relates_to': { event_id: '$source' },
        },
      },
      {
        ...targetEvent,
        content: { ...targetEvent.content, 'm.new_content': { body: 'old' } },
      },
    ])
      expect(() => assertForwardTargetEvent(invalid, expectedTarget)).toThrow();
  });

  it('requires the native picker to land on the exact target Room and account route', async () => {
    const { assertForwardRoomRoute } =
      await import('../e2e/android/message-forward-contract.mts');
    const roomId = '!target:localhost';
    const encoded = Buffer.from(roomId).toString('base64url');
    const route = `https://localhost/rooms/${encoded}?account=%40forward%3Alocalhost&view=rooms`;
    expect(() =>
      assertForwardRoomRoute(route, roomId, '@forward:localhost'),
    ).not.toThrow();
    for (const invalid of [
      route.replace(
        encoded,
        Buffer.from('!source:localhost').toString('base64url'),
      ),
      route.replace('%40forward%3Alocalhost', '%40other%3Alocalhost'),
      route.replace('view=rooms', 'view=spaces'),
    ])
      expect(() =>
        assertForwardRoomRoute(invalid, roomId, '@forward:localhost'),
      ).toThrow();
  });

  it('rejects absent, duplicate, approximate, hidden, or non-Room picker choices', async () => {
    const { assertExactPickerResult } =
      await import('../e2e/android/message-forward-contract.mts');
    const expected = {
      title: 'Forward Target run-1',
      kind: 'Room',
      visible: true,
    };
    expect(() =>
      assertExactPickerResult([expected], expected.title),
    ).not.toThrow();
    for (const choices of [
      [],
      [expected, expected],
      [{ ...expected, title: 'Forward Target run-1 extra' }],
      [{ ...expected, kind: 'Space' }],
      [{ ...expected, visible: false }],
    ])
      expect(() => assertExactPickerResult(choices, expected.title)).toThrow();
  });

  it('rejects an absent, hidden, or duplicate Android sheet or Forward action', async () => {
    const { assertNativeSheetReady } =
      await import('../e2e/android/message-forward-contract.mts');
    const visible = { visible: true };
    const hidden = { visible: false };
    expect(() => assertNativeSheetReady([visible], [visible])).not.toThrow();
    for (const [dialogs, buttons] of [
      [[], [visible]],
      [[visible, visible], [visible]],
      [[hidden], [visible]],
      [[visible], []],
      [[visible], [visible, visible]],
      [[visible], [hidden]],
    ])
      expect(() => assertNativeSheetReady(dialogs, buttons)).toThrow();
  });

  it('runs the source, sheet, picker, and target through the native client', () => {
    const journey = readPresent('e2e/android/message-forward-journeys.mts');
    expect(journey).toContain('const body = `Forward this ');
    for (const call of [
      'client.login(account)',
      'client.fill(\'[data-testid="composer-input"]\'',
      'client.tapCurrent(\'[data-testid="composer-send"]\')',
      'client.longPressCurrent(',
      'client.tapCurrent(\'[data-testid="sheet-forward"]\')',
      'client.fill(\'[data-testid="switcher-input"]\'',
      'client.tapCurrent(',
      'fixtures.roomEvent(account, source.id,',
      'fixtures.roomEvent(account, target.id,',
      'assertReadySourceEvent(',
      'assertForwardTargetEvent(',
      "client.capture('passed')",
      "client.capture('failed')",
    ])
      expect(journey).toContain(call);
    // Mobile Enter inserts a new line in the composer (d3b27323); only Send sends.
    expect(journey).not.toContain("client.key('enter')");
    expect(journey).not.toMatch(/\.(?:click|focus|submit|navigate)\(/u);
    expect(journey).not.toContain('.first()');
    expect(journey).toContain('assertExactPickerResult(');
    expect(journey).toContain('assertNativeSheetReady(');
    expect(journey).toContain('assertForwardRoomRoute(');
    expect(journey).toContain('forwardRoomSecrets(source.id, target.id)');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
    );
    expect(journey).toContain('openRoom(client, target.name)');
    expect(journey).toContain('assertForwardRecords(records)');
    expect(journey).toContain('publication-safe');
    expect(journey).toContain('withNodeTestResources(');
    expect(journey).toContain('runForwardStageCleanup(');
    expect(journey).toContain('revokeForwardPublicationOnAbort(');
  });

  it('rejects unsafe artifacts and scrubs registered secrets before publication', async () => {
    const {
      forwardRoomSecrets,
      forwardSecrets,
      scanForwardArtifacts,
      scrubForwardArtifacts,
    } = await import('../e2e/android/message-forward-artifacts.mts');
    const output = await mkdtemp(join(tmpdir(), 'trinity-forward-artifacts-'));
    try {
      const textFile = join(output, 'receipt.json');
      const raster = join(output, 'capture.png');
      const body = 'Forward this run-1';
      const secrets = {
        ...forwardSecrets(
          {
            username: 'forward',
            userId: '@forward:localhost',
            password: 'password-run-1',
          },
          'Source',
          'Target',
          body,
        ),
        ...forwardRoomSecrets('!source:localhost', '!target:localhost'),
      };
      expect(Object.values(secrets)).toContain('forward this run-1');
      const encodedTarget =
        Buffer.from('!target:localhost').toString('base64url');
      expect(Object.values(secrets)).toContain(encodedTarget);
      await writeFile(textFile, `{"route":"/rooms/${encodedTarget}"}\n`);
      await expect(scanForwardArtifacts(output, secrets)).rejects.toThrow();
      await writeFile(
        textFile,
        '{"password":"password-run-1","body":"forward this run-1"}\n',
      );
      await expect(scanForwardArtifacts(output, secrets)).rejects.toThrow();
      await scrubForwardArtifacts(output, secrets);
      expect(await readFile(textFile, 'utf8')).not.toContain(
        secrets.SECRET_PASSWORD,
      );
      expect(await readFile(textFile, 'utf8')).not.toContain(
        'forward this run-1',
      );
      await expect(
        scanForwardArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      await writeFile(textFile, 'Bearer unregistered-token\n');
      await expect(scanForwardArtifacts(output, secrets)).rejects.toThrow();
      await writeFile(textFile, '{}\n');
      await writeFile(raster, 'not-a-real-image');
      await expect(scanForwardArtifacts(output, secrets)).rejects.toThrow();
      await scrubForwardArtifacts(output, secrets);
      expect(existsSync(raster)).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('withholds publication after incomplete secrets, cleanup, or scrub', async () => {
    const { markForwardDiagnosticsSafe } =
      await import('../e2e/android/message-forward-artifacts.mts');
    const output = await mkdtemp(join(tmpdir(), 'trinity-forward-gate-'));
    try {
      await writeFile(join(output, 'receipt.json'), '{}\n');
      for (const flags of [
        { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
        { unsafeSecrets: false, cleanupFailed: true, scrubFailed: false },
        { unsafeSecrets: false, cleanupFailed: false, scrubFailed: true },
      ]) {
        await expect(
          markForwardDiagnosticsSafe(output, {}, flags),
        ).rejects.toThrow();
        expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      }
      await markForwardDiagnosticsSafe(
        output,
        {},
        {
          unsafeSecrets: false,
          cleanupFailed: false,
          scrubFailed: false,
        },
      );
      expect(await readFile(join(output, 'publication-safe'), 'utf8')).toBe(
        'scanned\n',
      );
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('blocks actual failed teardown and revokes a cancelled run report and marker', async () => {
    const {
      markForwardDiagnosticsSafe,
      revokeForwardPublicationOnAbort,
      runForwardStageCleanup,
    } = await import('../e2e/android/message-forward-artifacts.mts');
    const output = await mkdtemp(join(tmpdir(), 'trinity-forward-teardown-'));
    try {
      const flags = {
        unsafeSecrets: false,
        cleanupFailed: false,
        scrubFailed: false,
      };
      const failures = [];
      let secondCleanupRan = false;
      await runForwardStageCleanup(
        [
          async () => {
            throw new Error('client close failed');
          },
          async () => {
            secondCleanupRan = true;
          },
        ],
        flags,
        failures,
      );
      expect(secondCleanupRan).toBe(true);
      expect(failures).toHaveLength(1);
      expect(flags.cleanupFailed).toBe(true);
      await expect(
        markForwardDiagnosticsSafe(output, {}, flags),
      ).rejects.toThrow();
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);

      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'stale\n');
      const cancelled = new AbortController();
      cancelled.abort(new Error('test interrupted'));
      await revokeForwardPublicationOnAbort(output, report, cancelled.signal);
      expect(report.status).toBe('failed');
      expect(report.stages[0].status).toBe('failed');
      expect(report.stages[0].failureCount).toBe(1);
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
      report.stages[0].error = 'raw token from prior failure';
      await writeFile(join(output, 'publication-safe'), 'stale\n');
      await revokeForwardPublicationOnAbort(output, report, cancelled.signal);
      expect(report.stages[0].error).toBe(
        'Cancelled before forward publication',
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      await expect(
        markForwardDiagnosticsSafe(
          output,
          {},
          {
            unsafeSecrets: false,
            cleanupFailed: false,
            scrubFailed: false,
          },
          cancelled.signal,
        ),
      ).rejects.toThrow();
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('registers one serialized Nx suite and retains the browser predecessor', async () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const pkg = JSON.parse(read('package.json'));
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const target = project.targets['message-forward'];
    expect(target?.cache).toBe(false);
    expect(target?.parallelism).toBe(false);
    expect(target?.options.command).toContain(
      '--suite=android.message-forward',
    );
    expect(target?.options.command).toContain(
      '--entrypoint=e2e/android/message-forward-journeys.mts',
    );
    expect(target?.options.command).toContain(
      '--platform=android --bundle-manifest --resource=android-avd --resource=synapse',
    );
    expect(pkg.scripts['e2e:android:message-forward']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:message-forward',
    );
    const suite = RUNNER_E2E_SUITES.filter(
      (item) => item.id === 'android.message-forward',
    );
    expect(suite).toHaveLength(1);
    expect(suite[0]).toMatchObject({
      currentTarget: 'trinity-e2e-android:message-forward',
      serializationKeys: ['android-avd', 'synapse'],
      canonicalScript: 'e2e:android:message-forward',
    });
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-forward',
      ),
    ).toHaveLength(1);
    expect(
      E2E_CI_ENTRYPOINTS.filter((item) =>
        item.suiteIds.includes('android.message-forward'),
      ),
    ).toHaveLength(1);
    expect(read(predecessor)).toContain(
      "test('forwards a message to another room'",
    );
  });

  it('runs before cross-user and uploads only started publication-safe diagnostics', () => {
    const workflow = read('.github/workflows/ci.yml');
    const runLine = 'pnpm nx run trinity-e2e-android:message-forward; fi';
    expect(workflow).toContain(runLine);
    expect(workflow.indexOf(runLine)).toBeGreaterThan(
      workflow.indexOf('pnpm nx run trinity-e2e-android:edit-history; fi'),
    );
    expect(workflow.indexOf(runLine)).toBeLessThan(
      workflow.indexOf('trinity-e2e-android:cross-user-verification; fi'),
    );
    expect(workflow).toContain('message-forward-started=true');
    expect(workflow).toContain('Gate Android message-forward diagnostics');
    expect(workflow).toContain('message-forward-artifact-gate');
    expect(workflow).toContain(
      "'*/android.message-forward/message-forward/publication-safe'",
    );
    expect(workflow).toContain(
      "steps.message-forward-artifact-gate.outputs.message-forward-safe == 'true'",
    );
    expect(workflow).toContain('surface: android-message-forward');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.message-forward/**',
    );
    expect(read('e2e/android/MIGRATION.md')).toContain(
      'Suite `android.message-forward`',
    );
  });
});
