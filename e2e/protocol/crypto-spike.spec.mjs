// Headless validation of the in-app E2EE crypto spike in the engine selected by
// the registered protocol suite (Chromium or WebKit).
import { test, expect } from './fixtures.mts';

test('runs the in-app crypto spike', async ({ page }, testInfo) => {
  let exitCode = 1;
  console.log(`engine: ${testInfo.project.use.browserName}`);
  page.on('console', (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`  [page:error] ${e.message}`));

  await page.goto('/spike', {
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
  expect(exitCode).toBe(0);
});
