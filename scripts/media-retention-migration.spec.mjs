import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/media-retention.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(root, 'e2e/android/media-retention-contract.mts');
const fixturePath = resolve(root, 'e2e/android/media-retention-fixture.mts');
const journeyPath = resolve(root, 'e2e/android/media-retention-journeys.mts');

const visits = ['initial', 'round-1', 'round-2'];
const attachments = ['plain', 'encrypted'];
const roomAssertionIds = [
  'media-retention.initial.room-a-ready',
  'media-retention.round-1.room-b-ready',
  'media-retention.round-1.room-a-ready',
  'media-retention.round-2.room-b-ready',
  'media-retention.round-2.room-a-ready',
];
const readyAssertionIds = visits.flatMap((visit) =>
  attachments.flatMap((attachment) => [
    `media-retention.${visit}.${attachment}.bubble-ready`,
    `media-retention.${visit}.${attachment}.image-complete`,
    `media-retention.${visit}.${attachment}.natural-width-positive`,
  ]),
);
const lightboxAssertionIds = visits.flatMap((visit) =>
  attachments.flatMap((attachment) => [
    `media-retention.${visit}.${attachment}.dialog-visible`,
    `media-retention.${visit}.${attachment}.lightbox-image-complete`,
    `media-retention.${visit}.${attachment}.lightbox-natural-width-positive`,
    `media-retention.${visit}.${attachment}.dialog-hidden`,
  ]),
);
const assertionIds = [
  ...roomAssertionIds,
  ...readyAssertionIds,
  ...lightboxAssertionIds,
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

function expectFragments(source, fragments) {
  for (const fragment of fragments) expect(source).toContain(fragment);
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
  expect(expressions.length).toBeGreaterThan(0);
  for (const expression of expressions) {
    expect(expression).not.toMatch(
      /\.(?:click|focus|fill|submit|requestSubmit|scrollBy|scrollTo)\s*\(/u,
    );
    expect(expression).not.toMatch(
      /dispatchEvent\(|removeAttribute\(|setAttribute\(|\.value\s*=|\.scrollTop\s*=|\.scrollLeft\s*=|location\s*=|history\./u,
    );
  }
}

function assertRuntimeContract({ contract, fixture, journey }) {
  expectFragments(contract, [
    'MEDIA_RETENTION_ASSERTION_RECORDS = 47',
    'MEDIA_RETENTION_ROOM_ASSERTIONS = 5',
    'MEDIA_RETENTION_READY_ASSERTIONS = 18',
    'MEDIA_RETENTION_LIGHTBOX_ASSERTIONS = 24',
    "MEDIA_RETENTION_PLAIN_FILENAME = 'retained-plain.png'",
    "MEDIA_RETENTION_ENCRYPTED_FILENAME = 'retained-encrypted.png'",
    'MEDIA_RETENTION_PNG_BASE64',
  ]);
  for (const identity of assertionIds) expect(contract).toContain(identity);

  expectFragments(fixture, [
    'export async function openMediaRetentionFixture(',
    'createNodeAccount(',
    "preset: 'private_chat'",
    'MEDIA_RETENTION_PNG_BASE64',
    "Buffer.from(MEDIA_RETENTION_PNG_BASE64, 'base64')",
    "'image/png'",
    "'application/octet-stream'",
    "name: 'AES-CTR'",
    'length: 256',
    'crypto.getRandomValues(iv.subarray(0, 8))',
    'iv.subarray(8).every((byte) => byte === 0)',
    'crypto.subtle.generateKey(',
    'crypto.subtle.exportKey(',
    'crypto.subtle.encrypt(',
    "crypto.subtle.digest('SHA-256', ciphertext)",
    "v: 'v2'",
    'key: exportedKey',
    'iv: encodeUnpaddedBase64(iv)',
    'hashes: { sha256: encodeUnpaddedBase64(ciphertextHash) }',
    'plainContentUri !== encryptedContentUri',
    'plainEventId !== encryptedEventId',
    "msgtype: 'm.image'",
    'body: MEDIA_RETENTION_PLAIN_FILENAME',
    'body: MEDIA_RETENTION_ENCRYPTED_FILENAME',
    'plaintextEventReady: true',
    'encryptedEventReady: true',
    'distinctContentUris: true',
    'distinctEventIds: true',
    'encryptedBytesDiffer: true',
    'close(): Promise<void>',
    'plaintext.fill(0)',
    'ciphertext.fill(0)',
    'iv.fill(0)',
  ]);
  expect(fixture).toMatch(
    /await upload\(\s*MEDIA_RETENTION_PLAIN_FILENAME,\s*plaintext,\s*'image\/png',\s*\)/u,
  );
  expect(fixture).toMatch(
    /await upload\(\s*MEDIA_RETENTION_ENCRYPTED_FILENAME,\s*ciphertext,\s*'application\/octet-stream',\s*\)/u,
  );
  expect(fixture).toMatch(
    /crypto\.subtle\.generateKey\(\s*\{ name: 'AES-CTR', length: 256 \}/u,
  );
  expect(fixture).toMatch(
    /crypto\.subtle\.encrypt\(\s*\{ name: 'AES-CTR', counter: iv, length: 64 \}/u,
  );
  expect(fixture).not.toMatch(
    /return\s+\{[^}]*\b(?:token|key|iv|hash|ciphertext|contentUri)\b/su,
  );

  expectFragments(journey, [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "id: 'media-retention'",
    'await openMediaRetentionFixture(',
    'await client.login(fixture.account)',
    'await openRoom(',
    'await observeReadyImage(',
    'await openAndCloseLightbox(',
    'for (const round of [1, 2] as const)',
    'const backToRooms = await client.elements(\'[data-testid="back-to-rooms"]\')',
    'await client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: roomName })",
    'await client.tapCurrent(openButtonSelector)',
    "await client.scrollIntoViewIfNeeded(openButtonSelector, '.scroll')",
    'await client.tapCurrent(\'[data-testid="lightbox-close"]\')',
    'data-testid="media-bubble"',
    'data-media-state',
    "=== 'ready'",
    'image.complete === true',
    'image.naturalWidth > 0',
    'role="dialog"',
    "dialog.getAttribute('aria-label') === filename",
    'eventId',
    'expectedStages: 1',
    'expectedUniqueAssertions: 47',
    'expectedAssertionRecords: 47',
    'attempt: 1',
    'retries: 0',
    'redactMaestroArtifacts(output, secrets, true)',
    'scanMediaRetentionArtifacts(output, secrets)',
    'await closeOpenLightbox(client)',
    'await client.close()',
    'await fixture.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
    '(?:Bearer|Basic)',
    'syt_[A-Za-z0-9._~-]+',
    'blob:',
    'mxc://',
  ]);

  expect(journey.match(/await openRoom\(/gu)).toHaveLength(3);
  expect(journey.match(/await observeReadyImage\(/gu)).toHaveLength(2);
  expect(journey.match(/await openAndCloseLightbox\(/gu)).toHaveLength(2);
  expect(journey.match(/image\.complete === true/gu)).toHaveLength(2);
  expect(journey.match(/image\.naturalWidth > 0/gu)).toHaveLength(2);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|focusCurrent|fill|replace|navigate|reload)\s*\(/u,
  );
  expect(journey).not.toMatch(
    /mouse\.|dispatchEvent\(|\.click\(\)|\.focus\(\)|\.value\s*=/u,
  );
  expect(journey.indexOf('await closeOpenLightbox(client)')).toBeLessThan(
    journey.indexOf('await client.close()'),
  );
  expect(journey.indexOf('await client.close()')).toBeLessThan(
    journey.indexOf('await fixture.close()'),
  );
  expect(journey.indexOf('await fixture.close()')).toBeLessThan(
    journey.indexOf('await device.clearApplicationData(APPLICATION_ID)'),
  );
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

function assertWiring({
  project,
  packageJson,
  runners,
  commands,
  workflow,
  docs,
}) {
  expectFragments(project, [
    '"media-retention": {',
    '--suite=android.media-retention',
    '--entrypoint=e2e/android/media-retention-journeys.mts',
    '--timeout-ms=1200000',
    '--resource=android-avd',
    '--resource=synapse',
  ]);
  expectFragments(packageJson, [
    '"e2e:android:media-retention"',
    'trinity-e2e-android:media-retention',
  ]);
  expectFragments(runners, [
    "'android.media-retention'",
    "'e2e/android/media-retention-journeys.mts'",
    "'e2e/android/media-retention-contract.mts'",
    "'e2e/android/media-retention-fixture.mts'",
  ]);
  expectFragments(commands, [
    "'android.media-retention'",
    "name: 'e2e:android:media-retention'",
    "command: 'nx run trinity-e2e-android:media-retention'",
  ]);
  expectFragments(workflow, [
    'media-retention-started=true',
    'trinity-e2e-android:media-retention',
    'surface: android-media-retention',
    'android.media-retention/**',
  ]);
  expect(workflow.indexOf('trinity-e2e-android:location-share')).toBeLessThan(
    workflow.indexOf('trinity-e2e-android:media-retention'),
  );
  expectFragments(docs, [
    '## Media retention journey',
    '`android.media-retention`',
    '47',
    'retained-plain.png',
    'retained-encrypted.png',
  ]);
}

function mutated(source, from, to) {
  const result = source.replace(from, to);
  expect(result, `mutation must replace ${String(from)}`).not.toBe(source);
  return result;
}

describe('Android media-retention migration', () => {
  it('pins the complete predecessor and its exact 47-record expansion', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '8de218b97b33dbd0513e9b93d21812120d3afa0ecc10e37e530fe265f6f18fc6',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    const fixtureHelpers = predecessor.slice(15, 167).join('\n');
    const interactionHelpers = predecessor.slice(168, 221).join('\n');
    const definition = predecessor.slice(225, 257).join('\n');
    expect(fixtureHelpers).toContain(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    );
    expect(fixtureHelpers).toContain("{ name: 'AES-CTR', length: 256 }");
    expect(fixtureHelpers).toContain(
      "{ name: 'AES-CTR', counter: iv, length: 64 }",
    );
    expect(fixtureHelpers).toContain("digest('SHA-256', data)");
    expect(fixtureHelpers).toContain("v: 'v2'");
    expect(fixtureHelpers).toContain('for (const name of [roomA, roomB])');
    expect(fixtureHelpers).toContain(
      "await sendImage('retained-plain.png', false)",
    );
    expect(fixtureHelpers).toContain(
      "await sendImage('retained-encrypted.png', true)",
    );
    expect(interactionHelpers).toContain('async function openRoom(');
    expect(interactionHelpers).toContain('async function expectReadyImage(');
    expect(interactionHelpers).toContain(
      'async function openAndCloseLightbox(',
    );
    expect(interactionHelpers.match(/await expect/gu)).toHaveLength(8);
    expect(definition.match(/await openRoom\(/gu)).toHaveLength(3);
    expect(definition.match(/await expectReadyImage\(/gu)).toHaveLength(4);
    expect(definition.match(/await openAndCloseLightbox\(/gu)).toHaveLength(4);
    expect(definition).toContain('for (let round = 0; round < 2; round += 1)');
    expect(app.join('\n')).toContain('export async function login(');
    expect(account.join('\n')).toContain('export async function registerUser(');
    expect(roomAssertionIds).toHaveLength(5);
    expect(readyAssertionIds).toHaveLength(18);
    expect(lightboxAssertionIds).toHaveLength(24);
    expect(assertionIds).toHaveLength(47);
    expect(new Set(assertionIds).size).toBe(47);
  });

  it('exports exact unique identities, sources, filenames and PNG bytes', async () => {
    expect(contractPath, 'media-retention-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.MEDIA_RETENTION_SOURCES).toEqual({
      fixture: `${predecessorSource}:16-167`,
      helpers: `${predecessorSource}:169-221`,
      definition: `${predecessorSource}:226-257`,
      app: appSource,
      account: accountSource,
    });
    expect(contract.mediaRetentionAssertions).toEqual(assertionIds);
    expect(new Set(contract.mediaRetentionAssertions).size).toBe(47);
    expect(contract.MEDIA_RETENTION_ASSERTION_RECORDS).toBe(47);
    expect(contract.MEDIA_RETENTION_ROOM_ASSERTIONS).toBe(5);
    expect(contract.MEDIA_RETENTION_READY_ASSERTIONS).toBe(18);
    expect(contract.MEDIA_RETENTION_LIGHTBOX_ASSERTIONS).toBe(24);
    expect(contract.MEDIA_RETENTION_PLAIN_FILENAME).toBe('retained-plain.png');
    expect(contract.MEDIA_RETENTION_ENCRYPTED_FILENAME).toBe(
      'retained-encrypted.png',
    );
    expect(contract.MEDIA_RETENTION_PNG_BASE64).toBe(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    );
  });

  it('requires distinct plaintext/encrypted media and native retention proofs', () => {
    for (const path of [fixturePath, journeyPath]) {
      expect(path, `${path} must exist`).toSatisfy(existsSync);
    }
    if (!existsSync(fixturePath) || !existsSync(journeyPath)) return;
    assertRuntimeContract({
      contract: readFileSync(contractPath, 'utf8'),
      fixture: readFileSync(fixturePath, 'utf8'),
      journey: readFileSync(journeyPath, 'utf8'),
    });
  });

  it('keeps effective mutation controls for encryption, retention and ownership', () => {
    if (
      !existsSync(contractPath) ||
      !existsSync(fixturePath) ||
      !existsSync(journeyPath)
    )
      return;
    const sources = {
      contract: readFileSync(contractPath, 'utf8'),
      fixture: readFileSync(fixturePath, 'utf8'),
      journey: readFileSync(journeyPath, 'utf8'),
    };
    const mutations = [
      {
        fixture: mutated(
          sources.fixture,
          `    MEDIA_RETENTION_PLAIN_FILENAME,
    plaintext,
    'image/png',
  );`,
          `    MEDIA_RETENTION_PLAIN_FILENAME,
    plaintext,
    'text/plain',
  );`,
        ),
      },
      {
        fixture: mutated(
          sources.fixture,
          `    MEDIA_RETENTION_ENCRYPTED_FILENAME,
    ciphertext,
    'application/octet-stream',
  );`,
          `    MEDIA_RETENTION_ENCRYPTED_FILENAME,
    ciphertext,
    'image/png',
  );`,
        ),
      },
      {
        fixture: mutated(sources.fixture, "name: 'AES-CTR'", "name: 'AES-GCM'"),
      },
      { fixture: mutated(sources.fixture, 'length: 256', 'length: 128') },
      {
        fixture: mutated(
          sources.fixture,
          'crypto.getRandomValues(iv.subarray(0, 8))',
          'void iv',
        ),
      },
      {
        fixture: mutated(
          sources.fixture,
          "crypto.subtle.digest('SHA-256', ciphertext)",
          "crypto.subtle.digest('SHA-256', plaintext)",
        ),
      },
      {
        fixture: mutated(
          sources.fixture,
          'plainContentUri !== encryptedContentUri',
          'plainContentUri === encryptedContentUri',
        ),
      },
      {
        fixture: mutated(
          sources.fixture,
          'plainEventId !== encryptedEventId',
          'plainEventId === encryptedEventId',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'expectedUniqueAssertions: 47',
          'expectedUniqueAssertions: 46',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'for (const round of [1, 2] as const)',
          'for (const round of [1] as const)',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'await client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
          'void roomName',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'await client.tapCurrent(openButtonSelector)',
          'await evaluateNative(client.webview, `${openButtonSelector}.click()`)',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          "await client.scrollIntoViewIfNeeded(openButtonSelector, '.scroll')",
          'void openButtonSelector',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'image.complete === true',
          'Boolean(image)',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'image.naturalWidth > 0',
          'image.naturalWidth >= 0',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          "dialog.getAttribute('aria-label') === filename",
          'Boolean(dialog)',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'await client.tapCurrent(\'[data-testid="lightbox-close"]\')',
          'void dialogSelector',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'await fixture.close()',
          'void fixture',
        ),
      },
      {
        journey: mutated(
          sources.journey,
          'redactMaestroArtifacts(output, secrets, true)',
          'void secrets',
        ),
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      expect(
        () => assertRuntimeContract({ ...sources, ...mutation }),
        `mutation ${index + 1} must be rejected`,
      ).toThrow();
    }
  });

  it('requires serialized Nx, registry, CI diagnostics and migration-ledger wiring', () => {
    assertWiring({
      project: read('e2e/android/project.json'),
      packageJson: read('package.json'),
      runners: read('e2e/registry/suites/runners.mts'),
      commands: read('e2e/registry/commands.mts'),
      workflow: read('.github/workflows/ci.yml'),
      docs: read('e2e/android/MIGRATION.md'),
    });
  });
});
