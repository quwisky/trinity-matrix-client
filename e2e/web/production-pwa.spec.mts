import { expect, test } from '@playwright/test';

const CRYPTO_WASM = '/assets/crypto/matrix_sdk_crypto_wasm_bg.wasm';

async function ensureServiceWorkerControl(
  page: import('@playwright/test').Page,
) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (
    !(await page.evaluate(() => navigator.serviceWorker.controller !== null))
  ) {
    await page.reload();
  }
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
}

test('the production Web/PWA artifact starts, routes, and remains usable offline', async ({
  context,
  page,
}) => {
  await page.goto('/does-not-exist');

  // The production startup lifecycle settles before Router resolves the unknown deep link
  // through the authenticated Workspace entrypoint and on to the public sign-in screen.
  await expect(
    page.getByRole('heading', { name: 'Sign in to Trinity' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  const homeserver = page.getByPlaceholder('matrix.org');
  await homeserver.fill('example.org');
  await expect(homeserver).toHaveValue('example.org');

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return response.json() as Promise<{ name: string; display: string }>;
  });
  expect(manifest).toMatchObject({ name: 'Trinity', display: 'standalone' });

  await ensureServiceWorkerControl(page);
  const onlineWasmBytes = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return response.ok ? (await response.arrayBuffer()).byteLength : 0;
  }, CRYPTO_WASM);
  expect(onlineWasmBytes).toBeGreaterThan(1_000);

  await context.setOffline(true);
  await page.goto('/offline-deep-link', { waitUntil: 'domcontentloaded' });

  // The worker serves the shell and every lazy chunk; Router still repairs the URL and the
  // prefetched crypto module remains available for the first encrypted offline start.
  await expect(
    page.getByRole('heading', { name: 'Sign in to Trinity' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  const offlineWasmBytes = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return response.ok ? (await response.arrayBuffer()).byteLength : 0;
  }, CRYPTO_WASM);
  expect(offlineWasmBytes).toBe(onlineWasmBytes);
});
