import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/composer-drafts.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const clientSource = 'e2e/android/account-workspace-client.mts';
const contractPath = resolve(root, 'e2e/android/composer-drafts-contract.mts');
const preferencePath = resolve(
  root,
  'e2e/android/composer-drafts-preference.mts',
);
const journeyPath = resolve(root, 'e2e/android/composer-drafts-journeys.mts');

const assertionIds = [
  'composer-drafts.room-a-initial-ready',
  'composer-drafts.room-b-ready',
  'composer-drafts.room-a-return-ready',
  'composer-drafts.room-a-relaunch-ready',
  'composer-drafts.room-b-empty',
  'composer-drafts.room-a-restored',
  'composer-drafts.native-preference-persisted',
  'composer-drafts.cold-relaunch-restored',
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

function assertProtectedRuntimeContract(journey, preference, client) {
  const journeyFragments = [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "const DRAFTS_KEY = 'trinity.composer.drafts'",
    "id: 'per-room-draft-persistence'",
    "preset: 'private_chat'",
    'await client.login(account)',
    'await client.elements(\'[data-testid="back-to-rooms"]\')',
    'await client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: roomName })",
    "const draft = `Unsent draft ${resources.roomName('composer-draft')}`",
    'await client.fill(\'[data-testid="composer-input"]\', draft)',
    'secrets.SECRET_COMPOSER_DRAFT = draft',
    'secrets.SECRET_COMPOSER_DRAFT_LOWERCASE',
    'const conversationKey = `conversation:${JSON.stringify([account.userId, roomA.id])}`',
    'await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)',
    'await readNativeComposerDraft(',
    'assertions.roomAInitialReady',
    'assertions.roomBReady',
    'assertions.roomAReturnReady',
    'assertions.roomARelaunchReady',
    'assertions.roomBEmpty',
    'assertions.roomARestored',
    'assertions.nativePreferencePersisted',
    'assertions.coldRelaunchRestored',
    'expectedStages: 1',
    'expectedUniqueAssertions: 8',
    'expectedAssertionRecords: 8',
    'attempt: 1',
    'retries: 0',
    'redactMaestroArtifacts(output, secrets, true)',
    'scanComposerDraftArtifacts(output, secrets)',
    "nativeStorageMethodDataIsRedacted(text, 'Preferences')",
    'Preferences method data is redacted in ${path}',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);
  expect(journey.match(/preset: 'private_chat'/gu)).toHaveLength(2);
  expect(journey.match(/\(value\) => value === draft/gu)).toHaveLength(2);
  expect(journey).toContain("(value) => value === ''");

  const preferenceFragments = [
    "'run-as'",
    "'shared_prefs/CapacitorStorage.xml'",
    'parseNativeComposerDraft',
    'waitForNativeShellState(',
    '(candidate) => candidate === expectedDraft',
  ];
  for (const fragment of preferenceFragments)
    expect(preference).toContain(fragment);

  const relaunch = client.slice(
    client.indexOf('async relaunch('),
    client.indexOf('async elements(', client.indexOf('async relaunch(')),
  );
  expect(relaunch).toContain("'am'");
  expect(relaunch).toContain("'force-stop'");
  expect(relaunch).toContain('startNativeShellClient(');

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|navigate|reload)\s*\(|evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toMatch(/observation:\s*(?:draft|rawPreference)/u);
  expect(preference).not.toMatch(
    /localStorage|evaluateNative|\.Plugins\?\.Preferences/u,
  );
}

describe('Android composer-drafts migration', () => {
  it('pins the exact predecessor/helper sources and parity shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '16088cad5e1ecc4a6933c905b3963b6c46fa5cf5ffe9be82439269b22a0730cd',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[23]).toContain('async function seedTwoRooms');
    expect(predecessor[60]).toContain('async function openRoom');
    expect(predecessor[65]).toContain("getByTestId('composer-input')");
    expect(predecessor[73]).toContain(
      "test('keeps a per-room draft across room switches and a reload'",
    );
    expect(predecessor[107]).toBe('  });');

    const definition = predecessor.slice(73, 108).join('\n');
    expect(definition.match(/await openRoom\(/gu)).toHaveLength(4);
    expect(definition.match(/\bexpect\b/gu)).toHaveLength(4);
    expect(predecessor.join('\n')).toContain(
      "const DRAFTS_KEY = 'trinity.composer.drafts'",
    );
    expect(app.join('\n')).toContain('export async function readPreference(');
    expect(app.join('\n')).toContain('preferences.get({ key: value })');
    expect(account.join('\n')).toContain('export async function registerUser(');
    expect(account.join('\n')).toContain(
      'export async function passwordLogin(',
    );
  });

  it('exports the exact eight assertion identities and source mapping', async () => {
    expect(contractPath, 'composer-drafts-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.COMPOSER_DRAFT_SOURCES).toEqual({
      helpers: `${predecessorSource}:23-69`,
      definition: `${predecessorSource}:74-108`,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.composerDraftAssertions)).toEqual(
      assertionIds,
    );
    expect(new Set(Object.values(contract.composerDraftAssertions)).size).toBe(
      8,
    );
    expect(contract.COMPOSER_DRAFT_ASSERTION_RECORDS).toBe(8);
  });

  it('parses only the exact native Preferences key and decodes XML entities', async () => {
    expect(
      preferencePath,
      'composer-drafts-preference.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(preferencePath)) return;
    const { parseNativeComposerDraft } = await import(preferencePath);
    const conversationKey =
      'conversation:["@reader:localhost","!room:localhost"]';
    const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <string name="other">ignore me</string>
  <string name="trinity.composer.drafts">{&quot;conversation:[\\&quot;@other:localhost\\&quot;,\\&quot;!other:localhost\\&quot;]&quot;:&quot;draft &amp; more &lt;text&gt;&quot;,&quot;conversation:[\\&quot;@reader:localhost\\&quot;,\\&quot;!room:localhost\\&quot;]&quot;:&quot;exact draft&quot;}</string>
</map>`;
    expect(
      parseNativeComposerDraft(xml, 'trinity.composer.drafts', conversationKey),
    ).toBe('exact draft');
    expect(
      parseNativeComposerDraft(
        xml,
        'trinity.composer.drafts',
        'conversation:["@reader:localhost","!other:localhost"]',
      ),
    ).toBeNull();
    expect(
      parseNativeComposerDraft(
        xml,
        'trinity.composer.drafts',
        'conversation:["@other:localhost","!other:localhost"]',
      ),
    ).toBe('draft & more <text>');
    expect(
      parseNativeComposerDraft(xml, 'missing', conversationKey),
    ).toBeNull();
  });

  it('implements one native stage with durable host storage and a real cold relaunch', () => {
    const journey = readIfPresent(journeyPath);
    const preference = readIfPresent(preferencePath);
    const client = read(clientSource);
    expect(journey, 'composer-drafts-journeys.mts must exist').not.toBe('');
    expect(preference, 'composer-drafts-preference.mts must exist').not.toBe(
      '',
    );
    assertProtectedRuntimeContract(journey, preference, client);
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when isolation, persistence, relaunch, redaction or cleanup proof is weakened', () => {
    const journey = readIfPresent(journeyPath);
    const preference = readIfPresent(preferencePath);
    const client = read(clientSource);
    expect(() =>
      assertProtectedRuntimeContract(journey, preference, client),
    ).not.toThrow();
    const journeyMutations = [
      ["preset: 'private_chat'", "preset: 'public_chat'"],
      [
        'await client.fill(\'[data-testid="composer-input"]\', draft)',
        "await client.fill('[data-testid=\"composer-input\"]', '')",
      ],
      [
        'await client.tapCurrent(\'[data-testid="back-to-rooms"]\')',
        'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
      ],
      ["(value) => value === ''", '(value) => value === draft'],
      [
        'const conversationKey = `conversation:${JSON.stringify([account.userId, roomA.id])}`',
        'const conversationKey = `conversation:${JSON.stringify([account.userId, roomB.id])}`',
      ],
      [
        'await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)',
        'await client.reload()',
      ],
      ['await readNativeComposerDraft(', 'await Promise.resolve('],
      [
        'redactMaestroArtifacts(output, secrets, true)',
        'redactMaestroArtifacts(output, secrets, false)',
      ],
      ['redactMaestroArtifacts(output, secrets, true)', 'Promise.resolve()'],
      ['scanComposerDraftArtifacts(output, secrets)', 'Promise.resolve()'],
      [
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
    ];
    for (const [before, after] of journeyMutations) {
      expect(journey).toContain(before);
      expect(
        () =>
          assertProtectedRuntimeContract(
            journey.replace(before, after),
            preference,
            client,
          ),
        `mutation must fail closed: ${before}`,
      ).toThrow();
    }
    expect(() =>
      assertProtectedRuntimeContract(
        journey,
        preference.replace("'run-as'", "'echo'"),
        client,
      ),
    ).toThrow();
    expect(() =>
      assertProtectedRuntimeContract(
        journey,
        preference.replace(
          '(candidate) => candidate === expectedDraft',
          '(candidate) => candidate?.includes(expectedDraft) === true',
        ),
        client,
      ),
    ).toThrow();
  });

  it('registers one uncached serialized suite with started-only diagnostics', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['composer-drafts'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain('--suite=android.composer-drafts');
    expect(target.options.command).toContain('--timeout-ms=1200000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/composer-drafts-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:composer-drafts']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:composer-drafts',
    );

    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.composer-drafts'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:composer-drafts'",
    );
    expect(runners).toContain("canonicalScript: 'e2e:android:composer-drafts'");
    expect(runners).toContain("'maestro'");
    expect(commands).toContain("name: 'e2e:android:composer-drafts'");
    expect(commands).toContain("suiteIds: ['android.composer-drafts']");
    expect(workflow).toContain('composer-drafts-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:composer-drafts',
    );
    expect(workflow).toContain('surface: android-composer-drafts');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.composer-drafts/**',
    );
  });
});
