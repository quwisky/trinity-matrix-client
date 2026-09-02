import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { seedPreference } from '../support/app.mts';

const CRYPTO_WASM = '/assets/crypto/matrix_sdk_crypto_wasm_bg.wasm';

async function ensureServiceWorkerControl(page: Page) {
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

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test('the production first paint follows system Mode without application assets', async ({
  page,
}, testInfo) => {
  await page.route(/\.(?:css|js)(?:\?.*)?$/, (route) => route.abort());
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const splash = page.locator('.trn-boot');
  await expect(splash).toBeVisible();
  await expect(splash).toHaveAttribute('role', 'status');
  const light = await splash.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      animation: getComputedStyle(element.querySelector('.trn-boot__mark')!)
        .animationName,
    };
  });
  expect(light.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(light.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(light.animation).toBe('trn-boot-pulse');
  await attachScreenshot(page, testInfo, 'first-paint-light.png');

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const dark = await splash.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      animation: getComputedStyle(element.querySelector('.trn-boot__mark')!)
        .animationName,
    };
  });
  expect(dark.background).not.toBe(light.background);
  expect(dark.color).not.toBe(light.color);
  expect(dark.animation).toBe('none');
  await attachScreenshot(page, testInfo, 'first-paint-dark.png');
});

test('untouched production Appearance follows system Mode', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in to Trinity' }),
  ).toBeVisible();

  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith('CapacitorStorage.trinity.appearance.'),
      ),
    ),
  ).toEqual([]);
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(page.locator('html')).not.toHaveAttribute('data-density');
  await expect(page.locator('html')).not.toHaveAttribute('style');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});

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

  await seedPreference(page, 'trinity.appearance.mode', 'dark');
  await seedPreference(page, 'trinity.appearance.theme', 'onyx');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: 'Sign in to Trinity' }),
  ).toBeVisible();
  const onlineAppearance = await page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      dark: root.classList.contains('dark'),
      theme: root.getAttribute('data-theme'),
      background: style.getPropertyValue('--trinity-surface-workspace').trim(),
      accent: style.getPropertyValue('--trinity-accent').trim(),
      text: style.getPropertyValue('--trinity-text').trim(),
    };
  });
  expect(onlineAppearance).toMatchObject({ dark: true, theme: 'onyx' });
  expect(onlineAppearance.background).not.toBe('');
  expect(onlineAppearance.accent).not.toBe('');
  expect(onlineAppearance.text).not.toBe('');

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
  expect(
    await page.evaluate(() => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      return {
        dark: root.classList.contains('dark'),
        theme: root.getAttribute('data-theme'),
        background: style
          .getPropertyValue('--trinity-surface-workspace')
          .trim(),
        accent: style.getPropertyValue('--trinity-accent').trim(),
        text: style.getPropertyValue('--trinity-text').trim(),
      };
    }),
  ).toEqual(onlineAppearance);
});
