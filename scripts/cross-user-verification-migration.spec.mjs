import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/trust/verify-user.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(
  root,
  'e2e/android/cross-user-verification-contract.mts',
);
const controllerPath = resolve(
  root,
  'e2e/android/cross-user-verification-query-delay.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/cross-user-verification-journeys.mts',
);
const diagnosticsPath = resolve(
  root,
  'e2e/android/recovery-reset-diagnostics.mts',
);

const sharedAssertionIds = [
  'cross-user-verification.members-panel-initially-hidden',
  'cross-user-verification.members-panel-visible',
  'cross-user-verification.counterpart-member-visible',
  'cross-user-verification.member-info-visible',
  'cross-user-verification.verification-page-visible',
];
const delayedAssertionId =
  'cross-user-verification.delayed-identity-query-observed';

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

function assertProtectedRuntimeContract(journey, controller) {
  const journeyFragments = [
    "const PRIMARY_APPLICATION_ID = 'eu.qwky.trinity'",
    "const SECONDARY_APPLICATION_ID = 'eu.qwky.trinity.secondary'",
    'createAccountFixtures(',
    "preset: 'private_chat'",
    'invite: [counterpart.userId]',
    'await fixtures.join(counterpart, room.id)',
    'await primary.login(account)',
    'await establishRecovery(primary, account)',
    'await secondary.login(counterpart)',
    'await establishRecovery(secondary, counterpart)',
    'await client.device.launch()',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.elements('.chat-members')",
    '\'[data-testid="toggle-members"]\'',
    '\'[data-testid="room-actions-overflow"]\'',
    '\'[data-testid="overflow-toggle-members"]\'',
    '\'[data-testid="member-row"]\'',
    'const member = await client.visible(\n' +
      '    \'[data-testid="member-row"]\',\n' +
      '    { text: counterpartName },',
    'await client.tapCurrent(\'[data-testid="member-row"]\', {\n' +
      '    text: counterpartName,\n' +
      '  })',
    '\'[data-testid="member-info"]\'',
    '\'[data-testid="member-info-verify"]\'',
    '\'[data-testid="verify-page"]\'',
    "stage === 'requested' || stage === 'waiting'",
    'await primary.webview.openSession()',
    'installCrossUserIdentityQueryDelay(',
    'counterpartUserId: counterpart.userId',
    'delayMs: 15_000',
    'delayController?.markVerificationStarted()',
    'delayController.matchingRequests > 0',
    'await delayController.close()',
    'delayConnection.close()',
    'expectedStages: 2',
    'expectedUniqueAssertions: 6',
    'expectedAssertionRecords: 11',
    'new Set<CrossUserVerificationAssertion>()',
    'assert(!records.has(recordKey)',
    'redactMaestroArtifacts(output, secrets)',
    'scanCrossUserVerificationArtifacts(output, secrets)',
    'removeCrossUserVerificationMaestroImages(output)',
    'captureSecretSafe(client, name)',
    'await primary.close()',
    'await secondary.close()',
    'await device.clearApplicationData(applicationId)',
    'device.close()',
    'throw new AggregateError(',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const controllerFragments = [
    "pathname === '/_matrix/client/v3/keys/query'",
    "request.method === 'POST'",
    'Object.hasOwn(deviceKeys, counterpartUserId)',
    "connection.on('Fetch.requestPaused'",
    "connection.send('Fetch.enable'",
    "connection.send('Fetch.continueRequest'",
    "connection.send('Fetch.disable'",
    'verificationStarted.promise',
    'setTimeout(delayMs',
    'pendingRequestIds',
  ];
  for (const fragment of controllerFragments)
    expect(controller).toContain(fragment);

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /observation:\s*(?:accessToken|password|recoveryKey|transactionId|deviceSecret)/u,
  );
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|navigate|reload)\s*\(|evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toMatch(/mock(?:Counterpart|CrossSigning|Verification)/u);
}

class FakeDevtoolsConnection {
  listeners = new Map();
  sent = [];

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method, value) {
    for (const listener of this.listeners.get(method) ?? []) listener(value);
  }

  async send(method, params = {}) {
    this.sent.push([method, params]);
    return {};
  }
}

class FailFirstContinueConnection extends FakeDevtoolsConnection {
  failed = false;

