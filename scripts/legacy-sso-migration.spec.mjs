import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactMaestroArtifacts } from '../e2e/android/maestro-session.mts';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/accounts/sso-login.spec.mts';
const ssoHelperSource = 'e2e/browser/support/sso.mts';
const appSource = 'e2e/support/app.mts';
const dexSource = 'e2e/support/synapse/dex.yaml';
const contractPath = resolve(root, 'e2e/android/legacy-sso-contract.mts');
const providerPath = resolve(root, 'e2e/android/legacy-sso-provider.mts');
const journeyPath = resolve(root, 'e2e/android/legacy-sso-journeys.mts');
const accountClientPath = resolve(
  root,
  'e2e/android/account-workspace-client.mts',
);
const dexFlowPath = resolve(root, 'e2e/android/flows/legacy-sso-dex.yaml');
const chromeSetupFlowPath = resolve(
  root,
  'e2e/android/flows/legacy-sso-chrome-setup.yaml',
);
const dexReadyFlowPath = resolve(
  root,
  'e2e/android/flows/legacy-sso-dex-ready.yaml',
);
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const signInAssertions = [
  'legacy-sso.password-action-visible',
  'legacy-sso.sso-action-visible',
  'legacy-sso.delegated-action-absent',
  'legacy-sso.persisted-rooms-visible',
];
const unverifiedAssertions = [
  'legacy-sso.verification-error-visible',
  'legacy-sso.back-to-sign-in-visible',
  'legacy-sso.unverified-rooms-route-absent',
  'legacy-sso.unspent-token-exact-mxid',
];
const inFlightAssertions = [
  'legacy-sso.completing-copy-visible',
  'legacy-sso.wordmark-visible',
  'legacy-sso.wordmark-text',
  'legacy-sso.heading-count',
  'legacy-sso.completing-heading-count',
  'legacy-sso.card-bounds-present',
  'legacy-sso.card-min-width',
  'legacy-sso.card-max-width',
  'legacy-sso.card-nonnegative-x',
  'legacy-sso.card-within-viewport',
  'legacy-sso.main-count',
  'legacy-sso.body-bounds-present',
  'legacy-sso.body-inset',
  'legacy-sso.inflight-verification-error-absent',
  'legacy-sso.inflight-rooms-route-absent',
];
const assertionIds = [
  ...signInAssertions,
  ...unverifiedAssertions,
  ...inFlightAssertions,
];

