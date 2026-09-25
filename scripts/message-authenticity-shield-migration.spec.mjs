import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/trust/message-shield.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(
  root,
  'e2e/android/message-authenticity-shield-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/message-authenticity-shield-journeys.mts',
);
const composeFlowPath = resolve(
  root,
  'e2e/android/flows/message-authenticity-compose.yaml',
);

const plaintextAssertionIds = [
  'message-authenticity.plaintext.message-visible',
  'message-authenticity.plaintext.shield-absent',
];
const shieldAssertionIds = [
  'message-authenticity.shield.room-created',
  'message-authenticity.shield.secondary-message-visible',
  'message-authenticity.shield.primary-message-visible',
  'message-authenticity.shield.visible',
  'message-authenticity.shield.event-id-nonempty',
  'message-authenticity.shield.receipt-response-ok',
  'message-authenticity.shield.receipt-visible',
  'message-authenticity.shield.receipt-reader-label',
  'message-authenticity.shield.native-title-absent',
  'message-authenticity.shield.focusable-tabindex',
  'message-authenticity.shield.tooltip-visible',
  'message-authenticity.shield.tooltip-reason-nonempty',
  'message-authenticity.shield.tooltip-detail-nonempty',
  'message-authenticity.shield.aria-described',
  'message-authenticity.shield.copy-does-not-overstate',
  'message-authenticity.geometry.observation-complete',
  'message-authenticity.geometry.shield-body-child',
  'message-authenticity.geometry.receipt-body-child',
  'message-authenticity.geometry.shield-trailing-edge',
  'message-authenticity.geometry.receipt-trailing-edge',
  'message-authenticity.geometry.content-shield-nonoverlap',
  'message-authenticity.geometry.receipt-content-nonoverlap',
  'message-authenticity.geometry.receipt-shield-nonoverlap',
  'message-authenticity.geometry.receipt-within-row',
];
const geometryAssertionIds = shieldAssertionIds.slice(-9);
const assertionIds = [...plaintextAssertionIds, ...shieldAssertionIds];

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

const assertionSiteCount = (lines) =>
  lines.filter(
    (line) =>
      !line.trimStart().startsWith('//') &&
      /\bexpect(?:\.poll)?(?:\(|\s*$)/u.test(line),
  ).length;

function assertProtectedRuntimeContract(journey) {
  const required = [
    "const PRIMARY_APPLICATION_ID = 'eu.qwky.trinity'",
    "const SECONDARY_APPLICATION_ID = 'eu.qwky.trinity.secondary'",
    'createAccountFixtures(',
    'assert.equal(plaintextShields.length, 0)',
    "type: 'm.room.encryption'",
    "algorithm: 'm.megolm.v1.aes-sha2'",
    'establishRecovery(',
    'await primary.login(account)',
    'await secondary.login(account)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('textarea.composer__input')",
    "'e2e/android/flows/message-authenticity-compose.yaml'",
    'assert(body.length <= 160',
    'assert.equal(composerValue, body)',
    'await secondary.tapCurrent(\'[data-testid="composer-send"]\')',
    'fixtures.sendReadReceipt(',
    'seer, room.id, shield.eventId',
    "await client.key('tab')",
    '\'[data-testid^="msg-shield-"]\'',
    '\'[data-testid="read-receipts"]\'',
    '\'[data-testid="msg-shield-tip"]\'',
    'assert.equal(shield.title, null)',
    "assert.equal(shield.tabindex, '0')",
    "'.msg__shield-tip-reason'",
    "'.msg__shield-tip-detail'",
    'observation.tooltipReason.length > 0',
    'observation.tooltipDetail.length > 0',
    'Boolean(observation.describedBy)',
    '/intercept|read by|eavesdrop|compromised|leaked/i',
    "for (const direction of ['ltr', 'rtl'] as const)",
    'document.documentElement.dir = direction',
    'Math.abs(geometry.shieldTrailingGap) <= 1',
    "document.documentElement.removeAttribute('dir')",
    'expectedStages: 2',
    'expectedUniqueAssertions: 26',
    'expectedAssertionRecords: 35',
    'new Set<MessageAuthenticityShieldAssertion>()',
    'assert(!records.has(recordKey)',
    'redactMaestroArtifacts(output, secrets)',
    'scanMessageAuthenticityShieldArtifacts(output, secrets)',
    'await primary.close()',
    'await secondary.close()',
    'await device.clearApplicationData(applicationId)',
    'device.close()',
    'throw new AggregateError(',
  ];
  for (const fragment of required) expect(journey).toContain(fragment);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /observation:\s*(?:accessToken|password|recoveryKey|eventSecret)/u,
  );
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|navigate|reload)\s*\(|evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toMatch(/mock(?:Shield|Receipt|CrossSigning|Device)/u);
}

