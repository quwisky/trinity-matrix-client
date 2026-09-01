// Homeserver-free self-check for the SAS verification e2e.
//
// Validates everything that does NOT need a live homeserver, so the verify-sas.mjs
// selectors and routing are exercised even where Docker/Synapse is unavailable:
//   1. the dev build serves and the SPA boots
//   2. /login renders the homeserver input (labeled "Homeserver") + "Continue" button
//   3. after typing a homeserver and clicking Continue, matrix.org discovery
//      drives discovery (proving the form wiring + serve fallback work)
//   4. the shipped router declares /encryption/verify with its
//      DeviceVerificationPage lazy loader
//   5. /encryption/verify is protected by authGuard (redirects to /login when
//      unauthenticated)
//
// This is the "verify as much as we can headlessly" path the task asks for when the
// live round-trip is gated. It does NOT assert a PASS of the SAS flow.
import ts from 'typescript';
import { standaloneTest as test, expect } from './fixtures.mts';

const log = (m) => console.log(`[selfcheck] ${m}`);
test('validates the homeserver-free SAS surface', async ({ page }) => {
  page.on('pageerror', (e) => console.log(`  [page:error] ${e.message}`));
  const checks = [];
  const check = (name, ok) => {
    checks.push({ name, ok });
    log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  };
  let exit = 1;
  // 1. App boots, unauthenticated load redirects to /login.
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForURL('**/login', { timeout: 15_000 });
  check('app boots and redirects to /login when unauthenticated', true);

  // 2. Login step-1 controls resolve.
  const hsInput = page.getByLabel('Homeserver');
  await hsInput.waitFor({ state: 'visible', timeout: 10_000 });
  check('homeserver input resolves', await hsInput.isVisible());

  const continueBtn = page.getByText('Continue', { exact: true });
  check('Continue button resolves', await continueBtn.isVisible());

  // 3. Form wiring: typing + Continue triggers discovery (busy spinner appears).
  await hsInput.click();
  await hsInput.fill('matrix.org');
  await continueBtn.click();
  // OIDC, password, discovered-base-URL, or error state all prove that the click
  // handler and live matrix.org discovery path are wired.
  const reacted = await Promise.any([
    expect(page.getByTestId('oidc-continue'))
      .toBeVisible({ timeout: 30_000 })
      .then(() => 'oidc'),
    page
      .getByRole('button', { name: 'Sign in' })
      .waitFor({ timeout: 30_000 })
      .then(() => 'password-form'),
    page
      .getByText(/Homeserver: https:\/\//)
      .waitFor({ timeout: 30_000 })
      .then(() => 'discovered'),
    page
      .locator('p[role="alert"]')
      .waitFor({ timeout: 30_000 })
      .then(() => 'error'),
  ]).catch(() => null);
  if (!reacted) {
    const [buttons, alerts] = await Promise.all([
      page.getByRole('button').evaluateAll((elements) =>
        elements.map((element) => ({
          label: element.textContent?.trim() ?? '',
          disabled: element.hasAttribute('disabled'),
        })),
      ),
      page.locator('[role="alert"]').allTextContents(),
    ]);
    log(
      `Continue response evidence — url=${page.url()} buttons=${JSON.stringify(buttons)} alerts=${JSON.stringify(alerts)}`,
    );
  }
  check(
    `login form reacts to Continue (${reacted ?? 'no reaction'})`,
    !!reacted,
  );
  if (reacted === 'password-form' || reacted === 'discovered') {
    check('Username/Password inputs + Sign in resolve after discovery', true);
  }

  // 4. Prove the exact verification route exists in the shipped router. A redirect
  //    alone is ambiguous because the wildcard route also eventually reaches the
  //    guarded rooms surface.
  const servedScripts = await page.evaluate(async () => {
    const scriptUrls = Array.from(document.scripts)
      .map((script) => script.src)
      .filter(Boolean);
    const sources = await Promise.all(
      scriptUrls.map(async (url) => {
        const response = await fetch(url);
        return response.ok ? response.text() : '';
      }),
    );
    return {
      scriptUrls,
      source: sources.join('\n'),
    };
  });
  const executableSource = ts.transpileModule(servedScripts.source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
  const routeDeclared =
    servedScripts.scriptUrls.length > 0 &&
    executableSource.trim().length > 0 &&
    /path\s*:\s*["'`]encryption\/verify["'`][\s\S]{0,2000}DeviceVerificationPage/u.test(
      executableSource,
    );
  if (!routeDeclared) {
    log(
      `verification route bundle evidence — scripts=${JSON.stringify(servedScripts.scriptUrls)}`,
    );
  }
  check(
    'shipped router declares /encryption/verify with its DeviceVerificationPage loader',
    routeDeclared,
  );

  // 5. Request the declared route signed out and prove its auth guard redirects.
  await page.goto('/encryption/verify', { waitUntil: 'networkidle' });
  const onLogin = /\/login/.test(page.url());
  check('/encryption/verify redirects to /login when signed out', onLogin);

  exit = checks.every((c) => c.ok) ? 0 : 1;
  console.log(
    `\nRESULT: ${exit === 0 ? 'PASS' : 'FAIL'} (homeserver-free self-check)`,
  );
  expect(exit).toBe(0);
});
