// Headless validation of the in-app E2EE crypto spike.
// Serves the production build, drives the "Run crypto spike" button in Chromium
// (proxy for Android WebView / Electron renderer), and reports PASS/FAIL.
import { applicationOrigin } from '../support/session.mts';
import * as playwright from 'playwright';

// Engine to drive: chromium (≈ Android WebView / Electron) or webkit (≈ iOS WKWebView).
const engineName = process.argv[2] ?? 'chromium';
const engine = playwright[engineName];
if (!engine) {
  console.error(`unknown engine "${engineName}" (use chromium or webkit)`);
  process.exit(2);
}

const APP = applicationOrigin();
let browser;
let exitCode = 1;
try {
  console.log(`engine: ${engineName}`);
  browser = await engine.launch();
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`  [page:error] ${e.message}`));

  await page.goto(`${APP}/spike`, {
    waitUntil: 'networkidle',
  });
  await page.getByTestId('run-spike').click();
  const result = page.getByTestId('spike-result');
  await result.waitFor({ state: 'visible', timeout: 60000 });

  const ok = (await result.getAttribute('data-ok')) === 'true';
  console.log('\n--- spike result ---');
  console.log((await result.innerText()).trim());
  console.log('--------------------');
  exitCode = ok ? 0 : 1;
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} catch (err) {
  console.error('runner error:', err);
} finally {
  await browser?.close();
  process.exitCode = exitCode;
}
