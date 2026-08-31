// Headless smoke test for the auth flow (no credentials needed):
//  1. unauthenticated load redirects to /login
//  2. real .well-known discovery for matrix.org resolves the homeserver
//  3. the discovered flows surface the password form + SSO button
import { applicationOrigin } from '../support/session.mts';
import { chromium } from 'playwright';

const APP = applicationOrigin();
// SPA fallback so deep links resolve to index.html.

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page:error] ${e.message}`));

let exit = 1;
try {
  await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
  await page.waitForURL('**/login', { timeout: 15000 });
  console.log('PASS: redirected to /login when unauthenticated');

  await page.getByText('Continue', { exact: true }).click();

  // Discovery resolving the DELEGATED host is the whole point: `matrix.org` publishes a
  // .well-known pointing at `matrix-client.matrix.org`, so seeing the second one proves the
  // lookup ran rather than the typed value being echoed back. Asserted on that host rather
  // than on the surrounding copy — this used to grep for a "Homeserver: " prefix the page
  // stopped rendering, so the test failed for thirty seconds against a working app.
  const hsLine = page.getByText(/https:\/\/matrix-client\.matrix\.org/);
  await hsLine.waitFor({ timeout: 30000 });
  console.log(`PASS: discovered ${(await hsLine.innerText()).trim()}`);

  // Whatever the homeserver offers. matrix.org is OIDC now (MSC3861), so the old
  // password/SSO pair alone would report "no login options" on a page showing two buttons.
  const visible = async (locator) => locator.isVisible().catch(() => false);
  const hasOidc = await visible(page.getByTestId('oidc-continue'));
  const hasPassword = await visible(
    page.getByRole('button', { name: 'Sign in' }),
  );
  const hasSso = await visible(page.getByRole('button', { name: /SSO/ }));
  console.log(
    `login options -> oidc: ${hasOidc}, password: ${hasPassword}, sso: ${hasSso}`,
  );

  if (hasOidc || hasPassword || hasSso) {
    console.log('\nRESULT: PASS');
    exit = 0;
  } else {
    console.log('\nRESULT: FAIL (no login options surfaced)');
  }
} catch (err) {
  console.error('smoke error:', err.message);
} finally {
  await browser.close();
  process.exit(exit);
}
