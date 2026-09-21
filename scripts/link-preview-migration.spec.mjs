import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/link-preview.spec.mts';
const caddySource = 'e2e/support/synapse/Caddyfile';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const fixturesSource = 'e2e/android/account-workspace-fixtures.mts';
const contractPath = resolve(root, 'e2e/android/link-preview-contract.mts');
const observerPath = resolve(
  root,
  'e2e/android/link-preview-network-observer.mts',
);
const journeyPath = resolve(root, 'e2e/android/link-preview-journeys.mts');

const assertionIds = [
  'link-preview.card-visible',
  'link-preview.exact-title',
  'link-preview.exact-destination',
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
      /\.(?:click|focus|fill|submit|requestSubmit|scrollBy|scrollTo)\s*\(/u,
    );
    expect(expression).not.toMatch(
      /dispatchEvent\(|removeAttribute\(|setAttribute\(|\.value\s*=|\.scrollTop\s*=|\.scrollLeft\s*=|location\s*=|history\./u,
    );
  }
}

function assertRuntimeContract({ journey, observer, fixtures }) {
  const journeyFragments = [
    "const APPLICATION_ID = 'eu.qwky.trinity'",
    "id: 'link-preview'",
    "const ogUrl = process.env['TRINITY_E2E_NETWORK_CONTAINER']",
    "'http://localhost:8080/og'",
    "'http://caddy:8080/og'",
    "preset: 'private_chat'",
    "'m.room.encryption'",
    'await fixtures.roomState(',
    'await fixtures.sendMessage(',
    'await fixtures.roomEvent(',
    "event['type'] === 'm.room.message'",
    "content['msgtype'] === 'm.text'",
    "content['body'] === messageBody",
    'await openLinkPreviewNetworkObserver(',
    'await client.login(account)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    "await client.tapCurrent('.channel', { text: room.name })",
    'data-testid="link-preview"',
    'messageBody',
    'LINK_PREVIEW_TITLE',
    'ogUrl',
    'await observer.waitForPreview()',
    'preview.matrixPreviewCount === 1',
    'preview.directOgCount === 0',
    'expectedStages: 1',
    'expectedUniqueAssertions: 3',
    'expectedAssertionRecords: 3',
    'attempt: 1',
    'retries: 0',
    "secrets['SECRET_ROOM_NAME'] = room.name",
    "secrets['SECRET_MESSAGE_BODY'] = messageBody",
    'redactMaestroArtifacts(output, secrets, true)',
    'scanLinkPreviewArtifacts(output, secrets)',
    '(?:Bearer|Basic)',
    '(?:cookie|set-cookie)',
    'await observer.close()',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const observerFragments = [
    "connection.on('Network.requestWillBeSent'",
    "await connection.send('Network.enable')",
    "await connection.send('Network.disable')",
    "pathname === '/_matrix/client/v1/media/preview_url'",
    "url.searchParams.get('url') === ogUrl",
    "request.method === 'GET'",
    'url.origin === homeserverOrigin',
    "ogOrigin === 'http://caddy:8080'",
    "ogOrigin === 'http://localhost:8080'",
    "ogPathname === '/og'",
    'method: request.method',
    'initiatorCategory',
    'authenticated',
    'matrixPreviewCount',
    'directOgCount',
    'let matrixPreviewCount = 0',
    'let directOgCount = 0',
    'directOgRequest ??=',
    'unsubscribe()',
    'connection.close()',
    'assert(!closed',
  ];
  for (const fragment of observerFragments)
    expect(observer).toContain(fragment);

  const fixtureFragments = [
    'preset?: string',
    'type WorkspaceRoomStateEventType =',
    "| 'm.room.encryption'",
    'sendMessage(',
    "{ msgtype: 'm.text', body }",
    'roomState(',
    'roomEvent(',
  ];
  for (const fragment of fixtureFragments) expect(fixtures).toContain(fragment);

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /client\.(?:focusFixture|focusCurrent|fill|replace|navigate|reload)\s*\(/u,
  );
  expect(journey).not.toMatch(
    /mouse\.|dispatchEvent\(|\.click\(\)|\.focus\(\)|\.value\s*=/u,
  );
  expect(observer).not.toMatch(
    /Network\.(?:setBlockedURLs|setRequestInterception|continueInterceptedRequest)|Fetch\.(?:enable|fulfillRequest|continueRequest)|responseReceived|getResponseBody/u,
  );
  expect(observer).not.toMatch(/cookie|postData|responseBody/iu);
  assertReadOnlyRendererExpressions(journey, journeyPath);
}

describe('Android link-preview migration', () => {
  it('pins the exact predecessor, OG fixture and three direct assertions', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '08282733e2a496677fda5b9c03738b571714f838d49a93a36fbaf16eb38e7da4',
    );
    const caddy = sourceLines(
      caddySource,
      'c23c76234ad98fee4692fecac6af6c7f404ad9c852a251c17a7ebf6da4c006ab',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    const ogDefinition = predecessor.slice(16, 23).join('\n');
    const definition = predecessor.slice(27, 74).join('\n');
    const ogFixture = caddy.slice(51, 62).join('\n');
    expect(ogDefinition).toContain(
      "const OG_URL = process.env['TRINITY_E2E_NETWORK_CONTAINER']",
    );
    expect(ogDefinition).toContain("'http://localhost:8080/og'");
    expect(ogDefinition).toContain("'http://caddy:8080/og'");
    expect(definition).toContain("preset: 'private_chat'");
    expect(definition).toContain("msgtype: 'm.text'");
    expect(definition).toContain('body: `look: ${OG_URL}`');
    expect(definition.match(/await expect\(/gu)).toHaveLength(3);
    expect(definition).toContain("toContainText('Trinity E2E Preview')");
    expect(definition).toContain("toHaveAttribute('href', OG_URL)");
    expect(ogFixture).toContain('@og path /og');
    expect(ogFixture).toContain('Trinity E2E Preview');
    expect(app.join('\n')).toContain('export async function login(');
    expect(account.join('\n')).toContain('export async function registerUser(');
  });

  it('exports exactly three globally unique identities and exact sources', async () => {
    expect(contractPath, 'link-preview-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.LINK_PREVIEW_SOURCES).toEqual({
      ogUrl: `${predecessorSource}:17-23`,
      definition: `${predecessorSource}:28-74`,
      caddy: `${caddySource}:52-62`,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.linkPreviewAssertions)).toEqual(assertionIds);
    expect(new Set(Object.values(contract.linkPreviewAssertions)).size).toBe(3);
    expect(contract.LINK_PREVIEW_ASSERTION_RECORDS).toBe(3);
    expect(contract.LINK_PREVIEW_TITLE).toBe('Trinity E2E Preview');
  });

  it('requires plaintext fixture proof, native ownership and bounded Network provenance', () => {
    for (const path of [observerPath, journeyPath]) {
      expect(path, `${path} must exist`).toSatisfy(existsSync);
    }
    if (!existsSync(observerPath) || !existsSync(journeyPath)) return;
    assertRuntimeContract({
      journey: readFileSync(journeyPath, 'utf8'),
      observer: readFileSync(observerPath, 'utf8'),
      fixtures: read(fixturesSource),
    });
  });

  it('keeps effective negative controls for provenance and ownership boundaries', () => {
    if (!existsSync(observerPath) || !existsSync(journeyPath)) return;
    const sources = {
      journey: readFileSync(journeyPath, 'utf8'),
      observer: readFileSync(observerPath, 'utf8'),
      fixtures: read(fixturesSource),
    };
    const mutations = [
      {
        journey: sources.journey.replace(
          'expectedUniqueAssertions: 3',
          'expectedUniqueAssertions: 2',
        ),
      },
      {
        journey: sources.journey.replaceAll(
          "preset: 'private_chat'",
          "preset: 'public_chat'",
        ),
      },
      {
        journey: sources.journey.replaceAll(
          "'m.room.encryption'",
          "'m.room.name'",
        ),
      },
      {
        journey: sources.journey.replace(
          "content['body'] === messageBody",
          "content['body'] === ogUrl",
        ),
      },
      {
        journey: sources.journey.replace(
          'preview.matrixPreviewCount === 1',
          'preview.matrixPreviewCount > 0',
        ),
      },
      {
        journey: sources.journey.replace(
          'preview.directOgCount === 0',
          'preview.directOgCount >= 0',
        ),
      },
      {
        journey: sources.journey.replace(
          'await observer.close()',
          'void observer',
        ),
      },
      {
        journey: sources.journey.replace(
          'scanLinkPreviewArtifacts(output, secrets)',
          'Promise.resolve()',
        ),
      },
      {
        journey: sources.journey.replace('(?:cookie|set-cookie)', 'cookie'),
      },
      {
        observer: sources.observer.replace(
          "pathname === '/_matrix/client/v1/media/preview_url'",
          "pathname.includes('preview_url')",
        ),
      },
      {
        observer: sources.observer.replace(
          "url.searchParams.get('url') === ogUrl",
          "url.searchParams.has('url')",
        ),
      },
      {
        observer: sources.observer.replace(
          "ogOrigin === 'http://caddy:8080'",
          'true',
        ),
      },
      {
        observer: sources.observer.replace(
          "await connection.send('Network.disable')",
          'Promise.resolve()',
        ),
      },
      {
        observer: sources.observer.replace(
          'directOgRequest ??=',
          'directOgRequest =',
        ),
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      expect(
        () => assertRuntimeContract({ ...sources, ...mutation }),
        `critical negative control ${index + 1}`,
      ).toThrow();
    }
  });

  it('wires the uncached serial target, registry, ordered CI diagnostics and ledger', () => {
    const project = read('e2e/android/project.json');
    const packageJson = read('package.json');
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const docs = read('e2e/android/MIGRATION.md');
    for (const source of [
      project,
      packageJson,
      runners,
      commands,
      workflow,
      docs,
    ]) {
      expect(source).toContain('link-preview');
    }
    expect(project).toContain('--suite=android.link-preview');
    expect(project).toContain('--timeout-ms=1200000');
    expect(project).toContain('--resource=android-avd --resource=synapse');
    expect(runners).toContain("id: 'android.link-preview'");
    expect(runners).toContain("serializationKeys: ['android-avd', 'synapse']");
    expect(workflow).toContain('link-preview-started=true');
    expect(workflow).toContain('--timeout-ms 1500000');
    expect(workflow).toContain('surface: android-link-preview');
    expect(workflow).toContain(
      'dist/.playwright/trinity-e2e-android/*/android.link-preview/**',
    );
    expect(
      workflow.indexOf('trinity-e2e-android:link-preview'),
    ).toBeGreaterThan(workflow.indexOf('trinity-e2e-android:jump-to-latest'));
  });

  it('does not weaken the retained predecessor while implementation files are absent', () => {
    expect(readIfPresent(journeyPath)).not.toMatch(
      /mouse\.|dispatchEvent\(|\.click\(\)|\.focus\(\)|\.value\s*=/u,
    );
  });
});