describe('Android message-authenticity shield migration', () => {
  it('pins the exact predecessor/helper sources and direct assertion shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '2ab9ceaa07b78d77aea844127b26ba16c7d9475322a7430a8f422186bafa9c9c',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[22]).toContain('/**');
    expect(predecessor[27]).toContain('async function setUpEncryption');
    expect(predecessor[58]).toContain('/** Open a joined');
    expect(predecessor[59]).toContain('async function openRoom');
    expect(predecessor[73]).toContain(
      "test('a message in a plaintext room shows no shield'",
    );
    expect(predecessor[137]).toBe('  });');
    expect(predecessor[139]).toContain(
      "test('a shielded message explains itself in a tooltip'",
    );
    expect(predecessor[317]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(73, 138))).toBe(2);
    expect(assertionSiteCount(predecessor.slice(139, 318))).toBe(24);

    const shielded = predecessor.slice(139, 318).join('\n');
    expect(shielded).toContain('const deviceB = await secondaryApp.launch()');
    expect(shielded).toContain('await setUpEncryption(page, pass)');
    expect(shielded).toContain('/receipt/m.read/');
    expect(shielded).toContain('await shield.focus()');
    expect(shielded).toContain("for (const direction of ['ltr', 'rtl']");
    expect(app.join('\n')).toContain('export async function login(');
    expect(app.join('\n')).toContain('export async function waitForRooms(');
    expect(account.join('\n')).toContain('export async function registerUser(');
    expect(account.join('\n')).toContain(
      'export async function passwordLogin(',
    );
  });

  it('exports exactly 26 unique and 35 stage-local assertion records', async () => {
    expect(
      contractPath,
      'message-authenticity-shield-contract.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.MESSAGE_AUTHENTICITY_SHIELD_SOURCES).toEqual({
      helpers: `${predecessorSource}:23-69`,
      plaintext: `${predecessorSource}:74-138`,
      shielded: `${predecessorSource}:140-318`,
      app: appSource,
      account: accountSource,
    });
    expect(
      Object.values(contract.messageAuthenticityShieldAssertions.plaintext),
    ).toEqual(plaintextAssertionIds);
    expect(
      Object.values(contract.messageAuthenticityShieldAssertions.shield),
    ).toEqual(shieldAssertionIds);
    expect(new Set(assertionIds).size).toBe(26);
    expect(contract.MESSAGE_AUTHENTICITY_SHIELD_ASSERTION_RECORDS).toBe(35);
    expect(2 + shieldAssertionIds.length + geometryAssertionIds.length).toBe(
      35,
    );
  });

  it('implements two real native stages and observation-only renderer checks', () => {
    const journey = readIfPresent(journeyPath);
    const composeFlow = readIfPresent(composeFlowPath);
    expect(
      journey,
      'message-authenticity-shield-journeys.mts must exist',
    ).not.toBe('');
    assertProtectedRuntimeContract(journey);
    expect(
      composeFlow,
      'message-authenticity-compose.yaml must exist',
    ).not.toBe('');
    expect(composeFlow).toContain('- eraseText');
    expect(composeFlow).toContain('- setClipboard: ${MESSAGE}');
    expect(composeFlow).toContain('- pasteText');
    // An unconditional Maestro hideKeyboard is a Back press that can leave the
    // Room; the journey uses the device-state-guarded client dismissal instead.
    expect(composeFlow).not.toContain('- hideKeyboard');
    expect(journey).toContain('await client.hideKeyboard();');
    expect(composeFlow).not.toContain('tapOn:');
    expect(journey).toContain("id: 'plaintext-no-shield'");
    expect(journey).toContain("id: 'unsigned-device-shield'");
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain('invite: [reader.userId]');
    expect(journey).toContain('await fixtures.join(reader, room.id)');
    expect(journey).toContain('await fixtures.sendMessage(');
    expect(journey).toContain('assert.equal(plaintextShields.length, 0)');
    expect(journey).toContain('assert.equal(shield.title, null)');
    expect(journey).toContain("assert.equal(shield.tabindex, '0')");
    expect(journey).toContain(
      'assert(receipt.receiptAriaLabel.includes(seerName))',
    );
    expect(journey).toContain('Math.abs(geometry.shieldTrailingGap) <= 1');
    expect(journey).toContain('{ complete: true, geometry }');
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('rejects false shields, fabricated receipts, focus shortcuts and cleanup loss', () => {
    const journey = readIfPresent(journeyPath);
    expect(() => assertProtectedRuntimeContract(journey)).not.toThrow();
    const mutations = [
      [
        'assert.equal(plaintextShields.length, 0)',
        'assert(plaintextShields.length >= 0)',
      ],
      ["type: 'm.room.encryption'", "type: 'm.room.name'"],
      ['fixtures.sendReadReceipt(', 'fixtures.mockReadReceipt('],
      [
        'seer, room.id, shield.eventId',
        'seer, room.id, `${shield.eventId}-different`',
      ],
      [
        "await client.key('tab')",
        'await client.focusFixture(\'[data-testid^="msg-shield-"]\')',
      ],
      [
        "'e2e/android/flows/message-authenticity-compose.yaml'",
        "'e2e/android/flows/critical-compose.yaml'",
      ],
      [
        'assert.equal(shield.title, null)',
        'assert.equal(shield.title, shield.title)',
      ],
      [
        "assert.equal(shield.tabindex, '0')",
        'assert.equal(shield.tabindex, shield.tabindex)',
      ],
      [
        'observation.tooltipReason.length > 0',
        'observation.tooltipReason.length >= 0',
      ],
      [
        'observation.tooltipDetail.length > 0',
        'observation.tooltipDetail.length >= 0',
      ],
      ['Boolean(observation.describedBy)', 'true'],
      ['/intercept|read by|eavesdrop|compromised|leaked/i', '/^$/u'],
      [
        "for (const direction of ['ltr', 'rtl'] as const)",
        "for (const direction of ['ltr'] as const)",
      ],
      [
        'Math.abs(geometry.shieldTrailingGap) <= 1',
        'Math.abs(geometry.shieldTrailingGap) < Infinity',
      ],
      ["document.documentElement.removeAttribute('dir')", 'Promise.resolve()'],
      ['redactMaestroArtifacts(output, secrets)', 'Promise.resolve()'],
      [
        'scanMessageAuthenticityShieldArtifacts(output, secrets)',
        'Promise.resolve()',
      ],
      ['await primary.close()', 'await Promise.resolve()'],
      ['await secondary.close()', 'await Promise.resolve()'],
      [
        'await device.clearApplicationData(applicationId)',
        'await Promise.resolve(applicationId)',
      ],
      ['device.close()', 'Promise.resolve()'],
    ];
    for (const [before, after] of mutations) {
      expect(journey).toContain(before);
      expect(
        () => assertProtectedRuntimeContract(journey.replace(before, after)),
        before,
      ).toThrow();
    }
  });

  it('registers one bounded uncached suite with started-only diagnostics', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['message-authenticity-shield'];
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
      '--suite=android.message-authenticity-shield',
    );
    expect(target.options.command).toContain('--timeout-ms=1800000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/message-authenticity-shield-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:message-authenticity-shield']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:message-authenticity-shield',
    );

    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.message-authenticity-shield'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:message-authenticity-shield'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:message-authenticity-shield'",
    );
    expect(runners).toContain("'maestro'");
    expect(commands).toContain(
      "name: 'e2e:android:message-authenticity-shield'",
    );
    expect(commands).toContain(
      "suiteIds: ['android.message-authenticity-shield']",
    );
    expect(workflow).toContain('message-authenticity-shield-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:message-authenticity-shield',
    );
    expect(workflow).toContain('surface: android-message-authenticity-shield');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.message-authenticity-shield/**',
    );
  });

  it('documents parity and retains both exact predecessors', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Message-authenticity shield journeys');
    expect(migration).toContain('`android.message-authenticity-shield`');
    expect(migration).toContain(
      '2ab9ceaa07b78d77aea844127b26ba16c7d9475322a7430a8f422186bafa9c9c',
    );
    expect(migration).toContain('26 unique direct assertion identities');
    expect(migration).toMatch(/35 stage-local direct assertion\s+records/u);
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain("path: 'journeys/trust/message-shield.spec.mts'");
    expect(read(predecessorSource)).toContain(
      "test('a message in a plaintext room shows no shield'",
    );
    expect(read(predecessorSource)).toContain(
      "test('a shielded message explains itself in a tooltip'",
    );
  });
});
