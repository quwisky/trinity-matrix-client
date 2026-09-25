import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sources = {
  mobile:
    'e2e/browser/journeys/room-administration/room-settings-widgets-mobile.spec.mts',
  definition:
    'e2e/browser/journeys/room-administration/room-widget-settings.spec.mts',
  widgetFixture: 'e2e/browser/support/widget.mts',
  roomSettings: 'e2e/browser/support/room-settings-journey.mts',
  multiAccount: 'e2e/browser/support/multi-account-journey.mts',
  app: 'e2e/support/app.mts',
};
const contractPath = resolve(root, 'e2e/android/room-widget-contract.mts');
const fixturePath = resolve(root, 'e2e/android/room-widget-fixture.mts');
const journeyPath = resolve(root, 'e2e/android/room-widget-journeys.mts');
const faultPath = resolve(root, 'e2e/android/matrix-http-fault.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const inheritedAssertionIds = [
  'mobile.widgets-tab-visible',
  'bridge.room-timeline-visible',
  'bridge.widgets-tab-visible',
  'management.room-timeline-visible',
  'management.widgets-tab-visible',
  'authority.room-timeline-visible',
  'authority.widgets-tab-visible',
];

const directAssertionIds = [
  'mobile.room-timeline-visible',
  'mobile.discard-copy',
  'mobile.draft-name-retained',
  'mobile.draft-url-retained',
  'mobile.created-widget-visible',
  'mobile.no-eager-request-after-create',
  'mobile.scroll-region-overflows',
  'mobile.seeded-card-count',
  'mobile.seeded-card-labels',
  'mobile.last-card-visible',
  'mobile.long-url-visible',
  'mobile.horizontal-containment',
  'mobile.no-eager-request-before-embed',
  'mobile.widget-api-ready',
  'mobile.frame-box-present',
  'mobile.frame-width',
  'mobile.frame-top-contained',
  'mobile.frame-bottom-contained',
  'mobile.frame-closed',
  'mobile.cancel-box-present',
  'mobile.cancel-bottom-contained',
  'mobile.theme-cancel-visible',
  'mobile.theme-open-visible',
  'mobile.scaled-last-card-visible',
  'bridge.card-name',
  'bridge.card-type',
  'bridge.card-raw-url',
  'bridge.card-origin',
  'bridge.card-room-substitution',
  'bridge.card-user-substitution',
  'bridge.open-href',
  'bridge.open-target',
  'bridge.open-rel',
  'bridge.no-eager-request',
  'bridge.first-negotiating',
  'bridge.first-close-focused',
  'bridge.first-request-count',
  'bridge.first-request-present',
  'bridge.sibling-forgery-rejected',
  'bridge.first-frame-closed',
  'bridge.embed-refocused-after-first-close',
  'bridge.second-negotiating',
  'bridge.second-request-present',
  'bridge.changed-origin-rejected',
  'bridge.embed-refocused-after-second-close',
  'bridge.ready',
  'bridge.request-count',
  'bridge.referrers',
  'bridge.sandbox',
  'bridge.referrer-policy',
  'bridge.fullscreen-denied',
  'bridge.fixture-heading',
  'bridge.requested-capabilities',
  'bridge.approved-capabilities',
  'bridge.policy-api',
  'bridge.denied-features',
  'bridge.mixed-content-blocked',
  'bridge.embed-refocused-after-final-close',
  'management.opening-account',
  'management.member-account-active',
  'management.opening-account-retained',
  'management.adding-pending',
  'management.create-error',
  'management.draft-name-retained',
  'management.draft-url-retained',
  'management.card-visible',
  'management.creator-href',
  'management.no-eager-request-after-create',
  'management.declaration-present',
  'management.declaration-exact',
  'management.feedback-visible',
  'management.name-focused',
  'management.confirmation-name',
  'management.confirmation-scope',
  'management.card-removed',
  'management.name-refocused',
  'management.no-eager-request-after-removal',
  'management.tombstone-empty',
  'authority.initial-card-visible',
  'authority.initial-create-absent',
  'authority.initial-remove-absent',
  'authority.granted-create-visible',
  'authority.granted-remove-visible',
  'authority.revoked-create-absent',
  'authority.revoked-remove-absent',
  'authority.no-eager-request',
];

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

function devtoolsFixture() {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    connection: {
      async send(method, params = {}) {
        calls.push({ method, params });
        return {};
      },
      on(method, listener) {
        const current = listeners.get(method) ?? new Set();
        current.add(listener);
        listeners.set(method, current);
        return () => current.delete(listener);
      },
      close() {},
    },
    emit(method, params) {
      for (const listener of [...(listeners.get(method) ?? [])]) {
        listener(params);
      }
    },
  };
}

