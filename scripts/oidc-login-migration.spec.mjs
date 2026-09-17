import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactMaestroArtifacts } from '../e2e/android/maestro-session.mts';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/accounts/oidc-login.spec.mts';
const appSource = 'e2e/support/app.mts';
const contractPath = resolve(root, 'e2e/android/oidc-login-contract.mts');
const fixturePath = resolve(root, 'e2e/android/oidc-login-fixture.mts');
const journeyPath = resolve(root, 'e2e/android/oidc-login-journeys.mts');
const chromeFlowPath = resolve(
  root,
  'e2e/android/flows/oidc-login-chrome-setup.yaml',
);

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const classificationAssertions = [
  'oidc-login.delegated-continue-visible',
  'oidc-login.create-account-visible',
  'oidc-login.password-action-absent',
  'oidc-login.legacy-sso-action-absent',
];
const providerErrorAssertions = [
  'oidc-login.provider-error-visible',
  'oidc-login.back-to-sign-in-visible',
  'oidc-login.authorize-request-present',
  'oidc-login.client-id-exact',
  'oidc-login.response-type-code',
  'oidc-login.challenge-method-s256',
  'oidc-login.challenge-nonempty',
  'oidc-login.state-nonempty',
  'oidc-login.callback-uri-exact',
  'oidc-login.registration-application-type-native',
  'oidc-login.scope-client-api',
  'oidc-login.scope-device',
  'oidc-login.response-mode-query',
];
const redemptionAssertions = [
  'oidc-login.token-request-present',
  'oidc-login.grant-type-authorization-code',
  'oidc-login.authorization-code-exact',
  'oidc-login.token-client-id-exact',
  'oidc-login.verifier-nonempty',
  'oidc-login.pkce-s256-match',
  'oidc-login.callback-errors-absent',
];
const fallbackAssertions = [
  'oidc-login.password-action-visible',
  'oidc-login.delegated-continue-absent',
];
const assertionIds = [
  ...classificationAssertions,
  ...providerErrorAssertions,
  ...redemptionAssertions,
  ...fallbackAssertions,
];

