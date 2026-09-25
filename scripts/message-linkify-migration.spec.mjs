import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-linkify.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const digest = (path) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');
const loadContract = () =>
  import('../e2e/android/message-linkify-contract.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-linkify-artifacts.mts');
const expectedAssertions = [
  'message-linkify.room-ready',
  'message-linkify.link-visible',
];
const body = 'look at https://example.com';
const url = 'https://example.com';
const eventId = '$Linkify_A+b/C=d:example.test';

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

const serverEvent = {
  event_id: eventId,
  room_id: '!Room-AbC:example.test',
  sender: '@linkify:example.test',
  type: 'm.room.message',
  content: { msgtype: 'm.text', body },
};
const expectedEvent = {
  eventId,
  roomId: '!Room-AbC:example.test',
  sender: '@linkify:example.test',
};

function validRendering() {
  return {
    rowCount: 1,
    rowId: eventId,
    rowVisible: true,
    text: body,
    textOutsideAnchors: 'look at ',
    anchors: [{ text: url, href: url, visible: true }],
    previewDestinations: 0,
    rowDestinationMatches: 1,
    timelineMatches: 1,
  };
}

/** Run the journey's exact read-only expression against production linkify markup. */
async function observeDocument(
  messageHtml = `look at <a href="${url}">${url}</a>`,
  { rowStyle = '', anchorStyle = '', extraRows = '', rowExtra = '' } = {},
) {
  const { linkifyObservationExpression } =
    await import('../e2e/android/message-linkify-journeys.mts');
  const dom = new JSDOM(
    `<div class="scroll">
      <div class="msg" data-mid="${eventId}" style="${rowStyle}">
        <div class="msg__body"><div class="msg__content">
          <div class="msg__text msg__text--html">${messageHtml}</div>
        </div></div>${rowExtra}
      </div>${extraRows}
    </div>`,
  );
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden =
      this.getAttribute('style')?.includes('width:0') ||
      this.getAttribute('style')?.includes('height:0');
    return { width: hidden ? 0 : 120, height: hidden ? 0 : 20 };
  };
  const anchors = window.document.querySelectorAll('a');
  for (const anchor of anchors) anchor.setAttribute('style', anchorStyle);
  return runInNewContext(linkifyObservationExpression(eventId), {
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    NodeFilter: window.NodeFilter,
  });
}

