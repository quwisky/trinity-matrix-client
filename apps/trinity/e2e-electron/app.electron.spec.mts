import { test, expect, type Page } from '@playwright/test';
import { type ElectronApplication } from 'playwright';
import { launchApp } from './support/launch.mts';

// One Electron instance for the whole file (launching is expensive).
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('boots the app over the trinity:// custom scheme', async () => {
  // Served via the privileged trinity://app scheme (secure context), not file://.
  await expect.poll(() => page.evaluate(() => location.origin)).toBe(
    'trinity://app',
  );
  // Unauthenticated → the login screen renders (proves the SPA + assets loaded).
  await expect(page.locator('ion-input[label="Homeserver"]')).toBeVisible();
});

test('initializes without renderer crashes (crypto WASM loads)', async () => {
  // A WASM/init failure surfaces as a pageerror; assert none fired and the app
  // shell is interactive.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('Continue', { exact: true }).waitFor();
  expect(errors).toEqual([]);
});

test('exposes the desktop bridge but no Node in the renderer', async () => {
  const isElectron = await page.evaluate(
    () =>
      (globalThis as { trinityDesktop?: { isElectron?: boolean } })
        .trinityDesktop?.isElectron,
  );
  expect(isElectron).toBe(true);

  // contextIsolation + nodeIntegration:false + sandbox → no Node reachable.
  const exposure = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    onDeepLink: typeof (
      globalThis as { trinityDesktop?: { onDeepLink?: unknown } }
    ).trinityDesktop?.onDeepLink,
  }));
  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.onDeepLink).toBe('function'); // the SSO deep-link bridge
});

test('dark palette wins the cascade when ion-palette-dark is set (regression)', async () => {
  // Regression for the desktop dark-theme bug: the class lands on <html>, but the
  // dark tokens must actually beat the light :root in the real Electron renderer.
  const result = await page.evaluate(() => {
    const html = document.documentElement;
    const railVar = () =>
      getComputedStyle(html).getPropertyValue('--trinity-rail').trim();
    html.classList.remove('ion-palette-dark');
    const light = railVar();
    html.classList.add('ion-palette-dark');
    const dark = railVar();
    return { light, dark };
  });
  expect(result.light).toBe('#e3e5e8'); // :root light default
  expect(result.dark).toBe('#1e1f22'); // :root.ion-palette-dark wins
});
