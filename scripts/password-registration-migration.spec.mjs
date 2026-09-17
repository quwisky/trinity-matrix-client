import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource = 'e2e/browser/journeys/accounts/registration.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(
  root,
  'e2e/android/password-registration-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/password-registration-journeys.mts',
);
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const assertionIds = [
  'password-registration.availability-action-visible',
  'password-registration.registration-route',
  'password-registration.encryption-setup-route',
  'password-registration.exact-mxid',
];
const forbiddenProductMutations = [
  /\.click\s*\(/u,
  /\.focus\s*\(/u,
  /\.dispatchEvent\s*\(/u,
  /\.(?:requestSubmit|submit)\s*\(/u,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/u,
  /\blocation\.(?:assign|replace|reload)\s*\(/u,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/u,
  /\bwindow\.open\s*\(/u,
  /client\.(?:focusFixture|navigate|reload)\s*\(/u,
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

describe('Android password-registration migration', () => {
  it('pins the exact predecessor and helper-owned assertion shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      'a22f58f703c185645987ad471c2f8637d2741344be365d5063c8f0b1c37f2dbd',
    );
    const app = sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    const account = sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[9]).toContain(
      "test('creates a password account through UIA and enters encryption setup'",
    );
    expect(predecessor[47]).toBe('  });');
    expect(assertionSiteCount(predecessor.slice(9, 48))).toBe(2);
    expect(predecessor.slice(9, 48).join('\n')).toContain(
      "page.getByTestId('password-register')",
    );
    expect(predecessor.slice(9, 48).join('\n')).toContain(
      "page.waitForURL('**/register?**')",
    );
    expect(predecessor.slice(9, 48).join('\n')).toContain(
      "page.waitForURL('**/encryption/setup'",
    );
    expect(predecessor.slice(9, 48).join('\n')).toContain(
      'expect(account.userId).toBe(`@${username}:localhost`)',
    );
    expect(app[123]).toContain('export interface SynapseSession');
    expect(app[165]).toBe('}');
    expect(app.slice(123, 166).join('\n')).toContain(
      'export async function fillLabeledInput',
    );
    expect(account[56]).toContain(
      'Log in over the CS API, for the assertions a spec has to make as the server sees them.',
    );
    expect(account[78]).toBe('}');
    expect(account.slice(56, 79).join('\n')).toContain(
      "type: 'm.login.password'",
    );
  });

  it('exports the exact source map and four stable identities', async () => {
    expect(
      existsSync(contractPath),
      'password-registration-contract.mts must exist',
    ).toBe(true);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.PASSWORD_REGISTRATION_SOURCES).toEqual({
      journey: `${predecessorSource}:10-48`,
      app: `${appSource}:124-166`,
      account: `${accountSource}:57-79`,
    });
    expect(Object.values(contract.passwordRegistrationAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.passwordRegistrationAssertions)).size,
    ).toBe(4);
  });

  it('implements one native stage with the exact route and identity proofs', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'password-registration-journeys.mts must exist').not.toBe(
      '',
    );
    expect(journey).toContain('password-registration-contract.mts');
    expect(journey).toContain('PASSWORD_REGISTRATION_SOURCES.journey');
    expect(journey).toContain('profile: PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /client\.visible\(\s*'\[data-testid="password-register"\]'/u,
    );
    expect(journey).toContain("client.fillFocused('#homeserver'");
    expect(journey).toContain(
      "client.tapCurrent('button', { exactText: 'Continue' })",
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="password-register"]\')',
    );
    expect(journey).toContain("client.fillFocused('#registration-username'");
    expect(journey).toContain("client.fillFocused('#registration-password'");
    expect(journey).toContain(
      "client.fillFocused('#registration-confirm-password'",
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="register-submit"]\')',
    );
    expect(journey).toContain(
      "assert.equal(registration.pathname, '/register')",
    );
    expect(journey).toContain(
      "assert.equal(registration.searchParams.get('homeserver'), homeserver)",
    );
    expect(journey).toContain(
      "assert.equal(encryptionSetup.pathname, '/encryption/setup')",
    );
    expect(journey).toContain(
      'assert.equal(login.userId, `@${username}:localhost`)',
    );
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
    for (const key of [
      'availabilityActionVisible',
      'registrationRoute',
      'encryptionSetupRoute',
      'exactMxid',
    ]) {
      expect(journey).toMatch(
        new RegExp(
          `recordAssertion\\([\\s\\S]*?assertions\\.${key}[,\\)]`,
          'u',
        ),
      );
    }
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('makes the availability gate observable and rejects account-creation bypasses', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('Network.enable');
    expect(journey).toContain('Network.requestWillBeSent');
    expect(journey).toContain('Network.responseReceived');
    expect(journey).toContain('/_matrix/client/v3/register/available');
    expect(journey).toContain('request.url.origin === expectedOrigin');
    expect(journey).toContain('response.url.origin === expectedOrigin');
    expect(journey).toContain('initiallyAbsent: true');
    expect(journey).toContain('requestPath: availability.requestPath');
    expect(journey).toContain('status: availability.status');
    expect(journey).toContain('visible: registrationAction.visible');
    expect(journey).toMatch(/availability\.status >= 200/u);
    expect(journey).toMatch(/availability\.status < 300/u);
    expect(journey).not.toMatch(/_synapse\/admin\/v1\/register/u);
    expect(journey).not.toMatch(/registrationSecret|shared.?secret/iu);
    expect(journey).not.toMatch(
      /fetch\([^\n]*\/_matrix\/client\/v3\/register(?:['"?`])/u,
    );
  });

  it('keeps credentials private and revokes the observation session', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toMatch(/\/_matrix\/client\/v3\/login/u);
    expect(journey).toMatch(/\/_matrix\/client\/v3\/logout/u);
    expect(journey).toContain("type: 'm.login.password'");
    expect(journey).toContain(
      "identifier: { type: 'm.id.user', user: username }",
    );
    expect(journey).toContain('AbortSignal.timeout(15_000)');
    expect(journey).toMatch(/finally\s*\{/u);
    expect(journey).toContain('await revokeObservationSession(');
    expect(journey).toContain('secrets.PASSWORD = password');
    expect(journey).toContain('secrets.ACCESS_TOKEN = login.accessToken');
    expect(journey).toContain('redactMaestroArtifacts(output, secrets)');
    expect(journey).not.toMatch(
      /observation:\s*(?:password|accessToken|responseBody)/u,
    );
  });

  it('records one stage, four assertions, captures, and bounded cleanup', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey).toContain('new Set<PasswordRegistrationAssertion>()');
    expect(journey).toContain('assert(!recorded.has(identity)');
    expect(journey).toContain(
      'expectedAssertions: Object.keys(assertions).length',
    );
    expect(journey).toContain("await client.capture('passed')");
    expect(journey).toContain("await client.capture('failed')");
    expect(journey).toContain('await availabilityObserver.close()');
    expect(journey).toContain('await client.close()');
    expect(journey).toContain('device.close()');
    expect(journey).toContain('throw new AggregateError(');
  });

  it('registers one bounded uncached Nx suite and package command', () => {
    const project = JSON.parse(read('e2e/android/project.json'));
    const target = project.targets['password-registration'];
    expect(target).toMatchObject({
      cache: false,
      parallelism: false,
      dependsOn: [{ projects: ['trinity-android'], target: 'build-prebuilt' }],
    });
    expect(target.options.command).toContain(
      '--suite=android.password-registration',
    );
    expect(target.options.command).toContain('--timeout-ms=900000');
    expect(target.options.command).toContain(
      '--entrypoint=e2e/android/password-registration-journeys.mts',
    );
    expect(target.options.command).toContain('--resource=android-avd');
    expect(target.options.command).toContain('--resource=synapse');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['e2e:android:password-registration']).toBe(
      'node scripts/nx.mjs run trinity-e2e-android:password-registration',
    );
  });

  it('registers the suite and started-only hosted artifact', () => {
    const runners = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    expect(runners).toContain("id: 'android.password-registration'");
    expect(runners).toContain(
      "currentTarget: 'trinity-e2e-android:password-registration'",
    );
    expect(runners).toContain(
      "canonicalScript: 'e2e:android:password-registration'",
    );
    expect(runners).toContain(
      "sourceEntrypoints: ['e2e/android/password-registration-journeys.mts']",
    );
    expect(commands).toContain("name: 'e2e:android:password-registration'");
    expect(commands).toContain("suiteIds: ['android.password-registration']");
    expect(workflow).toContain('password-registration-started=true');
    expect(workflow).toContain(
      'pnpm exec nx run trinity-e2e-android:password-registration',
    );
    expect(workflow).toContain('surface: android-password-registration');
    expect(workflow).toContain(
      'report-path: dist/.playwright/trinity-e2e-android/*/android.password-registration/**',
    );
    expect(workflow).toMatch(
      /!cancelled\(\).*steps\.android\.outputs\.password-registration-started == 'true'/u,
    );
  });

  it('documents parity and keeps the exact predecessor enabled', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const catalog = read('e2e/browser/journey-catalog.mts');
    expect(migration).toContain('## Password registration journey');
    expect(migration).toContain('`android.password-registration`');
    expect(migration).toContain(
      'a22f58f703c185645987ad471c2f8637d2741344be365d5063c8f0b1c37f2dbd',
    );
    expect(migration).toContain('`m.login.dummy`');
    expect(migration).toContain('four assertion identities');
    expect(migration).toMatch(/Do not\s+retire/u);
    expect(catalog).toContain(
      "path: 'journeys/accounts/registration.spec.mts'",
    );
    expect(read(predecessorSource)).toContain(
      "test('creates a password account through UIA and enters encryption setup'",
    );
  });
});