describe('Android message-linkify migration contract', () => {
  it('pins the exact predecessor definition, Room helper and shared login pins', () => {
    const source = read(predecessor);
    expect(digest(predecessor)).toBe(
      'dd48aadd26ab1d960077d71ad68cd4ee8bf9b836706b4beb4620a34e7f7551a3',
    );
    expect(digest('e2e/support/app.mts')).toBe(
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    expect(digest('e2e/support/account.mts')).toBe(
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );
    expect(assertionLines(source, 28, 73)).toEqual([66]);
    expect(assertionLines(source, 15, 23)).toEqual([20]);
    expect(source).toContain(
      "test('renders a bare URL in a message as a clickable link'",
    );
    expect(source).toContain(
      "await composer.fill('look at https://example.com');",
    );
    expect(source).toContain(
      '.locator(\'.scroll .msg a[href="https://example.com"]\'',
    );
    expect(source).toContain("hasText: 'https://example.com'");
  });

  it('requires two unique source-ordered identities', async () => {
    const { MESSAGE_LINKIFY_ASSERTIONS, assertLinkifyRecords } =
      await loadContract();
    expect(MESSAGE_LINKIFY_ASSERTIONS).toEqual(expectedAssertions);
    expect(() => assertLinkifyRecords(expectedAssertions)).not.toThrow();
    for (const invalid of [
      [],
      expectedAssertions.slice(0, 1),
      [expectedAssertions[0], expectedAssertions[0]],
      [...expectedAssertions].reverse(),
      [...expectedAssertions, expectedAssertions[1]],
    ])
      expect(() => assertLinkifyRecords(invalid)).toThrow();
  });

  it('requires the exact native Room route and Account', async () => {
    const { assertLinkifyRoomRoute } = await loadContract();
    const roomId = '!Room-AbC:example.test';
    const encoded = Buffer.from(roomId).toString('base64url');
    const route = `https://localhost/rooms/${encoded}?account=%40linkify%3Aexample.test&view=rooms`;
    expect(() =>
      assertLinkifyRoomRoute(route, roomId, '@linkify:example.test'),
    ).not.toThrow();
    for (const invalid of [
      route.replace(
        encoded,
        Buffer.from('!other:example.test').toString('base64url'),
      ),
      route.replace('%40linkify', '%40other'),
      route.replace('view=rooms', 'view=spaces'),
    ])
      expect(() =>
        assertLinkifyRoomRoute(invalid, roomId, '@linkify:example.test'),
      ).toThrow();
  });

  it('rejects a pending, mismatched, formatted or altered server event', async () => {
    const { assertPlainLinkifyEvent } = await loadContract();
    expect(() =>
      assertPlainLinkifyEvent(serverEvent, expectedEvent),
    ).not.toThrow();
    for (const invalid of [
      { ...serverEvent, event_id: '~pending' },
      { ...serverEvent, event_id: '$other' },
      { ...serverEvent, room_id: '!other:example.test' },
      { ...serverEvent, sender: '@other:example.test' },
      { ...serverEvent, type: 'm.sticker' },
      {
        ...serverEvent,
        content: { ...serverEvent.content, msgtype: 'm.notice' },
      },
      { ...serverEvent, content: { ...serverEvent.content, body: 'look at' } },
      { ...serverEvent, content: { ...serverEvent.content, body: `${body} ` } },
      {
        ...serverEvent,
        content: {
          ...serverEvent.content,
          format: 'org.matrix.custom.html',
          formatted_body: `look at <a href="${url}">${url}</a>`,
        },
      },
      {
        ...serverEvent,
        content: { ...serverEvent.content, formatted_body: body },
      },
      {
        ...serverEvent,
        content: { ...serverEvent.content, 'm.relates_to': { event_id: '$x' } },
      },
      {
        ...serverEvent,
        content: { ...serverEvent.content, 'm.new_content': { body } },
      },
      { ...serverEvent, content: null },
    ])
      expect(() => assertPlainLinkifyEvent(invalid, expectedEvent)).toThrow();
  });

  it('accepts exactly one visible exact link and rejects every near miss', async () => {
    const { assertLinkifiedRendering } = await loadContract();
    expect(() =>
      assertLinkifiedRendering(validRendering(), eventId),
    ).not.toThrow();
    const anchor = validRendering().anchors[0];
    for (const change of [
      { rowCount: 0 },
      { rowCount: 2 },
      { rowId: '$other' },
      { rowVisible: false },
      { text: 'look at' },
      { anchors: [] },
      { anchors: [anchor, anchor] },
      { anchors: [{ ...anchor, text: `${url}/` }] },
      { anchors: [{ ...anchor, text: body }] },
      { anchors: [{ ...anchor, href: `${url}/` }] },
      { anchors: [{ ...anchor, href: 'http://example.com' }] },
      { anchors: [{ ...anchor, href: null }] },
      { anchors: [{ ...anchor, visible: false }] },
      { textOutsideAnchors: '' },
      { textOutsideAnchors: body },
      { rowDestinationMatches: 0 },
      { rowDestinationMatches: 2 },
      { timelineMatches: 0 },
      { timelineMatches: 2 },
    ])
      expect(() =>
        assertLinkifiedRendering({ ...validRendering(), ...change }, eventId),
      ).toThrow();
  });

  it('rejects malformed renderer observations before recording', async () => {
    const { parseLinkifyRendering } = await loadContract();
    expect(parseLinkifyRendering(validRendering())).toEqual(validRendering());
    for (const invalid of [
      null,
      [],
      { ...validRendering(), rowCount: -1 },
      { ...validRendering(), rowCount: 1.5 },
      { ...validRendering(), rowId: 1 },
      { ...validRendering(), rowVisible: 'yes' },
      { ...validRendering(), anchors: {} },
      { ...validRendering(), anchors: [{ text: url, href: 1, visible: true }] },
      { ...validRendering(), anchors: [{ text: url, href: url }] },
      { ...validRendering(), timelineMatches: Number.NaN },
      { ...validRendering(), rowDestinationMatches: -1 },
      { ...validRendering(), previewDestinations: undefined },
    ])
      expect(() => parseLinkifyRendering(invalid)).toThrow();
  });

  it('observes the production linkify markup and rejects styling or whole-body links', async () => {
    const { assertLinkifiedRendering, parseLinkifyRendering } =
      await loadContract();
    const observe = async (...args) =>
      parseLinkifyRendering(await observeDocument(...args));
    const production = await observe();
    expect(() => assertLinkifiedRendering(production, eventId)).not.toThrow();
    // A loaded link-preview card links to the same URL but is its own feature.
    const withPreview = await observe(undefined, {
      rowExtra: `<trn-link-preview><a href="${url}">example.com Example Domain</a></trn-link-preview>`,
    });
    expect(withPreview.previewDestinations).toBe(1);
    expect(() => assertLinkifiedRendering(withPreview, eventId)).not.toThrow();
    for (const rendering of [
      await observe(`look at <span class="link">${url}</span>`),
      await observe(`<a href="${url}">look at ${url}</a>`),
      await observe(`look at <a href="${url}/">${url}</a>`),
      await observe(`look at <a>${url}</a>`),
      await observe(
        `look at <a href="${url}">${url}</a> <a href="${url}">${url}</a>`,
      ),
      await observe(undefined, { anchorStyle: 'visibility:hidden' }),
      await observe(undefined, { anchorStyle: 'width:0' }),
      await observe(undefined, { rowStyle: 'visibility:hidden' }),
      await observe(undefined, {
        extraRows: `<div class="msg" data-mid="$preview"><a href="${url}">${url}</a></div>`,
      }),
      await observe(undefined, {
        extraRows: `<div class="msg" data-mid="$other"><a href="${url}">elsewhere</a></div>`,
      }),
      await observe(undefined, {
        rowExtra: `<div class="msg__reply"><a href="${url}">Example</a></div>`,
      }),
    ])
      expect(() => assertLinkifiedRendering(rendering, eventId)).toThrow();
  });

  it('sends the exact plain body through native input and observes read-only', () => {
    const journey = read('e2e/android/message-linkify-journeys.mts');
    for (const call of [
      'client.login(account)',
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
      "client.tapCurrent('.channel', { text: room.name })",
      'client.focusCurrent(COMPOSER)',
      'client.fillFocused(COMPOSER, prefix)',
      'e2e/android/flows/message-linkify-append.yaml',
      'enterLinkifyBody(client)',
      'client.tapCurrent(\'[data-testid="composer-send"]\')',
      'fixtures.roomEvent(account, room.id, eventId)',
      'assertPlainLinkifyEvent(',
      'assertLinkifiedRendering(rendering, eventId)',
      'assertLinkifyRoomRoute(',
      'assertLinkifyRecords(records)',
      "client.capture('passed')",
      "client.capture('failed')",
      'withNodeTestResources(',
      'runLinkifyStageCleanup(',
      'revokeLinkifyPublicationOnAbort(',
      'installWithAndroidRuntimeProvenance(',
      'SECRET_LINKIFY_EVENT_ID',
      'SECRET_LINKIFY_ROOM_SEGMENT',
    ])
      expect(journey).toContain(call);
    // Mobile Enter inserts a new line in the composer (d3b27323); only Send sends.
    expect(journey).not.toContain("client.key('enter')");
    expect(journey).not.toMatch(
      /\.(?:click|focus|submit|dispatchEvent|scrollIntoView)\(|location\.(?:assign|replace)|\.href\s*=|window\.open/u,
    );
    expect(journey).not.toContain('sendMessage(');
    expect(journey).not.toContain('formatted_body');
    expect(journey).not.toContain('.first()');
  });
});

describe('Android message-linkify diagnostics safety', () => {
  it('rejects bearer, registered secret, encoded identifiers and raster proof', async () => {
    const { scanLinkifyArtifacts } = await loadArtifacts();
    const output = await mkdtemp(join(tmpdir(), 'trinity-linkify-scan-'));
    const receipt = join(output, 'receipt.json');
    const secrets = {
      SECRET_LINKIFY_PASSWORD: 'password-for-linkify',
      SECRET_LINKIFY_ROOM_ID: '!Room-AbC:example.test',
      SECRET_LINKIFY_EVENT_ID: eventId,
    };
    try {
      for (const unsafe of [
        'Bearer unregistered-token',
        'syt_unregistered_token',
        'password-for-linkify',
        'GET /rooms/!Room-AbC%3Aexample.test/event/%24Linkify_A%2Bb%2FC%3Dd%3Aexample.test',
        'GET /event/%24Linkify_A%2bb%2fC%3dd%3aexample.test',
        '<map><string name="trinity.appearance.density">compact</string></map>',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(scanLinkifyArtifacts(output, secrets)).rejects.toThrow();
      }
      await writeFile(receipt, '{}\n');
      await writeFile(join(output, 'capture.png'), 'raster');
      await expect(scanLinkifyArtifacts(output, {})).rejects.toThrow();
      await rm(join(output, 'capture.png'));
      await writeFile(join(output, 'opaque.bin'), 'binary');
      await expect(scanLinkifyArtifacts(output, {})).rejects.toThrow();
      await rm(join(output, 'opaque.bin'));
      await expect(
        scanLinkifyArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('scrubs raw and encoded identifiers and deletes raster proof', async () => {
    const { scrubLinkifyArtifacts, scanLinkifyArtifacts } =
      await loadArtifacts();
    const output = await mkdtemp(join(tmpdir(), 'trinity-linkify-scrub-'));
    const secrets = {
      SECRET_LINKIFY_ROOM_ID: '!Room-AbC:example.test',
      SECRET_LINKIFY_EVENT_ID: eventId,
      SECRET_LINKIFY_PASSWORD: 'password-for-linkify',
    };
    try {
      const nested = join(output, 'message-linkify');
      await mkdir(nested);
      const path = join(nested, 'device.log');
      await writeFile(
        path,
        [
          'GET /rooms/!Room-AbC%3Aexample.test/event/%24Linkify_A%2Bb%2FC%3Dd%3Aexample.test',
          `raw=!Room-AbC:example.test ${eventId}`,
          '{"password":"password-for-linkify"}',
          `unchanged=${url}`,
        ].join('\n'),
      );
      await writeFile(join(nested, 'capture.png'), 'raster');
      await scrubLinkifyArtifacts(output, secrets);
      expect(await readFile(path, 'utf8')).toBe(
        [
          'GET /rooms/[REDACTED]/event/[REDACTED]',
          'raw=[REDACTED] [REDACTED]',
          '{"password":"[REDACTED]"}',
          `unchanged=${url}`,
        ].join('\n'),
      );
      expect(existsSync(join(nested, 'capture.png'))).toBe(false);
      await expect(
        scanLinkifyArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('publishes only a clean complete two-record report with pass captures', async () => {
    const { markLinkifyDiagnosticsSafe } = await loadArtifacts();
    const output = await mkdtemp(join(tmpdir(), 'trinity-linkify-gate-'));
    const valid = {
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 2,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: 'message-linkify',
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 2,
          assertionRecords: 2,
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
    const marker = join(output, 'publication-safe');
    try {
      await writeFile(join(output, 'journeys.json'), JSON.stringify(valid));
      await writeFile(join(output, 'runtime-provenance.json'), '{}\n');
      await expect(
        markLinkifyDiagnosticsSafe(output, {}, flags),
      ).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
      const stageDir = join(output, 'message-linkify');
      await mkdir(stageDir);
      for (const name of [
        'passed.json',
        'passed-ui.json',
        'passed-surface.json',
      ])
        await writeFile(join(stageDir, name), '{}\n');
      await markLinkifyDiagnosticsSafe(output, {}, flags);
      expect(await readFile(marker, 'utf8')).toBe('scanned\n');
      for (const invalid of [
        { ...valid, status: 'failed' },
        { ...valid, retries: 1 },
        { ...valid, stages: [{ ...valid.stages[0], assertionRecords: 1 }] },
        { ...valid, stages: [{ ...valid.stages[0], failureCount: 1 }] },
        {
          ...valid,
          stages: [
            { ...valid.stages[0], assertions: expectedAssertions.slice(0, 1) },
          ],
        },
      ]) {
        await writeFile(join(output, 'journeys.json'), JSON.stringify(invalid));
        await expect(
          markLinkifyDiagnosticsSafe(output, {}, flags),
        ).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      }
      await writeFile(join(output, 'journeys.json'), JSON.stringify(valid));
      for (const unsafe of [
        { ...flags, unsafeSecrets: true },
        { ...flags, cleanupFailed: true },
        { ...flags, scrubFailed: true },
      ]) {
        await expect(
          markLinkifyDiagnosticsSafe(output, {}, unsafe),
        ).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      }
      await writeFile(
        join(stageDir, 'passed-surface.json'),
        `{"event":"${eventId}"}`,
      );
      await expect(
        markLinkifyDiagnosticsSafe(
          output,
          { SECRET_LINKIFY_EVENT_ID: eventId },
          flags,
        ),
      ).rejects.toThrow(/credential or identifier/u);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('runs every teardown step and revokes cancelled publication', async () => {
    const { runLinkifyStageCleanup, revokeLinkifyPublicationOnAbort } =
      await loadArtifacts();
    const output = await mkdtemp(join(tmpdir(), 'trinity-linkify-cleanup-'));
    try {
      const failures = [];
      let secondRan = false;
      await runLinkifyStageCleanup(
        [
          async () => {
            throw new Error('client close failed');
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
      await revokeLinkifyPublicationOnAbort(output, report, controller.signal);
      expect(report.status).toBe('failed');
      expect(report.stages[0]).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before linkify publication',
      });
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});

describe('Android message-linkify hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target and canonical command', async () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const pkg = JSON.parse(read('package.json'));
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const target = project.targets['message-linkify'];
    expect(target.cache).toBe(false);
    expect(target.parallelism).toBe(false);
    expect(target.dependsOn).toEqual([
      { projects: ['trinity-android'], target: 'build-prebuilt' },
    ]);
    expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
    expect(target.options.command).toContain(
      '--suite=android.message-linkify --timeout-ms=1200000 --entrypoint=e2e/android/message-linkify-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse',
    );
    expect(pkg.scripts['e2e:android:message-linkify']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:message-linkify',
    );
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-linkify',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      currentTarget: 'trinity-e2e-android:message-linkify',
      canonicalScript: 'e2e:android:message-linkify',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-linkify',
      ),
    ).toHaveLength(1);
    expect(
      E2E_CI_ENTRYPOINTS.filter((item) =>
        item.suiteIds.includes('android.message-linkify'),
      ),
    ).toHaveLength(1);
    expect(read(predecessor)).toContain(
      "test('renders a bare URL in a message as a clickable link'",
    );
  });

  it('runs at the end of shard one and uploads only started safe diagnostics', () => {
    const workflow = read('.github/workflows/ci.yml');
    const runner = workflow.indexOf('message-linkify-started=true');
    expect(runner).toBeGreaterThan(
      workflow.indexOf('room-http-error-recovery-started=true'),
    );
    expect(runner).toBeLessThan(workflow.indexOf('edit-history-started=true'));
    expect(workflow).toContain(
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'message-linkify-started=true\'',
    );
    expect(workflow).toContain(
      'node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:message-linkify',
    );
    expect(workflow).toContain(
      "-path '*/android.message-linkify/message-linkify/publication-safe'",
    );
    expect(workflow).toContain(
      "steps.android.outputs.message-linkify-started == 'true' && steps.message-linkify-artifact-gate.outputs.message-linkify-safe == 'true'",
    );
    expect(workflow).toContain('surface: android-message-linkify');
  });

  it('documents both exact Android records and retains the predecessor', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration.split('## Message-linkify journey')[1];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(/^\|[^\n]+\| `(message-linkify\.[^`]+)` \|$/gmu),
    ].map((match) => match[1]);
    expect(rows).toEqual(expectedAssertions);
    expect(section).toContain(
      'dd48aadd26ab1d960077d71ad68cd4ee8bf9b836706b4beb4620a34e7f7551a3',
    );
    expect(section).toContain('Suite `android.message-linkify`');
  });
});