const forbiddenDomActions = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
  /\.fill\s*\(/u,
  /\.dispatchEvent\s*\(/u,
  /\.(?:requestSubmit|submit)\s*\(/u,
  /\bRuntime\.evaluate\b/u,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/u,
  /\blocation\.(?:assign|replace|reload)\s*\(/u,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/u,
  /\bwindow\.open\s*\(/u,
];

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

const assertionSiteCount = (lines) =>
  lines.filter((line) => /\bexpect(?:\.poll)?(?:\(|\s*$)/u.test(line)).length;

function assertProtectedRuntimeContract(fixture, journey) {
  const expectOccurrences = (source, fragment, count) => {
    expect(source.split(fragment).length - 1, fragment).toBe(count);
  };
  expectOccurrences(
    fixture,
    "wellKnown: 'https://oidc.example/.well-known/matrix/client'",
    1,
  );
  expectOccurrences(
    fixture,
    "{ name: 'Access-Control-Allow-Origin', value: '*' }",
    1,
  );
  expectOccurrences(fixture, "code_challenge_methods_supported: ['S256']", 1);
  expectOccurrences(fixture, "application_type === 'native'", 1);
  expectOccurrences(fixture, 'assert.equal(redirectUri, CALLBACK_URI)', 1);
  expectOccurrences(
    fixture,
    "assert(state, 'OIDC authorization state must be non-empty')",
    1,
  );
  expectOccurrences(fixture, 'assert.equal(code, AUTHORIZATION_CODE)', 1);
  expectOccurrences(
    fixture,
    "assert(pkceMatches, 'OIDC token verifier must match the S256 challenge')",
    1,
  );
  expectOccurrences(fixture, 'responseCode: 404', 1);
  expectOccurrences(fixture, "connection.send('Fetch.disable')", 1);
  expectOccurrences(
    fixture,
    "registerSecret('PKCE_VERIFIER_SECRET', verifier)",
    1,
  );
  expectOccurrences(
    journey,
    "assert.equal(authorize.challengeMethod, 'S256')",
    1,
  );
  expectOccurrences(journey, 'redactMaestroArtifacts(output, secrets)', 1);
}

describe('Android OIDC-native login migration', () => {
  it('pins all four predecessor spans and their 4 + 13 + 7 + 2 assertion shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      'e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );

    expect(predecessor[85]).toContain(
      "test('offers the provider Continue + Create account and hides password/SSO'",
    );
    expect(predecessor[99]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(85, 100))).toBe(4);

    expect(predecessor[101]).toContain(
      "test('builds a PKCE authorize request and surfaces a provider error on the callback'",
    );
    expect(predecessor[168]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(101, 169))).toBe(13);

    expect(predecessor[170]).toContain(
      "test('redeems the code with the stashed PKCE verifier'",
    );
    expect(predecessor[247]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(170, 248))).toBe(7);

    expect(predecessor[249]).toContain(
      "test('a non-OIDC homeserver still shows the password form'",
    );
    expect(predecessor[284]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(249, 285))).toBe(2);

    const source = predecessor.join('\n');
    expect(source).toContain("const HS_DOMAIN = 'oidc.example'");
    expect(source).toContain("const HS_BASE = 'https://hs.oidc.example'");
    expect(source).toContain(
      "const REGISTRATION_ENDPOINT = 'https://provider.oidc.example/register'",
    );
    expect(source).toContain('const AUTH_METADATA = {');
    expect(source).toContain('const CORS: Record<string, string> = {');
    expect(source).toContain('function json(route: Route');
    expect(source).toContain('async function mockOidcHomeserver');
    expect(source).toContain('async function discover(');
    expect(app.join('\n')).toContain(
      'export const webNavigate = navigateApplication;',
    );
  });

  it('exports the exact source map and all 26 unique identities', async () => {
    expect(contractPath, 'oidc-login-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.OIDC_LOGIN_SOURCES).toEqual({
      classification: `${predecessorSource}:86-100`,
      providerError: `${predecessorSource}:102-169`,
      redemption: `${predecessorSource}:171-248`,
      fallback: `${predecessorSource}:250-285`,
      app: appSource,
    });
    expect(Object.values(contract.oidcLoginAssertions.classification)).toEqual(
      classificationAssertions,
    );
    expect(Object.values(contract.oidcLoginAssertions.providerError)).toEqual(
      providerErrorAssertions,
    );
    expect(Object.values(contract.oidcLoginAssertions.redemption)).toEqual(
      redemptionAssertions,
    );
    expect(Object.values(contract.oidcLoginAssertions.fallback)).toEqual(
      fallbackAssertions,
    );
    const actual = Object.values(contract.oidcLoginAssertions).flatMap(
      Object.values,
    );
    expect(actual).toEqual(assertionIds);
    expect(new Set(actual).size).toBe(26);
  });

  it('owns one exact CDP fixture across app discovery and Chrome authorization', () => {
    const fixture = readIfPresent(fixturePath);
    const chromeFlow = readIfPresent(chromeFlowPath);
    expect(fixture, 'oidc-login-fixture.mts must exist').not.toBe('');
    expect(chromeFlow, 'oidc-login-chrome-setup.yaml must exist').not.toBe('');
    expect(fixture).toContain("const CHROME_PACKAGE = 'com.android.chrome'");
    expect(fixture).toContain('/data/local/tmp/chrome-command-line');
    expect(fixture).toContain("'pm', 'clear', CHROME_PACKAGE");
    expect(fixture).toContain("'am', 'force-stop', CHROME_PACKAGE");
    expect(fixture).toContain('Fetch.enable');
    expect(fixture).toContain('Fetch.fulfillRequest');
    expect(fixture).toContain('Fetch.continueRequest');
    expect(fixture).toContain('Fetch.disable');
    expect(fixture).toContain("'OPTIONS'");
    expect(fixture).toContain('responseCode: 204');
    expect(fixture).toContain("'Access-Control-Allow-Origin'");
    expect(fixture).toContain("'Access-Control-Allow-Methods'");
    expect(fixture).toContain("'Access-Control-Allow-Headers'");
    expect(fixture).toMatch(/eventWork\s*=\s*eventWork[\s\S]*?\.then/u);
    expect(fixture).toContain('throw new AggregateError(');
    expect(chromeFlow).toContain('appId: com.android.chrome');
    expect(chromeFlow).toContain('Use without an account');
    expect(chromeFlow).toContain('Accept & continue');
    expect(chromeFlow).toContain('No thanks');
    for (const mutation of forbiddenDomActions) {
      expect(fixture).not.toMatch(mutation);
    }
    expect(fixture).not.toMatch(/playwright|AndroidDevice|_androidDriver/u);
  });

  it('preserves the exact endpoint, metadata, callback and PKCE contracts', () => {
    const fixture = readIfPresent(fixturePath);
    for (const endpoint of [
      'https://oidc.example/.well-known/matrix/client',
      'https://hs.oidc.example/_matrix/client/versions',
      'https://hs.oidc.example/_matrix/client/v3/login',
      'https://hs.oidc.example/_matrix/client/v1/auth_metadata',
      'https://hs.oidc.example/_matrix/client/unstable/org.matrix.msc2965',
      'https://hs.oidc.example/_matrix/client/v3/account/whoami',
      'https://provider.oidc.example/register',
      'https://provider.oidc.example/authorize',
      'https://provider.oidc.example/token',
    ]) {
      expect(fixture).toContain(endpoint);
    }
    expect(fixture).toContain(
      "response_modes_supported: ['query', 'fragment']",
    );
    expect(fixture).toContain("response_types_supported: ['code']");
    expect(fixture).toContain(
      "grant_types_supported: ['authorization_code', 'refresh_token']",
    );
    expect(fixture).toContain("code_challenge_methods_supported: ['S256']");
    expect(fixture).toContain("prompt_values_supported: ['create']");
    expect(fixture).toContain("application_type === 'native'");
    expect(fixture).toContain('eu.qwky.trinity:/sso-callback');
    expect(fixture).toContain("callbackParams.set('error', 'access_denied')");
    expect(fixture).toContain(
      "callbackParams.set('error_description', 'E2E declined')",
    );
    expect(fixture).toContain("callbackParams.set('code', 'E2E_CODE')");
    expect(fixture).toContain("grantType === 'authorization_code'");
    expect(fixture).toContain("createHash('sha256')");
    expect(fixture).toContain("digest('base64url')");
    expect(fixture).toContain("errcode: 'M_UNRECOGNIZED'");
    expect(fixture).toContain('responseCode: 404');
  });

  it('implements four native stages and records only the exact identities', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'oidc-login-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('oidc-login-contract.mts');
    expect(journey).toContain('oidc-login-fixture.mts');
    expect(journey).toContain("id: 'delegated-classification'");
    expect(journey).toContain("id: 'provider-error-callback'");
    expect(journey).toContain("id: 'durable-pkce-redemption'");
    expect(journey).toContain("id: 'password-fallback'");
    expect(journey).toContain("client.focusCurrent('#homeserver')");
    expect(journey).toContain("client.fillFocused('#homeserver', HS_DOMAIN)");
    expect(journey).toContain(
      "client.tapCurrent('button', { exactText: 'Continue' })",
    );
    expect(journey).toContain('\'[data-testid="oidc-continue"]\'');
    expect(journey).toContain('\'[data-testid="oidc-register"]\'');
    expect(journey).toMatch(
      /client\.visible\(\s*'\[role="alert"\]',\s*\{ exactText: 'E2E declined' \},\s*60_000,?\s*\)/u,
    );
    expect(journey).not.toContain(
      "assert(callbackBody.text.includes('E2E declined'))",
    );
    expect(journey).toContain('new Set<OidcLoginAssertion>()');
    expect(journey).toContain('assert(!recorded.has(identity)');
    expect(journey).toContain('expectedAssertions: 26');
    expect(journey).toContain('expectedStages: 4');
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toContain("await client.capture('failed')");
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const group of [
      'classification',
      'providerError',
      'redemption',
      'fallback',
    ]) {
      expect(journey).toContain(`assertions.${group}.`);
    }
    for (const mutation of forbiddenDomActions) {
      expect(journey).not.toMatch(mutation);
    }
    expect(journey).not.toMatch(
      /\bandroid\.(?:connect|devices?)\b|AndroidDevice|_androidDriver|launchBrowser/u,
    );
  });

  it('redacts every live OIDC secret and never records raw protocol payloads', async () => {
    const fixture = readIfPresent(fixturePath);
    const journey = readIfPresent(journeyPath);
    expect(fixture).toContain('registerSecret(');
    expect(fixture).toContain('PKCE_STATE_SECRET');
    expect(fixture).toContain('PKCE_CHALLENGE_SECRET');
    expect(fixture).toContain('PKCE_VERIFIER_SECRET');
    expect(fixture).toContain('AUTHORIZATION_CODE_SECRET');
    expect(fixture).toContain('MOCK_ACCESS_TOKEN_SECRET');
    expect(fixture).toContain('MOCK_REFRESH_TOKEN_SECRET');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).not.toMatch(
      /observation:\s*(?:state|challenge|verifier|code|accessToken|refreshToken|headers|body)/u,
    );

    const directory = await mkdtemp(join(tmpdir(), 'trinity-oidc-login-'));
    const secrets = {
      PKCE_STATE_SECRET: 'oidc-state-negative-control',
      PKCE_CHALLENGE_SECRET: 'oidc-challenge-negative-control',
      PKCE_VERIFIER_SECRET: 'oidc-verifier-negative-control',
      AUTHORIZATION_CODE_SECRET: 'oidc-code-negative-control',
      MOCK_ACCESS_TOKEN_SECRET: 'oidc-access-negative-control',
      MOCK_REFRESH_TOKEN_SECRET: 'oidc-refresh-negative-control',
    };
    const artifact = join(directory, 'oidc.log');
    try {
      await writeFile(artifact, Object.values(secrets).join('\n'));
      await redactMaestroArtifacts(directory, secrets);
      const redacted = await readFile(artifact, 'utf8');
      for (const secret of Object.values(secrets)) {
        expect(redacted).not.toContain(secret);
      }
      expect(redacted.match(/\[REDACTED\]/gu)).toHaveLength(6);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses finite observation and aggregate cleanup for every owned resource', () => {
    const fixture = readIfPresent(fixturePath);
    const journey = readIfPresent(journeyPath);
    expect(fixture).toContain('AbortSignal.timeout(');
    expect(fixture).toContain('await eventWork');
    expect(fixture).toContain("connection.send('Fetch.disable')");
    expect(fixture).toContain('if (!connection.closed)');
    expect(fixture).toContain('connection.close(');
    expect(fixture).toContain('throw new AggregateError(');
    expect(journey).toContain('await fixture.close()');
    expect(journey).toContain('await client.close()');
    expect(journey).toContain('device.close()');
    expect(journey).toContain('throw new AggregateError(');
  });

  it('rejects endpoint, protocol, native, PKCE, fallback and cleanup weakenings', () => {
    const fixture = readIfPresent(fixturePath);
    const journey = readIfPresent(journeyPath);
    const controls = [
      {
        id: 'exact discovery endpoint',
        target: 'fixture',
        before: "wellKnown: 'https://oidc.example/.well-known/matrix/client'",
        after: "wellKnown: 'https://oidc.example/*'",
      },
      {
        id: 'CORS origin contract',
        target: 'fixture',
        before: "{ name: 'Access-Control-Allow-Origin', value: '*' }",
        after: "{ name: 'Access-Control-Allow-Origin', value: 'null' }",
      },
      {
        id: 'metadata S256 support',
        target: 'fixture',
        before: "code_challenge_methods_supported: ['S256']",
        after: 'code_challenge_methods_supported: []',
      },
      {
        id: 'native dynamic registration',
        target: 'fixture',
        before: "application_type === 'native'",
        after: "application_type === 'web'",
      },
      {
        id: 'exact private-use callback',
        target: 'fixture',
        before: 'assert.equal(redirectUri, CALLBACK_URI)',
        after: 'assert.ok(redirectUri)',
      },
      {
        id: 'non-empty state',
        target: 'fixture',
        before: "assert(state, 'OIDC authorization state must be non-empty')",
        after: 'void state',
      },
      {
        id: 'exact authorization code',
        target: 'fixture',
        before: 'assert.equal(code, AUTHORIZATION_CODE)',
        after: 'assert(code)',
      },
      {
        id: 'PKCE verifier equality',
        target: 'fixture',
        before:
          "assert(pkceMatches, 'OIDC token verifier must match the S256 challenge')",
        after: 'void pkceMatches',
      },
      {
        id: 'fallback exact 404',
        target: 'fixture',
        before: 'responseCode: 404',
        after: 'responseCode: 200',
      },
      {
        id: 'Fetch cleanup',
        target: 'fixture',
        before: "connection.send('Fetch.disable')",
        after: "connection.send('Fetch.enable')",
      },
      {
        id: 'verifier redaction',
        target: 'fixture',
        before: "registerSecret('PKCE_VERIFIER_SECRET', verifier)",
        after: 'void verifier',
      },
      {
        id: 'journey challenge method proof',
        target: 'journey',
        before: "assert.equal(authorize.challengeMethod, 'S256')",
        after: 'assert(authorize.challengeMethod)',
      },
      {
        id: 'artifact redaction',
        target: 'journey',
        before: 'redactMaestroArtifacts(output, secrets)',
        after: 'Promise.resolve()',
      },
    ];

    expect(() =>
      assertProtectedRuntimeContract(fixture, journey),
    ).not.toThrow();
    for (const control of controls) {
      const source = control.target === 'fixture' ? fixture : journey;
      expect(
        source.split(control.before).length - 1,
        `${control.id} fixture occurrence count`,
      ).toBe(1);
      expect(
        () =>
          assertProtectedRuntimeContract(
            control.target === 'fixture'
              ? fixture.replace(control.before, control.after)
              : fixture,
            control.target === 'journey'
              ? journey.replace(control.before, control.after)
              : journey,
          ),
        control.id,
      ).toThrow();
    }
  });

  it('registers one bounded uncached Nx suite and package command', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['oidc-login'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain('--suite=android.oidc-login');
    expect(target.options.command).toContain('--timeout-ms=1200000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/oidc-login-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).not.toContain('--resource=synapse');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:oidc-login']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:oidc-login',
    );
  });

  it('registers Maestro plus shard-4 started-only hosted diagnostics', () => {
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.oidc-login'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:oidc-login'",
    );
    expect(runners).toContain("canonicalScript: 'e2e:android:oidc-login'");
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/oidc-login-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:oidc-login'");
    expect(commands).toContain("suiteIds: ['android.oidc-login']");
    expect(commands).toContain('matrix.shard }}" = "4"');
    expect(workflow).toContain('oidc-login-started=true');
    expect(workflow).toContain(
      'node scripts/ci-run-command.mjs --timeout-ms 1500000 -- pnpm exec nx run trinity-e2e-android:oidc-login',
    );
    expect(workflow).toContain('surface: android-oidc-login');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.oidc-login/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.oidc-login-started == 'true'/u,
    );
  });

  it('documents parity and retains every exact predecessor', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## OIDC-native login journeys');
    expect(migration).toContain('`android.oidc-login`');
    expect(migration).toContain(
      'e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a',
    );
    expect(migration).toContain('26 assertion identities');
    expect(migration).toContain('RFC 7636');
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain("path: 'journeys/accounts/oidc-login.spec.mts'");
    const predecessor = read(predecessorSource);
    for (const title of [
      'offers the provider Continue + Create account and hides password/SSO',
      'builds a PKCE authorize request and surfaces a provider error on the callback',
      'redeems the code with the stashed PKCE verifier',
      'a non-OIDC homeserver still shows the password form',
    ]) {
      expect(predecessor).toContain(`test('${title}'`);
    }
  });
});