  async send(method, params = {}) {
    this.sent.push([method, params]);
    if (method === 'Fetch.continueRequest' && !this.failed) {
      this.failed = true;
      throw new Error('injected first continue failure');
    }
    return {};
  }
}

const paused = (requestId, userId) => ({
  requestId,
  request: {
    method: 'POST',
    url: 'https://localhost:8448/_matrix/client/v3/keys/query',
    postData: JSON.stringify({ device_keys: { [userId]: [] } }),
  },
});

describe('Android cross-user verification migration', () => {
  it('pins the exact predecessor/helper sources and six shared assertion sites', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '4d5ddb20adfc9f661abb05f081057894ec6e4120a35ddb5f067dc4158dab6ebd',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[30]).toContain('async function apiLogin');
    expect(predecessor[51]).toContain('async function openRoom');
    expect(predecessor[62]).toContain('async function setUpEncryption');
    expect(predecessor[99]).toContain(
      'async function verifyUserFromMemberPanel',
    );
    expect(predecessor[230]).toContain(
      "test('starts cross-user verification from the member panel'",
    );
    expect(predecessor[243]).toBe('  });');
    expect(predecessor[245]).toContain(
      "test('starts cross-user verification with a delayed counterpart identity'",
    );
    expect(predecessor[262]).toBe('  });');

    const assertionBlock = predecessor.slice(190, 225).join('\n');
    const helperBlock = predecessor.slice(99, 226).join('\n');
    expect(assertionBlock.match(/\bexpect\s*\(/gu)).toHaveLength(5);
    expect(
      assertionBlock.match(/memberRow\.first\(\)\.waitFor\s*\(/gu),
    ).toHaveLength(1);
    expect(helperBlock).toContain(
      "const identityRoute = '**/_matrix/client/v3/keys/query'",
    );
    expect(helperBlock).toContain('setTimeout(resolve, 15_000)');
    expect(helperBlock).toContain(
      'Object.hasOwn(body.device_keys ?? {}, otherUser.userId)',
    );
    expect(helperBlock).toContain(
      'await page.unroute(identityRoute, delayHandler)',
    );
    expect(app.join('\n')).toContain('export async function login(');
    expect(app.join('\n')).toContain('export async function waitForRooms(');
    expect(account.join('\n')).toContain('export async function registerUser(');
    expect(account.join('\n')).toContain(
      'export async function passwordLogin(',
    );
  });

  it('exports exactly six unique and eleven stage-local assertion records', async () => {
    expect(
      contractPath,
      'cross-user-verification-contract.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.CROSS_USER_VERIFICATION_SOURCES).toEqual({
      helpers: `${predecessorSource}:31-226`,
      ordinary: `${predecessorSource}:231-244`,
      delayed: `${predecessorSource}:246-263`,
      app: appSource,
      account: accountSource,
    });
    expect(
      Object.values(contract.crossUserVerificationAssertions.shared),
    ).toEqual(sharedAssertionIds);
    expect(
      contract.crossUserVerificationAssertions.delayed.identityQueryObserved,
    ).toBe(delayedAssertionId);
    expect(contract.CROSS_USER_VERIFICATION_ASSERTION_RECORDS).toBe(11);
  });

  it('implements two real installed-app stages with native product actions', () => {
    const journey = readIfPresent(journeyPath);
    const controller = readIfPresent(controllerPath);
    expect(journey, 'cross-user-verification-journeys.mts must exist').not.toBe(
      '',
    );
    expect(
      controller,
      'cross-user-verification-query-delay.mts must exist',
    ).not.toBe('');
    assertProtectedRuntimeContract(journey, controller);
    expect(journey).toContain("id: 'member-panel-verification'");
    expect(journey).toContain("id: 'delayed-counterpart-identity'");
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    for (const identity of [...sharedAssertionIds, delayedAssertionId]) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('delays only exact counterpart identity queries and releases every request', async () => {
    expect(
      controllerPath,
      'cross-user-verification-query-delay.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(controllerPath)) return;
    const { installCrossUserIdentityQueryDelay } = await import(controllerPath);
    const connection = new FakeDevtoolsConnection();
    const controller = await installCrossUserIdentityQueryDelay(connection, {
      counterpartUserId: '@counterpart:localhost',
      delayMs: 1,
    });

    connection.emit(
      'Fetch.requestPaused',
      paused('unrelated', '@someone-else:localhost'),
    );
    connection.emit('Fetch.requestPaused', {
      ...paused('prefixed-path', '@counterpart:localhost'),
      request: {
        ...paused('prefixed-path', '@counterpart:localhost').request,
        url: 'https://localhost:8448/prefix/_matrix/client/v3/keys/query',
      },
    });
    connection.emit(
      'Fetch.requestPaused',
      paused('counterpart', '@counterpart:localhost'),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controller.matchingRequests).toBe(1);
    expect(connection.sent).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'unrelated' },
    ]);
    expect(connection.sent).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'prefixed-path' },
    ]);
    expect(connection.sent).not.toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'counterpart' },
    ]);

    controller.markVerificationStarted();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection.sent).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'counterpart' },
    ]);
    await controller.close();
    expect(connection.sent.at(-1)).toEqual(['Fetch.disable', {}]);
  });

  it('preserves the full identity delay when cleanup follows verification start', async () => {
    expect(
      controllerPath,
      'cross-user-verification-query-delay.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(controllerPath)) return;
    const { installCrossUserIdentityQueryDelay } = await import(controllerPath);
    const connection = new FakeDevtoolsConnection();
    const controller = await installCrossUserIdentityQueryDelay(connection, {
      counterpartUserId: '@counterpart:localhost',
      delayMs: 40,
    });

    connection.emit(
      'Fetch.requestPaused',
      paused('full-delay', '@counterpart:localhost'),
    );
    controller.markVerificationStarted();
    const started = performance.now();
    await controller.close();

    expect(performance.now() - started).toBeGreaterThanOrEqual(30);
    expect(connection.sent).toContainEqual([
      'Fetch.continueRequest',
      { requestId: 'full-delay' },
    ]);
    expect(connection.sent.at(-1)).toEqual(['Fetch.disable', {}]);
  });

  it('retains a paused request for cleanup when its first release fails', async () => {
    expect(
      controllerPath,
      'cross-user-verification-query-delay.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(controllerPath)) return;
    const { installCrossUserIdentityQueryDelay } = await import(controllerPath);
    const connection = new FailFirstContinueConnection();
    const controller = await installCrossUserIdentityQueryDelay(connection, {
      counterpartUserId: '@counterpart:localhost',
      delayMs: 0,
    });

    connection.emit(
      'Fetch.requestPaused',
      paused('retry-on-close', '@counterpart:localhost'),
    );
    controller.markVerificationStarted();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(controller.close()).rejects.toThrow(
      'injected first continue failure',
    );
    expect(
      connection.sent.filter(
        ([method, params]) =>
          method === 'Fetch.continueRequest' &&
          params.requestId === 'retry-on-close',
      ),
    ).toHaveLength(2);
    expect(connection.sent.at(-1)).toEqual(['Fetch.disable', {}]);
  });

  it('suppresses failure screenshots while recovery material is visible', async () => {
    const { captureSecretSafe } = await import(diagnosticsPath);
    const records = [];
    let captures = 0;
    const client = {
      output: '/unused',
      elements: async () => [
        {
          visible: true,
          text: 'recovery-secret-must-not-leak',
          value: null,
          hasValue: false,
        },
      ],
      surface: async () => ({ url: 'https://localhost/recovery/setup' }),
      record: async (name, value) => records.push([name, value]),
      capture: async () => {
        captures += 1;
      },
    };

    await captureSecretSafe(client, 'failed-primary');

    expect(captures).toBe(0);
    expect(records).toEqual([
      [
        'failed-primary-capture',
        {
          capture: 'suppressed-sensitive-surface',
          pathname: '/recovery/setup',
          visibleSensitiveSurface: true,
        },
      ],
    ]);
    expect(JSON.stringify(records)).not.toContain(
      'recovery-secret-must-not-leak',
    );
  });

  it('rejects fabricated counterparts, broad delays, renderer actions and cleanup loss', () => {
    const journey = readIfPresent(journeyPath);
    const controller = readIfPresent(controllerPath);
    expect(() =>
      assertProtectedRuntimeContract(journey, controller),
    ).not.toThrow();
    const mutations = [
      [
        'await fixtures.join(counterpart, room.id)',
        'await fixtures.join(account, room.id)',
      ],
      [
        'await establishRecovery(secondary, counterpart)',
        'await fixtures.mockCrossSigning(counterpart)',
      ],
      [
        "await client.elements('.chat-members')",
        "await client.elements('.missing-members')",
      ],
      [
        'const member = await client.visible(\n' +
          '    \'[data-testid="member-row"]\',\n' +
          '    { text: counterpartName },',
        'const member = await client.visible(\n' +
          '    \'[data-testid="member-row"]\',\n' +
          '    {},',
      ],
      [
        'await client.tapCurrent(\'[data-testid="member-row"]\', {\n' +
          '    text: counterpartName,\n' +
          '  })',
        'await client.tapCurrent(\'[data-testid="member-row"]\')',
      ],
      [
        'await primary.tapCurrent(\'[data-testid="member-info-verify"]\')',
        "await evaluateNative(primary.webview, `document.querySelector('[data-testid=member-info-verify]').click()`)",
      ],
      [
        'document.querySelector(\'[data-testid="verify-page"]\')',
        'document.querySelector(\'[data-testid="missing-verify-page"]\')',
      ],
      [
        'delayController.matchingRequests > 0',
        'delayController.matchingRequests >= 0',
      ],
      ['await delayController.close()', 'await Promise.resolve()'],
      ['await primary.close()', 'await Promise.resolve()'],
      ['removeCrossUserVerificationMaestroImages(output)', 'Promise.resolve()'],
      ['captureSecretSafe(client, name)', 'await client.capture(name)'],
      ['redactMaestroArtifacts(output, secrets)', 'Promise.resolve()'],
      [
        'scanCrossUserVerificationArtifacts(output, secrets)',
        'Promise.resolve()',
      ],
    ];
    for (const [before, after] of mutations) {
      expect(journey).toContain(before);
      expect(() =>
        assertProtectedRuntimeContract(
          journey.replace(before, after),
          controller,
        ),
      ).toThrow();
    }
    expect(() =>
      assertProtectedRuntimeContract(
        journey,
        controller.replace(
          "pathname === '/_matrix/client/v3/keys/query'",
          'pathname.includes("/_matrix/client/")',
        ),
      ),
    ).toThrow();
  });

  it('registers one bounded uncached suite with started-only diagnostics', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['cross-user-verification'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [
        { projects: ['trinity-android'], target: 'build-prebuilt' },
        {
          projects: ['trinity-android'],
          target: 'build-secondary-prebuilt',
        },
      ],
    });
    expect(target.options.command).toContain(
      '--suite=android.cross-user-verification',
    );
    expect(target.options.command).toContain('--timeout-ms=1800000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/cross-user-verification-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:cross-user-verification']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:cross-user-verification',
    );

    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.cross-user-verification'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:cross-user-verification'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:cross-user-verification'",
    );
    expect(runners).toContain("'maestro'");
    expect(commands).toContain("name: 'e2e:android:cross-user-verification'");
    expect(commands).toContain("suiteIds: ['android.cross-user-verification']");
    expect(workflow).toContain('cross-user-verification-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:cross-user-verification',
    );
    expect(
      workflow.indexOf('cross-user-verification-started=true'),
    ).toBeLessThan(workflow.indexOf('legacy-sso-started=true'));
    expect(workflow).toContain('surface: android-cross-user-verification');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.cross-user-verification/**',
    );
  });

  it('documents parity and retains both exact predecessors', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Cross-user verification journeys');
    expect(migration).toContain('`android.cross-user-verification`');
    expect(migration).toContain(
      '4d5ddb20adfc9f661abb05f081057894ec6e4120a35ddb5f067dc4158dab6ebd',
    );
    expect(migration).toContain('six unique direct assertion identities');
    expect(migration).toMatch(/11\s+stage-local direct assertion records/u);
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain("path: 'journeys/trust/verify-user.spec.mts'");
    expect(read(predecessorSource)).toContain(
      "test('starts cross-user verification from the member panel'",
    );
    expect(read(predecessorSource)).toContain(
      "test('starts cross-user verification with a delayed counterpart identity'",
    );
  });
});