const forbiddenDomActions = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
  /\.fill\s*\(/u,
  /\.dispatchEvent\s*\(/u,
  /\.(?:requestSubmit|submit)\s*\(/u,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/u,
  /\blocation\.(?:assign|replace|reload)\s*\(/u,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/u,
  /\bwindow\.open\s*\(/u,
  /client\.(?:focusFixture|navigate|reload)\s*\(/u,
];
const forbiddenProductActions = [
  /client\.(?:focusFixture|navigate|reload)\s*\(/u,
  /evaluateNative\([\s\S]*?\.click\s*\(/u,
  /evaluateNative\([\s\S]*?\.focus\s*\(/u,
  /evaluateNative\([\s\S]*?\.dispatchEvent\s*\(/u,
  /evaluateNative\([\s\S]*?\.(?:requestSubmit|submit)\s*\(/u,
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

function assertProtectedRuntimeContract(journey) {
  const expectOccurrences = (fragment, count) => {
    expect(journey.split(fragment).length - 1, fragment).toBe(count);
  };

  expectOccurrences(
    `client.expectCount('[data-testid="oidc-continue"]', 0)`,
    1,
  );
  expectOccurrences('await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)', 1);
  expectOccurrences(
    "assert(!new URL(surface.url).pathname.startsWith('/rooms'))",
    2,
  );
  expectOccurrences('assert.equal(appTokenLoginRequests, 0)', 2);
  expectOccurrences('assert.equal(redeemed.userId, expectedUserId)', 2);
  expectOccurrences(
    'secrets.SSO_STATE_SECRET_2 = await readPersistedSsoState',
    1,
  );
  expectOccurrences(
    'secrets.SSO_STATE_SECRET_3 = await readPersistedSsoState',
    1,
  );
  expectOccurrences("assert.equal(wordmark.text, 'Trinity')", 1);
  expectOccurrences("await client.expectCount('h1, h2, h3, h4, h5, h6', 1)", 1);
  expectOccurrences("await client.expectCount('main', 1)", 1);
  expectOccurrences('assert(card.rect.width >= 400)', 1);
  expectOccurrences('assert(card.rect.width <= 480)', 1);
  expectOccurrences('assert(body.rect.x > card.rect.x + 8)', 1);
  expectOccurrences('await tokenObserver.close()', 3);
  expectOccurrences('await provider.close()', 1);
  expectOccurrences('await firstProvider.close()', 2);
  expectOccurrences('await secondProvider?.close()', 1);
  expectOccurrences('await client.close()', 1);
  expectOccurrences('secrets.LOGIN_TOKEN_1 = token', 1);
  expectOccurrences('secrets.LOGIN_TOKEN_2 = token', 1);
  expectOccurrences('redactMaestroArtifacts(output, secrets)', 1);
}

describe('Android legacy SSO migration', () => {
  it('pins all three predecessor spans and their 4 + 4 + 15 assertion shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '04bf21437efd4da47398e93df607bf35dbcd8aba00159607a9a95f96ca6e9b12',
    );
    const sso = sourceLines(
      ssoHelperSource,
      'e669c3b588e788c37fab77a7e427a38286de46cffafb228fcf27ae32c70a99b3',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const dex = sourceLines(
      dexSource,
      'b994b7e7c7de5fc103079b82d379a3dd8d022a1468796d6f8f35628c55c585d5',
    );

    expect(predecessor[28]).toContain(
      "test('signs in through the provider and keeps the session'",
    );
    expect(predecessor[75]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(28, 76))).toBe(4);
    expect(predecessor[77]).toContain(
      "test('refuses a callback it cannot verify, and does not spend the token'",
    );
    expect(predecessor[106]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(77, 107))).toBe(4);
    expect(predecessor[108]).toContain(
      "test('ignores a forged callback mid-sign-in without breaking the real one'",
    );
    expect(predecessor[197]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(108, 198))).toBe(15);

    const first = predecessor.slice(28, 76).join('\n');
    expect(first).toContain("name: 'Continue with SSO'");
    expect(first).toContain("name: 'Sign in'");
    expect(first).toContain("getByTestId('oidc-continue')");
    expect(first).toContain("getByTestId('rail-rooms')");
    const second = predecessor.slice(77, 107).join('\n');
    expect(second).toContain(
      'callback(`loginToken=${encodeURIComponent(stolen)}&sso_state=forged`)',
    );
    expect(second).toContain("getByText('could not be verified')");
    expect(second).toContain("name: 'Back to sign in'");
    expect(second).toContain('redeemLoginToken(request, hs, stolen)');
    const third = predecessor.slice(108, 198).join('\n');
    expect(third).toContain("getByText('Completing sign in…')");
    expect(third).toContain("locator('.login-card__wordmark')");
    expect(third).toContain("locator('.login-card')");
    expect(third).toContain("locator('main')");
    expect(third).toContain("getByTestId('sso-callback-body')");

    const helperText = sso.join('\n');
    expect(helperText).toContain("locator('#login')");
    expect(helperText).toContain("locator('#password')");
    expect(helperText).toContain("locator('#submit-login')");
    expect(helperText).toContain('/sso-harness-callback');
    expect(helperText).toContain("type: 'm.login.token'");
    expect(app.join('\n')).toContain('export interface SynapseSession');
    const dexText = dex.join('\n');
    expect(dexText).toContain('issuer: http://localhost:5556/dex');
    expect(dexText).toContain('email: sso-e2e@trinity.test');
    expect(dexText).toContain('username: sso-e2e');
  });

  it('exports the exact source map and all 23 unique identities', async () => {
    expect(contractPath, 'legacy-sso-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.LEGACY_SSO_SOURCES).toEqual({
      signIn: `${predecessorSource}:29-76`,
      unverified: `${predecessorSource}:78-107`,
      inFlight: `${predecessorSource}:109-198`,
      ssoHelper: ssoHelperSource,
      app: appSource,
      dex: dexSource,
    });
    expect(Object.values(contract.legacySsoAssertions.signIn)).toEqual(
      signInAssertions,
    );
    expect(Object.values(contract.legacySsoAssertions.unverified)).toEqual(
      unverifiedAssertions,
    );
    expect(Object.values(contract.legacySsoAssertions.inFlight)).toEqual(
      inFlightAssertions,
    );
    const actual = Object.values(contract.legacySsoAssertions).flatMap(
      Object.values,
    );
    expect(actual).toEqual(assertionIds);
    expect(new Set(actual).size).toBe(23);
  });

  it('uses a real Chrome Custom Tab and Maestro for the pinned Dex form', () => {
    const provider = readIfPresent(providerPath);
    const flow = readIfPresent(dexFlowPath);
    const chromeSetupFlow = readIfPresent(chromeSetupFlowPath);
    const dexReadyFlow = readIfPresent(dexReadyFlowPath);
    expect(provider, 'legacy-sso-provider.mts must exist').not.toBe('');
    expect(flow, 'legacy-sso-dex.yaml must exist').not.toBe('');
    expect(chromeSetupFlow, 'legacy-sso-chrome-setup.yaml must exist').not.toBe(
      '',
    );
    expect(dexReadyFlow, 'legacy-sso-dex-ready.yaml must exist').not.toBe('');
    expect(provider).toContain("const CHROME_PACKAGE = 'com.android.chrome'");
    expect(provider).toContain('/data/local/tmp/chrome-command-line');
    expect(provider).toContain('--disable-fre');
    expect(provider).toContain('--ignore-certificate-errors');
    expect(provider).toContain('--host-resolver-rules=MAP localhost 127.0.0.1');
    expect(provider).toContain("'pm', 'clear', CHROME_PACKAGE");
    expect(provider).toContain("'am', 'force-stop', CHROME_PACKAGE");
    expect(provider).toContain('uiautomator');
    expect(provider).toContain('legacy-sso-dex.yaml');
    expect(provider).toContain('legacy-sso-chrome-setup.yaml');
    expect(provider).toContain('legacy-sso-dex-ready.yaml');
    expect(provider).toContain('device.runFlow(');
    expect(provider).toContain('DEX_EMAIL_SECRET');
    expect(provider).toContain('DEX_PASSWORD');
    expect(provider).toContain('removeChromeCommandLine');
    expect(provider).toContain('throw new AggregateError(');
    expect(flow).toContain('appId: com.android.chrome');
    expect(flow).not.toContain('androidWebViewHierarchy: devtools');
    expect(flow).toContain('inputText: ${DEX_EMAIL_SECRET}');
    expect(flow).toContain('inputText: ${DEX_PASSWORD}');
    expect(flow).toContain('id: submit-login');
    expect(chromeSetupFlow).toContain('appId: com.android.chrome');
    expect(chromeSetupFlow).toContain('Use without an account');
    expect(chromeSetupFlow).toContain('Accept & continue');
    expect(chromeSetupFlow).toContain('No thanks');
    expect(dexReadyFlow).toContain('appId: com.android.chrome');
    expect(dexReadyFlow).toContain('androidWebViewHierarchy: devtools');
    expect(dexReadyFlow).toContain('Your connection is not private');
    expect(dexReadyFlow).toContain("tapOn: 'Advanced'");
    expect(dexReadyFlow).toContain('Proceed to localhost.*');
    expect(dexReadyFlow).toContain('id: login');
    expect(dexReadyFlow).toContain('id: password');
    expect(dexReadyFlow).toContain('id: submit-login');
    for (const mutation of forbiddenDomActions) {
      expect(provider).not.toMatch(mutation);
    }
    expect(provider).not.toMatch(/playwright|AndroidDevice|launchBrowser/u);
  });

  it('implements three native stages and records the exact direct identities', () => {
    const journey = readIfPresent(journeyPath);
    const accountClient = readIfPresent(accountClientPath);
    expect(journey, 'legacy-sso-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('legacy-sso-contract.mts');
    expect(journey).toContain('legacy-sso-provider.mts');
    expect(journey).toContain('LEGACY_SSO_SOURCES.signIn');
    expect(journey).toContain('LEGACY_SSO_SOURCES.unverified');
    expect(journey).toContain('LEGACY_SSO_SOURCES.inFlight');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toContain('DESKTOP_ACCOUNT_PROFILE');
    expect(journey).toContain("id: 'provider-sign-in-and-persistence'");
    expect(journey).toContain("id: 'unverifiable-callback-unspent-token'");
    expect(journey).toContain("id: 'inflight-forged-callback-recovery'");
    expect(journey).toContain("client.focusCurrent('#homeserver')");
    expect(journey).not.toContain("client.tapCurrent('#homeserver')");
    expect(journey).toContain("client.fillFocused('#homeserver'");
    expect(accountClient).toMatch(
      /async focusCurrent\([\s\S]*?allowFocusTransition: true/u,
    );
    expect(accountClient).toMatch(
      /assert\.equal\(\s*initiallyFocused,\s*false,\s*`Native input \$\{actionId\} began unfocused \$\{selector\}`/u,
    );
    expect(journey).toContain(
      "client.tapCurrent('button', { exactText: 'Continue' })",
    );
    expect(journey).toContain("exactText: 'Continue with SSO'");
    expect(journey).toContain('completeDexSignIn(');
    expect(journey).toContain('client.relaunch(');
    expect(journey).toMatch(/'am',\s*'start',\s*'-W'/u);
    expect(journey).toContain("'android.intent.action.VIEW'");
    expect(journey).toContain('shellQuote(callback.href)');
    expect(journey).toMatch(/'-p',\s*TRINITY_PACKAGE/u);
    expect(journey).toContain('eu.qwky.trinity://sso-callback');
    expect(journey).toContain("type: 'm.login.token'");
    expect(journey).toContain('/_matrix/client/v3/logout');
    expect(journey).toContain('expectedUserId');
    expect(journey).toContain(
      "join(\n              client.workspaceRoot,\n              'e2e/android/flows/native-shell-back.yaml'",
    );
    expect(journey).toContain('new Set<LegacySsoAssertion>()');
    expect(journey).toContain('assert(!recorded.has(identity)');
    expect(journey).toContain('expectedAssertions: 23');
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toContain("await client.capture('failed')");
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const group of ['signIn', 'unverified', 'inFlight']) {
      for (const key of Object.keys(
        group === 'signIn'
          ? Object.fromEntries(signInAssertions.map((id) => [id, id]))
          : group === 'unverified'
            ? Object.fromEntries(unverifiedAssertions.map((id) => [id, id]))
            : Object.fromEntries(inFlightAssertions.map((id) => [id, id])),
      )) {
        expect(key).toContain('legacy-sso.');
      }
      expect(journey).toContain(`assertions.${group}.`);
    }
    for (const mutation of forbiddenProductActions) {
      expect(journey).not.toMatch(mutation);
    }
    expect(journey).not.toMatch(
      /\bandroid\.(?:connect|devices?)\b|AndroidDevice|_androidDriver|launchBrowser/u,
    );
  });

  it('keeps the adversarial browser isolated and proves the token stayed unspent', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain("from 'playwright'");
    expect(journey).toContain('chromium.launch(');
    expect(journey).toContain("'/sso-harness-callback'");
    expect(journey).toContain("locator('#login')");
    expect(journey).toContain("locator('#password')");
    expect(journey).toContain("locator('#submit-login')");
    expect(journey).toContain('captured.token');
    expect(journey).toContain('await context?.close()');
    expect(journey).toContain('await browser?.close()');
    expect(journey).toContain('appTokenLoginRequests');
    expect(journey).toMatch(/assert\.equal\(appTokenLoginRequests, 0/u);
    expect(journey).toMatch(/assert\.equal\(redeemed\.userId, expectedUserId/u);
    expect(journey).toContain('finally');
    expect(journey).toContain('await revokeMatrixSession(');
    expect(journey).not.toMatch(/page\.goto\([^\n]*\/sso-callback/u);
    const inFlight = journey.slice(
      journey.indexOf("id: 'inflight-forged-callback-recovery'"),
    );
    const firstLegitimate = inFlight.indexOf('await startLegitimateSso(');
    const mint = inFlight.indexOf('await mintUnspentLoginToken(');
    const redemption = inFlight.indexOf('await redeemAndRevoke(');
    const secondLegitimate = inFlight.indexOf(
      'await startLegitimateSso(',
      firstLegitimate + 1,
    );
    expect(firstLegitimate).toBeGreaterThanOrEqual(0);
    expect(mint).toBeGreaterThan(firstLegitimate);
    expect(redemption).toBeGreaterThan(mint);
    expect(secondLegitimate).toBeGreaterThan(redemption);
  });

  it('proves host persistence plus the silent in-flight callback geometry', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('client.visible(\'[data-testid="rail-rooms"]\'');
    expect(journey).toContain("client.expectCount('#homeserver', 0)");
    expect(journey).toContain("exactText: 'Completing sign in…'");
    expect(journey).toContain("client.visible('.login-card__wordmark')");
    expect(journey).toContain("assert.equal(wordmark.text, 'Trinity')");
    expect(journey).toContain(
      "client.expectCount('h1, h2, h3, h4, h5, h6', 1)",
    );
    expect(journey).toContain("client.expectCount('main', 1)");
    expect(journey).toContain("client.visible('.login-card')");
    expect(journey).toContain('\'[data-testid="sso-callback-body"]\'');
    expect(journey).toMatch(/card\.rect\.width >= 400/u);
    expect(journey).toMatch(/card\.rect\.width <= 480/u);
    expect(journey).toMatch(/card\.rect\.x >= 0/u);
    expect(journey).toMatch(/card\.rect\.right <= viewport\.rect\.width/u);
    expect(journey).toMatch(/body\.rect\.x > card\.rect\.x \+ 8/u);
    expect(journey).toContain("text: 'could not be verified'");
    expect(journey).toContain(
      "!new URL(surface.url).pathname.startsWith('/rooms')",
    );
    expect(journey).toMatch(
      /await startLegitimateSso[\s\S]*await secondProvider\.completeDexSignIn[\s\S]*await waitForRooms/u,
    );
  });

  it('redacts provider credentials, login tokens, state, and Matrix access tokens', async () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('secrets.DEX_EMAIL_SECRET = sso.email');
    expect(journey).toContain('secrets.DEX_PASSWORD = sso.pass');
    expect(journey).toContain('secrets.LOGIN_TOKEN');
    expect(journey).toContain('secrets.SSO_STATE_SECRET_');
    expect(journey).toContain('secrets[accessTokenKey]');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).not.toMatch(
      /observation:\s*(?:loginToken|accessToken|state|password|email)/u,
    );

    const directory = await mkdtemp(join(tmpdir(), 'trinity-legacy-sso-'));
    const secrets = {
      DEX_EMAIL_SECRET: 'sso-negative@trinity.test',
      DEX_PASSWORD: 'provider-negative-password',
      LOGIN_TOKEN: 'matrix-login-token-negative',
      SSO_STATE_SECRET: 'state-negative-control',
      ACCESS_TOKEN: 'syt_negative_control_token',
    };
    const artifact = join(directory, 'provider.log');
    try {
      await writeFile(artifact, Object.values(secrets).join('\n'));
      await redactMaestroArtifacts(directory, secrets);
      const redacted = await readFile(artifact, 'utf8');
      for (const secret of Object.values(secrets)) {
        expect(redacted).not.toContain(secret);
      }
      expect(redacted.match(/\[REDACTED\]/gu)).toHaveLength(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses finite observation and aggregate cleanup for every owned resource', () => {
    const provider = readIfPresent(providerPath);
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('AbortSignal.timeout(15_000)');
    expect(journey).toContain('AbortSignal.timeout(60_000)');
    expect(journey).toContain('await tokenObserver.close()');
    expect(journey).toContain('await provider.close()');
    expect(journey).toContain('await client.close()');
    expect(journey).toContain('device.close()');
    expect(journey).toContain('throw new AggregateError(');
    expect(provider).toContain('AbortSignal.timeout(240_000)');
    expect(provider).toContain('throw new AggregateError(');
  });

  it('rejects all eight required legacy SSO contract weakenings', () => {
    const journey = readIfPresent(journeyPath);
    const controls = [
      {
        id: 'legacy/delegated action classification drift',
        before: `client.expectCount('[data-testid="oidc-continue"]', 0)`,
        after: `client.expectCount('[data-testid="oidc-continue"]', 1)`,
        occurrences: 1,
      },
      {
        id: 'session persistence loss',
        before: 'await client.relaunch(PIXEL_5_ACCOUNT_PROFILE)',
        after: 'await client.launch(PIXEL_5_ACCOUNT_PROFILE)',
        occurrences: 1,
      },
      {
        id: 'forged-state acceptance',
        before: "assert(!new URL(surface.url).pathname.startsWith('/rooms'))",
        after: "assert(new URL(surface.url).pathname.startsWith('/rooms'))",
        occurrences: 2,
      },
      {
        id: 'token-consumption weakening',
        before: 'assert.equal(appTokenLoginRequests, 0)',
        after: 'assert.equal(appTokenLoginRequests, 1)',
        occurrences: 2,
      },
      {
        id: 'in-flight stash loss',
        before: 'secrets.SSO_STATE_SECRET_2 = await readPersistedSsoState',
        after: 'secrets.SSO_STATE_SECRET_2 = await forgetPersistedSsoState',
        occurrences: 1,
      },
      {
        id: 'callback geometry/accessibility weakening',
        before: 'assert(card.rect.width >= 400)',
        after: 'assert(card.rect.width >= 399)',
        occurrences: 1,
      },
      {
        id: 'cleanup loss',
        before: 'await tokenObserver.close()',
        after: 'await Promise.resolve()',
        occurrences: 3,
      },
      {
        id: 'redaction loss',
        before: 'secrets.LOGIN_TOKEN_1 = token',
        after: 'void token',
        occurrences: 1,
      },
    ];

    expect(() => assertProtectedRuntimeContract(journey)).not.toThrow();
    for (const control of controls) {
      expect(
        journey.split(control.before).length - 1,
        `${control.id} fixture occurrence count`,
      ).toBe(control.occurrences);
      const mutated = journey.replace(control.before, control.after);
      expect(
        () => assertProtectedRuntimeContract(mutated),
        control.id,
      ).toThrow();
    }
  });

  it('registers one bounded uncached Nx suite and package command', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['legacy-sso'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain('--suite=android.legacy-sso');
    expect(target.options.command).toContain('--timeout-ms=1200000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/legacy-sso-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:legacy-sso']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:legacy-sso',
    );
  });

  it('registers Chrome plus Maestro and a started-only hosted artifact', () => {
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.legacy-sso'");
    expect(runners).toContain("'chrome'");
    expect(runners).toContain("'maestro'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:legacy-sso'",
    );
    expect(runners).toContain("canonicalScript: 'e2e:android:legacy-sso'");
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/legacy-sso-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:legacy-sso'");
    expect(commands).toContain("suiteIds: ['android.legacy-sso']");
    expect(workflow).toContain('legacy-sso-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:legacy-sso',
    );
    expect(workflow).toContain('surface: android-legacy-sso');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.legacy-sso/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.legacy-sso-started == 'true'/u,
    );
    expect(workflow.indexOf('legacy-sso-started=true')).toBeLessThan(
      workflow.indexOf('native-shell-started=true'),
    );
    const ciCommands = commands.slice(
      commands.indexOf('export const E2E_CI_ENTRYPOINTS'),
    );
    expect(ciCommands.indexOf("suiteIds: ['android.legacy-sso']")).toBeLessThan(
      ciCommands.indexOf("suiteIds: ['android.native-shell']"),
    );
  });

  it('documents parity and retains the exact predecessors', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Legacy SSO journeys');
    expect(migration).toContain('`android.legacy-sso`');
    expect(migration).toContain(
      '04bf21437efd4da47398e93df607bf35dbcd8aba00159607a9a95f96ca6e9b12',
    );
    expect(migration).toContain('23 assertion identities');
    expect(migration).toContain('Chrome Custom Tab');
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain("path: 'journeys/accounts/sso-login.spec.mts'");
    const predecessor = read(predecessorSource);
    expect(predecessor).toContain(
      "test('signs in through the provider and keeps the session'",
    );
    expect(predecessor).toContain(
      "test('refuses a callback it cannot verify, and does not spend the token'",
    );
    expect(predecessor).toContain(
      "test('ignores a forged callback mid-sign-in without breaking the real one'",
    );
  });
});
