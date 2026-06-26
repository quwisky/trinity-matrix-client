// Headless smoke test for the auth flow (no credentials needed):
//  1. unauthenticated load redirects to /login
//  2. real .well-known discovery for matrix.org resolves the homeserver
//  3. the discovered flows surface the password form + SSO button
import { serve } from './serve.mjs';
import { chromium } from 'playwright';

const PORT = 8124;
// SPA fallback so deep links resolve to index.html.
const server = await serve('www', PORT);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page:error] ${e.message}`));

let exit = 1;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForURL('**/login', { timeout: 15000 });
  console.log('PASS: redirected to /login when unauthenticated');

  await page.getByText('Continue', { exact: true }).click();

  // After discovery, the homeserver line and at least one login option appear.
  // (matrix.org's .well-known resolves to https://matrix-client.matrix.org.)
  const hsLine = page.getByText(/Homeserver: https:\/\//);
  await hsLine.waitFor({ timeout: 30000 });
  console.log(`PASS: discovered ${(await hsLine.innerText()).replace('Homeserver: ', '')}`);

  const hasPassword = await page.getByRole('button', { name: 'Sign in' }).isVisible();
  const hasSso = await page.getByRole('button', { name: /SSO/ }).isVisible();
  console.log(`login options -> password: ${hasPassword}, sso: ${hasSso}`);

  if (hasPassword || hasSso) {
    console.log('\nRESULT: PASS');
    exit = 0;
  } else {
    console.log('\nRESULT: FAIL (no login options surfaced)');
  }
} catch (err) {
  console.error('smoke error:', err.message);
} finally {
  await browser.close();
  server.close();
  process.exit(exit);
}