async function settleEvents() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

describe('Android Room widget migration', () => {
  it('pins all predecessor and helper sources', () => {
    const mobile = sourceLines(
      sources.mobile,
      '41344fee6b5ed35b7f34ae332696fd7be4e25237b923319d5259360721975337',
    );
    const definition = sourceLines(
      sources.definition,
      '7d99871e26cd216c276d895e96cc26b9fe81b2181dbaeb0a28b361c8e8b670a0',
    );
    sourceLines(
      sources.widgetFixture,
      '23f37e9ca70d247a536b0985ab7e4d0ed235b4bea41350456241f9b04a7cc2ea',
    );
    sourceLines(
      sources.roomSettings,
      'bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7',
    );
    sourceLines(
      sources.multiAccount,
      'd0eba322f61a8139fc0666dee5f0575a473f5bcd9007af619f22b740bc851306',
    );
    sourceLines(
      sources.app,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );

    expect(mobile[36]).toContain(
      "test('keeps every widget and the modal actions reachable'",
    );
    expect(mobile[235]).toBe('  });');
    expect(definition[19]).toContain("test('embeds a real room widget");
    expect(definition[234]).toBe('  });');
    expect(definition[236]).toContain("test('the opening admin adds");
    expect(definition[420]).toBe('  });');
    expect(definition[422]).toContain(
      "test('widget management follows live power grants and revocations'",
    );
    expect(definition[542]).toBe('  });');
  });

  it('exports exact source mappings and stable 86+7 identities', async () => {
    expect(
      existsSync(contractPath),
      'room-widget-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);
    expect(contract.ROOM_WIDGET_SOURCES).toEqual({
      mobile: `${sources.mobile}:37-236`,
      bridge: `${sources.definition}:20-235`,
      management: `${sources.definition}:237-421`,
      authority: `${sources.definition}:423-543`,
      widgetFixture: sources.widgetFixture,
      roomSettings: sources.roomSettings,
      multiAccount: sources.multiAccount,
      app: sources.app,
    });
    expect(Object.values(contract.roomWidgetInheritedAssertions)).toEqual(
      inheritedAssertionIds,
    );
    expect(Object.values(contract.roomWidgetDirectAssertions)).toEqual(
      directAssertionIds,
    );
    const assertionIds = [...inheritedAssertionIds, ...directAssertionIds];
    expect(Object.values(contract.roomWidgetAssertions)).toEqual(assertionIds);
    expect(new Set(assertionIds).size).toBe(93);
  });

  it('serves only exact widget peers and accounts for requests and cleanup', async () => {
    expect(existsSync(fixturePath), 'room-widget-fixture.mts must exist').toBe(
      true,
    );
    const { installRoomWidgetFixture } = await import(fixturePath);
    const devtools = devtoolsFixture();
    const fixture = await installRoomWidgetFixture(devtools.connection, {
      capabilityDelayMs: 1_500,
    });

    expect(devtools.calls[0]).toEqual({
      method: 'Fetch.enable',
      params: {
        patterns: [
          {
            urlPattern: 'https://widgets.example/*',
            requestStage: 'Request',
          },
          {
            urlPattern: 'https://attacker.example/origin-change',
            requestStage: 'Request',
          },
        ],
      },
    });

    devtools.emit('Fetch.requestPaused', {
      requestId: 'widget-1',
      request: {
        method: 'GET',
        url: 'https://widgets.example/board?room=!one:localhost',
        headers: { Referer: 'https://must-not-leak.example/' },
      },
    });
    devtools.emit('Fetch.requestPaused', {
      requestId: 'sibling',
      request: {
        method: 'GET',
        url: 'https://widgets.example/attacker',
        headers: {},
      },
    });
    devtools.emit('Fetch.requestPaused', {
      requestId: 'changed-origin',
      request: {
        method: 'GET',
        url: 'https://attacker.example/origin-change',
        headers: {},
      },
    });
    devtools.emit('Fetch.requestPaused', {
      requestId: 'unrelated',
      request: {
        method: 'GET',
        url: 'https://attacker.example/not-owned',
        headers: {},
      },
    });
    await settleEvents();

    expect(fixture.requestCount).toBe(1);
    expect(fixture.referrers).toEqual(['https://must-not-leak.example/']);
    const widgetFulfill = devtools.calls.find(
      ({ method, params }) =>
        method === 'Fetch.fulfillRequest' && params.requestId === 'widget-1',
    );
    const widgetHtml = Buffer.from(
      widgetFulfill.params.body,
      'base64',
    ).toString('utf8');
    expect(widgetHtml).toContain('Widget fixture loaded');
    expect(widgetHtml).toContain('m.always_on_screen');
    expect(widgetHtml).toContain('org.matrix.msc2762.timeline:*');
    expect(widgetHtml).toContain('setTimeout(reply, 1500)');
    expect(widgetHtml).toContain('trinity-widget-capability-release');
    expect(widgetHtml).toContain("['camera', 'microphone', 'geolocation'");
    expect(devtools.calls).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: 'unrelated' },
    });

    await fixture.close();
    expect(devtools.calls.at(-1)).toEqual({
      method: 'Fetch.disable',
      params: {},
    });
  });

  it('implements four native stages through every contract identity', async () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'room-widget-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('room-widget-contract.mts');
    expect(journey).toContain('room-widget-fixture.mts');
    for (const stage of ['mobile', 'bridge', 'management', 'authority']) {
      expect(journey).toContain(`ROOM_WIDGET_SOURCES.${stage}`);
    }
    expect(journey.match(/profile: PIXEL_5_ACCOUNT_PROFILE/g)).toHaveLength(1);
    expect(journey.match(/profile: DESKTOP_ACCOUNT_PROFILE/g)).toHaveLength(3);
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?4,[\s\S]*?Exactly four Room widget stages are required/,
    );
    expect(journey).toContain("process.env['TRINITY_E2E_ROOM_WIDGET_STAGE']");
    expect(journey).toContain('for (const entry of selectedCases)');

    const contract = await import(contractPath);
    for (const identity of Object.values(contract.roomWidgetAssertions)) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of Object.keys(contract.roomWidgetAssertions)) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }

    expect(journey).toContain('client.tapCurrent(');
    expect(journey).toContain('client.fill(');
    expect(journey).toContain("client.key('enter')");
    expect(journey).toContain('client.scrollIntoViewIfNeeded(');
    expect(journey).toMatch(
      /const trialOpen\s*=\s*`\[data-testid="room-widget-open-board-\$\{widgetCount - 1\}"\]`;[\s\S]{0,240}?client\.scrollIntoViewIfNeeded\([\s\S]{0,120}?trialOpen,[\s\S]{0,120}?'\.room-settings__section-scroll',[\s\S]{0,240}?assertions\.mobileNoEagerRequestBeforeEmbed,[\s\S]{0,120}?trialOpen/,
    );
    expect(journey).toContain('installFirstMatrixHttpFailure(');
    expect(journey).toContain('invokeAccountContinuityHandlers(');
    expect(journey).toContain('runBridgeAdversary(');
    expect(journey).toContain('holdCapabilities: true');
    expect(journey).toContain('trinity-widget-capability-release');
    expect(journey.match(/\.click\(\)/g)).toHaveLength(2);
    expect(journey.match(/\.focus\s*\(/g) ?? []).toHaveLength(0);
    expect(journey.match(/\.dispatchEvent\s*\(/g) ?? []).toHaveLength(0);
    expect(
      journey.match(/\.(?:requestSubmit|submit)\s*\(/g) ?? [],
    ).toHaveLength(0);
    expect(journey).not.toMatch(
      /client\.(?:focusFixture|navigate|reload)\s*\(/,
    );
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
  });

  it('pins adversarial, authority, fault, continuity and cleanup boundaries', () => {
    const fixture = readFileSync(fixturePath, 'utf8');
    const fault = readFileSync(faultPath, 'utf8');
    const journey = readIfPresent(journeyPath);

    expect(fixture).toContain("urlPattern: 'https://widgets.example/*'");
    expect(fixture).toContain(
      "urlPattern: 'https://attacker.example/origin-change'",
    );
    expect(fixture).toContain(
      "paused.url.href === 'https://attacker.example/origin-change'",
    );
    expect(fixture).toContain(
      "const requested = ['m.always_on_screen', 'org.matrix.msc2762.timeline:*']",
    );
    expect(journey).toContain("'https://widgets.example/attacker'");
    expect(journey).toContain("'https://attacker.example/origin-change'");
    expect(journey).toContain("value === '[]'");
    for (const feature of [
      'camera',
      'microphone',
      'geolocation',
      'display-capture',
      'clipboard-read',
      'fullscreen',
    ]) {
      expect(journey).toContain(`['${feature}', false]`);
    }

    expect(fault).toContain('readonly firstResponseGate?: Promise<void>');
    expect(journey).toMatch(
      /installFirstMatrixHttpFailure\([\s\S]{0,500}?kind: 'room-state',[\s\S]{0,180}?roomId: room\.id,[\s\S]{0,180}?eventType: 'im\.vector\.modular\.widgets',[\s\S]{0,120}?stateKey: '\*',[\s\S]{0,120}?status: 500,[\s\S]{0,120}?responseError: 'retry me',[\s\S]{0,120}?firstResponseGate/,
    );
    expect(journey).toContain("'first exact widget state write is held'");
    expect(journey).toContain(
      'value !== undefined && Object.keys(value).length === 0',
    );

    expect(journey).toMatch(
      /assertions\.managementOpeningAccount,[\s\S]{0,240}?includes\(owner\.username\)/,
    );
    expect(journey).toMatch(
      /assertions\.managementMemberAccountActive,[\s\S]{0,240}?includes\(member\.userId\)/,
    );
    expect(journey).toMatch(
      /assertions\.managementOpeningAccountRetained,[\s\S]{0,240}?includes\(owner\.username\)/,
    );

    expect(journey).toMatch(
      /setRoomPower\(owner, room\.id, member\.userId, 50\)[\s\S]{0,650}?authorityGrantedCreateVisible[\s\S]{0,450}?authorityGrantedRemoveVisible/,
    );
    expect(journey).toMatch(
      /setRoomPower\(owner, room\.id, member\.userId, 0\)[\s\S]{0,650}?authorityRevokedCreateAbsent[\s\S]{0,450}?authorityRevokedRemoveAbsent/,
    );

    for (const cleanup of [
      'Restricted widget bridge fixture',
      'Widget management instrumentation',
      'Widget authority request probe',
      'Redact Room widget diagnostics',
      'Room widget Android device',
      'Room widget Android WebView',
    ]) {
      expect(journey).toContain(cleanup);
    }
    expect(journey.match(/await cleanup\(\)/g)).toHaveLength(4);
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
  });

  it('registers one serialized shard-6 suite with started-only diagnostics', () => {
    const project = readFileSync(
      resolve(root, 'e2e/android/project.json'),
      'utf8',
    );
    const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
    const runners = readFileSync(
      resolve(root, 'e2e/registry/suites/runners.mts'),
      'utf8',
    );
    const commands = readFileSync(
      resolve(root, 'e2e/registry/commands.mts'),
      'utf8',
    );
    const workflow = readFileSync(
      resolve(root, '.github/workflows/ci.yml'),
      'utf8',
    );

    expect(project).toContain('"room-widget-settings": {');
    expect(project).toContain('--suite=android.room-widget-settings');
    expect(project).toContain(
      '--entrypoint=e2e/android/room-widget-journeys.mts',
    );
    expect(project).toContain('--resource=android-avd --resource=synapse');
    expect(packageJson).toContain('"e2e:android:room-widget-settings"');
    expect(runners).toContain("id: 'android.room-widget-settings'");
    expect(runners).toContain("serializationKeys: ['android-avd', 'synapse']");
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/room-widget-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:room-widget-settings'");
    expect(commands).toContain("suiteIds: ['android.room-widget-settings']");
    expect(workflow).toContain(
      'if [ "${{ matrix.shard }}" = "6" ]; then echo \'room-widget-settings-started=true\'',
    );
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:room-widget-settings',
    );
    expect(workflow).toContain(
      "steps.android.outputs.room-widget-settings-started == 'true'",
    );
    expect(workflow).toContain('surface: android-room-widget-settings');
    expect(workflow).toContain(
      'dist/.playwright/trinity-e2e-android/*/android.room-widget-settings/**',
    );
  });

  it('documents parity, boundaries, invocation and predecessor retention', () => {
    const migration = readFileSync(
      resolve(root, 'e2e/android/MIGRATION.md'),
      'utf8',
    );
    expect(migration).toContain('## Room widget journeys');
    expect(migration).toMatch(/86 direct plus seven\s+inherited/);
    expect(migration).toContain('93 unique identities');
    expect(migration).toContain(
      'pnpm nx run trinity-e2e-android:room-widget-settings --skipNxCache',
    );
    expect(migration).toMatch(/All four\s+predecessors/);
    expect(migration).toContain('does not authorize predecessor retirement');
    expect(migration).toContain('does not authorize');
    expect(migration).toContain('merging PR #677');
  });
});
