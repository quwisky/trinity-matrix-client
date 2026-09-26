import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/conversations/gif.spec.mts';
const navigationSource = 'e2e/support/journeys/navigation.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(root, 'e2e/android/gif-picker-contract.mts');
const journeyPath = resolve(root, 'e2e/android/gif-picker-journeys.mts');
const providerPath = resolve(root, 'e2e/android/gif-provider-fixture.mts');
const preferencePath = resolve(root, 'e2e/android/gif-native-preference.mts');
const fixturesPath = resolve(
  root,
  'e2e/android/account-workspace-fixtures.mts',
);

const groupedAssertionIds = {
  settingsLifecycle: [
    'gif-picker.settings.rooms-route-ready',
    'gif-picker.settings.sections-visible',
    'gif-picker.settings.detail-ready',
    'gif-picker.settings.native-preference-absent',
    'gif-picker.settings.preference-persisted',
    'gif-picker.settings.exact-config',
    'gif-picker.settings.clear-visible',
    'gif-picker.settings.cleared-config',
    'gif-picker.settings.clear-hidden',
    'gif-picker.settings.giphy-label-after-relaunch',
  ],
  unconfiguredTray: [
    'gif-picker.unconfigured.room-ready',
    'gif-picker.unconfigured.composer-ready',
    'gif-picker.unconfigured.attach-visible',
    'gif-picker.unconfigured.gif-absent',
  ],
  sendImage: [
    'gif-picker.send.room-ready',
    'gif-picker.send.search-visible',
    'gif-picker.send.result-visible',
  ],
  activeAccountSend: [
    'gif-picker.account.account-a-active',
    'gif-picker.account.add-account-ready',
    'gif-picker.account.account-b-active',
    'gif-picker.account.room-ready',
    'gif-picker.account.gif-visible',
    'gif-picker.account.result-visible',
    'gif-picker.account.exact-sender-b',
  ],
};
const assertionIds = Object.values(groupedAssertionIds).flat();

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
  for (const expression of expressions) {
    expect(expression).not.toMatch(
      /\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
    );
    expect(expression).not.toMatch(
      /dispatchEvent\(|setAttribute\(|\.value\s*=|location\s*=|history\./u,
    );
  }
}

function assertRuntimeContract({ journey, provider, preference, fixtures }) {
  const journeyFragments = [
    "id: 'settings-lifecycle'",
    "id: 'unconfigured-tray'",
    "id: 'send-image'",
    "id: 'active-account-send'",
    'expectedStages: 4',
    'expectedUniqueAssertions: 24',
    'expectedAssertionRecords: 24',
    'attempt: 1',
    'retries: 0',
    'expectedAssertionRecords: 10',
    'expectedAssertionRecords: 4',
    'expectedAssertionRecords: 3',
    'expectedAssertionRecords: 7',
    'await client.tapCurrent(\'[data-testid="open-settings"]\')',
    'await client.tapCurrent(\'[data-testid="settings-nav-gifs"]\')',
    'await client.tapCurrent(\'[data-testid="gif-provider-giphy"]\')',
    'await client.fill(\'[data-testid="gif-api-key"]\', secretKey)',
    'await client.tapCurrent(\'[data-testid="gif-save"]\')',
    'await client.tapCurrent(\'[data-testid="gif-clear"]\')',
    'await client.tapCurrent(\'[data-testid="composer-insert"]\')',
    'await client.tapCurrent(\'[data-testid="insert-gif"]\')',
    'await client.tapCurrent(\'[data-testid="gif-result"]\')',
    'await client.tapCurrent(\'[data-testid="add-account"]\')',
    'await readNativeGifPreference(',
    'await seedNativeGifPreference(',
    'await createGifProviderFixture(',
    'await provider.close()',
    'await fixtures.latestImageEvent(',
    "await client.record('gif-send-image-proof'",
    "event.msgtype === 'm.image'",
    'event.sender === accountB.userId',
    '\'[data-testid="media-bubble"][data-media-state="ready"]\'',
    "'GIPHY API key'",
    'redactMaestroArtifacts(output, secrets, true)',
    'scanGifPickerArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const providerFragments = [
    "urlPattern: 'https://api.klipy.com/*'",
    "urlPattern: 'https://media.klipy.com/*'",
    "'Fetch.requestPaused'",
    "'Fetch.enable'",
    "'Fetch.fulfillRequest'",
    "'Fetch.continueRequest'",
    "'Fetch.disable'",
    "'application/json'",
    "'image/gif'",
    "'Access-Control-Allow-Origin'",
    "'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'",
    "'https://media.klipy.com/e2e-preview/trinity.gif'",
    "'https://media.klipy.com/e2e-full/trinity.gif'",
    "id: 'e2e-1'",
    "content_description: 'e2e gif'",
    'activeConnections',
    'activeConnections.add(webview)',
    'activeConnections.delete(webview)',
    'unsubscribe()',
    'await work',
  ];
  for (const fragment of providerFragments)
    expect(provider).toContain(fragment);
  expect(provider).not.toContain("urlPattern: '*'");
  expect(provider).not.toContain('Network.setBlockedURLs');

  const preferenceFragments = [
    "const GIF_CONFIG_KEY = 'trinity.gif.config'",
    "const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml'",
    'seedNativeGifPreference(',
    'readNativeGifPreference(',
    'providerMatches:',
    'apiKeyMatches:',
    'apiKeyLength:',
    "'shell',",
    '`run-as ${client.applicationId} sh -c',
    "await device.adb('shell', 'rm', '-f', remote)",
    "throw new AggregateError(failures, 'GIF native preference seed failed')",
    "const ABSENT_MARKER = '__TRINITY_GIF_PREFERENCE_ABSENT__'",
  ];
  for (const fragment of preferenceFragments)
    expect(preference).toContain(fragment);
  expect(preference).not.toContain('localStorage');
  expect(preference).not.toContain('sessionStorage');
  expect(preference).not.toContain(".catch(() => '')");
  expect(preference).not.toContain('.catch(() => undefined)');

  const fixtureFragments = [
    'latestImageEvent(',
    '/messages?dir=b&limit=20',
    "event['type'] === 'm.room.message'",
    "content['msgtype'] === 'm.image'",
    'sender:',
    'eventId:',
  ];
  for (const fragment of fixtureFragments) expect(fixtures).toContain(fragment);

  expect(journey.match(/expectedAssertionRecords: 10/gu)).toHaveLength(1);
  expect(journey.match(/expectedAssertionRecords: 4/gu)).toHaveLength(1);
  expect(journey.match(/expectedAssertionRecords: 3/gu)).toHaveLength(1);
  expect(journey.match(/expectedAssertionRecords: 7/gu)).toHaveLength(1);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toContain('localStorage');
  expect(journey).not.toContain('sessionStorage');
  expect(journey).not.toContain('page.route');
  expect(journey).not.toContain('.goto(');
  expect(journey).not.toContain('.reload(');
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

describe('Android GIF-picker migration', () => {
  it('pins the exact predecessor, helper spans, and 17 + 7 parity shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      'c2196e638e21cedec16ae04d45823d9893d1586d7597ec41b1665f32062ac3ad',
    );
    const navigation = sourceLines(
      navigationSource,
      '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[31]).toContain('const GIF_1x1 = Buffer.from');
    expect(predecessor[35]).toContain('const PREVIEW_URL');
    expect(predecessor[36]).toContain('const FULL_URL');
    expect(predecessor[38]).toContain("'trinity.gif.config'");
    expect(predecessor[97]).toContain('async function addAccountViaUi');
    expect(predecessor[124]).toContain('async function latestImageSender');
    expect(predecessor[144]).toContain('async function stubKlipy');
    expect(predecessor[171]).toContain('async function openSeededRoom');

    const definitions = [
      [182, 231, 7, 0],
      [232, 250, 3, 1],
      [251, 289, 2, 1],
      [290, 353, 5, 1],
    ];
    for (const [start, end, directAssertions, roomOpenings] of definitions) {
      const definition = predecessor.slice(start, end).join('\n');
      expect(definition.match(/\bexpect\b/gu) ?? []).toHaveLength(
        directAssertions,
      );
      expect(definition.match(/await openSeededRoom\(/gu) ?? []).toHaveLength(
        roomOpenings,
      );
    }
    expect(definitions.reduce((total, entry) => total + entry[2], 0)).toBe(17);
    expect(predecessor.slice(97, 116).join('\n')).toContain(
      "expect(page.getByTestId('cancel-add')).toBeVisible()",
    );
    const navigationSpan = navigation.slice(10, 60).join('\n');
    expect(navigationSpan).toContain('await expect(page).toHaveURL(');
    expect(navigationSpan).toContain(
      "page.getByRole('navigation', { name: 'Settings sections' })",
    );
    expect(navigationSpan).toContain("getByTestId('settings-detail')");
  });

  it('exports all 24 identities in exact 10 + 4 + 3 + 7 groups', async () => {
    expect(contractPath, 'gif-picker-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.GIF_PICKER_SOURCES).toEqual({
      helpers: `${predecessorSource}:27-178`,
      settingsLifecycle: `${predecessorSource}:183-231`,
      unconfiguredTray: `${predecessorSource}:233-250`,
      sendImage: `${predecessorSource}:252-289`,
      activeAccountSend: `${predecessorSource}:291-353`,
      navigation: navigationSource,
      app: appSource,
      account: accountSource,
    });
    expect(contract.gifPickerStageAssertions).toEqual(groupedAssertionIds);
    expect(Object.values(contract.gifPickerAssertions)).toEqual(assertionIds);
    expect(new Set(assertionIds).size).toBe(24);
    expect(contract.GIF_PICKER_ASSERTION_RECORDS).toBe(24);
  });

  it('parses native GIF Preferences without returning the API key', async () => {
    expect(preferencePath, 'gif-native-preference.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(preferencePath)) return;
    const preference = await import(preferencePath);
    const observation = preference.parseNativeGifPreference(
      `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="trinity.gif.config">{&quot;provider&quot;:&quot;giphy&quot;,&quot;apiKey&quot;:&quot;e2e-secret-key&quot;}</string></map>`,
      'giphy',
      'e2e-secret-key',
    );
    expect(observation).toEqual({
      present: true,
      providerMatches: true,
      apiKeyMatches: true,
      apiKeyLength: 14,
    });
    expect(JSON.stringify(observation)).not.toContain('e2e-secret-key');
    expect(preference.parseNativeGifPreference('<map />', 'giphy', '')).toEqual(
      {
        present: false,
        providerMatches: false,
        apiKeyMatches: false,
        apiKeyLength: 0,
      },
    );
  });

  it('seeds native GIF Preferences through one secret-free shell command', async () => {
    expect(preferencePath, 'gif-native-preference.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(preferencePath)) return;
    const preference = await import(preferencePath);
    const calls = [];
    await preference.seedNativeGifPreference(
      {
        adb: async (...args) => {
          calls.push(args);
          return '';
        },
      },
      'eu.qwky.trinity',
      { provider: 'klipy', apiKey: 'fixture-secret' },
    );
    const write = calls.find(
      (args) =>
        args.length === 2 &&
        args[0] === 'shell' &&
        args[1].startsWith('run-as eu.qwky.trinity sh -c '),
    );
    expect(write).toBeDefined();
    expect(write[1]).toContain('mkdir -p shared_prefs');
    expect(write[1]).toContain('CapacitorStorage.xml.tmp');
    expect(JSON.stringify(calls)).not.toContain('fixture-secret');
  });

  it('fails closed when the remote secret-bearing preference file cannot be removed', async () => {
    const preference = await import(preferencePath);
    await expect(
      preference.seedNativeGifPreference(
        {
          adb: async (...args) => {
            if (args[0] === 'shell' && args[1] === 'rm') {
              throw new Error('remote cleanup denied');
            }
            return '';
          },
        },
        'eu.qwky.trinity',
        { provider: 'klipy', apiKey: 'fixture-secret' },
      ),
    ).rejects.toThrow('GIF native preference seed failed');
  });

  it('treats only a verified missing native preference file as absent', async () => {
    const preference = await import(preferencePath);
    const client = {
      applicationId: 'eu.qwky.trinity',
      device: {
        adb: async () => '__TRINITY_GIF_PREFERENCE_ABSENT__',
      },
    };
    await expect(
      preference.readNativeGifPreference(client, 'klipy', 'fixture-secret'),
    ).resolves.toEqual({
      present: false,
      providerMatches: false,
      apiKeyMatches: false,
      apiKeyLength: 0,
    });
    client.device.adb = async () => {
      throw new Error('run-as permission denied');
    };
    await expect(
      preference.readNativeGifPreference(client, 'klipy', 'fixture-secret'),
    ).rejects.toThrow('run-as permission denied');
  });

  it('classifies only the pinned KLIPY API and media URLs', async () => {
    expect(providerPath, 'gif-provider-fixture.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(providerPath)) return;
    const provider = await import(providerPath);
    const api = provider.gifProviderResponse(
      'https://api.klipy.com/v2/featured?key=redacted&limit=24&media_filter=gif%2Ctinygif&contentfilter=high',
      'GET',
    );
    expect(api?.contentType).toBe('application/json');
    expect(JSON.parse(api?.body ?? '{}')).toEqual({
      results: [
        {
          id: 'e2e-1',
          content_description: 'e2e gif',
          media_formats: {
            gif: {
              url: 'https://media.klipy.com/e2e-full/trinity.gif',
              dims: [1, 1],
            },
            tinygif: {
              url: 'https://media.klipy.com/e2e-preview/trinity.gif',
              dims: [1, 1],
            },
          },
        },
      ],
    });
    const media = provider.gifProviderResponse(
      'https://media.klipy.com/e2e-full/trinity.gif',
      'GET',
    );
    expect(media).toEqual({
      contentType: 'image/gif',
      body: Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64',
      ).toString('binary'),
    });
    expect(
      provider.gifProviderResponse('https://example.test/trinity.gif'),
    ).toBeUndefined();
    expect(
      provider.gifProviderResponse(
        'https://api.klipy.com/v2/featured?key=redacted&limit=24&media_filter=gif%2Ctinygif&contentfilter=high',
        'POST',
      ),
    ).toBeUndefined();
    expect(
      provider.gifProviderResponse(
        'https://api.klipy.com/v2/unexpected?key=redacted&limit=24&media_filter=gif%2Ctinygif&contentfilter=high',
        'GET',
      ),
    ).toBeUndefined();
    expect(
      provider.gifProviderResponse(
        'https://api.klipy.com/v2/featured?key=redacted&limit=25&media_filter=gif%2Ctinygif&contentfilter=high',
        'GET',
      ),
    ).toBeUndefined();
    expect(
      provider.gifProviderResponse(
        'https://media.klipy.com/unexpected/trinity.gif',
        'GET',
      ),
    ).toBeUndefined();
  });

  it('uses native actions, exact native storage, hermetic GIF bytes, and real Matrix proof', () => {
    const journey = readIfPresent(journeyPath);
    const provider = readIfPresent(providerPath);
    const preference = readIfPresent(preferencePath);
    expect(journey, 'gif-picker-journeys.mts must exist').not.toBe('');
    expect(provider, 'gif-provider-fixture.mts must exist').not.toBe('');
    expect(preference, 'gif-native-preference.mts must exist').not.toBe('');
    assertRuntimeContract({
      journey,
      provider,
      preference,
      fixtures: readFileSync(fixturesPath, 'utf8'),
    });
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when ownership, fixture scope, sender proof, redaction, or cleanup weakens', () => {
    const sources = {
      journey: readIfPresent(journeyPath),
      provider: readIfPresent(providerPath),
      preference: readIfPresent(preferencePath),
      fixtures: readFileSync(fixturesPath, 'utf8'),
    };
    if (
      !sources.journey ||
      !sources.provider ||
      !sources.preference ||
      !sources.fixtures.includes('latestImageEvent(')
    ) {
      expect(sources.journey, 'runtime implementation is pending').not.toBe('');
      return;
    }
    expect(() => assertRuntimeContract(sources)).not.toThrow();
    for (const [source, before, after] of [
      [
        'journey',
        'event.sender === accountB.userId',
        "typeof event.sender === 'string'",
      ],
      ['journey', 'await provider.close()', 'Promise.resolve()'],
      [
        'journey',
        "await client.record('gif-send-image-proof'",
        "await Promise.resolve('gif-send-image-proof'",
      ],
      [
        'journey',
        'redactMaestroArtifacts(output, secrets, true)',
        'Promise.resolve()',
      ],
      [
        'journey',
        'scanGifPickerArtifacts(output, secrets)',
        'Promise.resolve()',
      ],
      ['journey', 'await client.close()', 'Promise.resolve()'],
      [
        'journey',
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
      ['provider', "urlPattern: 'https://api.klipy.com/*'", "urlPattern: '*'"],
      ['provider', "'image/gif'", "'application/octet-stream'"],
      ['provider', 'activeConnections.delete(webview)', 'Promise.resolve()'],
      ['preference', "'trinity.gif.config'", "'gif.config'"],
      ['preference', 'apiKeyMatches:', 'apiKeyPresent:'],
      [
        'preference',
        "await device.adb('shell', 'rm', '-f', remote)",
        'await Promise.resolve()',
      ],
      [
        'preference',
        "const ABSENT_MARKER = '__TRINITY_GIF_PREFERENCE_ABSENT__'",
        "const ABSENT_MARKER = ''",
      ],
      [
        'fixtures',
        "content['msgtype'] === 'm.image'",
        "typeof content['msgtype'] === 'string'",
      ],
    ]) {
      expect(sources[source]).toContain(before);
      expect(
        () =>
          assertRuntimeContract({
            ...sources,
            [source]: sources[source].replaceAll(before, after),
          }),
        `mutation must fail closed: ${source}:${before}`,
      ).toThrow();
    }
  });

  it('wires one-attempt Android execution, registry ownership, and started-only diagnostics', () => {
    const project = read('e2e/android/project.json');
    const registry = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const packageJson = read('package.json');
    const migration = read('e2e/android/MIGRATION.md');

    expect(project).toContain('"gif-picker"');
    expect(project).toContain('--suite=android.gif-picker');
    expect(JSON.parse(project).targets['gif-picker'].options.command).toContain(
      '--timeout-ms=1200000',
    );
    expect(project).toContain(
      '--entrypoint=e2e/android/gif-picker-journeys.mts',
    );
    expect(registry).toContain("id: 'android.gif-picker'");
    expect(commands).toContain("name: 'e2e:android:gif-picker'");
    expect(packageJson).toContain('"e2e:android:gif-picker"');
    expect(workflow).toContain('gif-picker-started=true');
    expect(workflow).toContain('android-gif-picker');
    expect(workflow).toContain('android.gif-picker/**');
    expect(migration).toContain('## GIF picker journeys');
  });
});
