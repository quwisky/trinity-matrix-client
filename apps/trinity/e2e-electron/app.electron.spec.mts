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
  const exposure = await page.evaluate(() => {
    const td = (
      globalThis as {
        trinityDesktop?: {
          onDeepLink?: unknown;
          showNotification?: unknown;
          onNotificationClick?: unknown;
          secureStore?: unknown;
        };
      }
    ).trinityDesktop;
    return {
      require: typeof (globalThis as Record<string, unknown>)['require'],
      process: typeof (globalThis as Record<string, unknown>)['process'],
      onDeepLink: typeof td?.onDeepLink,
      showNotification: typeof td?.showNotification,
      onNotificationClick: typeof td?.onNotificationClick,
      secureStore: typeof td?.secureStore,
    };
  });
  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.onDeepLink).toBe('function'); // the SSO deep-link bridge
  expect(exposure.showNotification).toBe('function'); // main-process notifications
  expect(exposure.onNotificationClick).toBe('function');
  expect(exposure.secureStore).toBe('object'); // OS-keychain secret storage (#1)
});

test('secureStore round-trips through the main process (or degrades cleanly)', async () => {
  // The OS-keychain token store (review finding #1): the renderer asks the main
  // process to get/set/delete; values are encrypted with safeStorage and the secret
  // never touches renderer storage. In a headless/no-keyring CI safeStorage is
  // unavailable, so the contract is "set is refused and nothing is stored".
  const KEY = 'e2e.secure.probe';
  const result = await page.evaluate(async (key) => {
    const store = (
      globalThis as {
        trinityDesktop?: {
          secureStore?: {
            isAvailable: () => Promise<boolean>;
            get: (k: string) => Promise<string | null>;
            set: (k: string, v: string) => Promise<boolean>;
            delete: (k: string) => Promise<void>;
          };
        };
      }
    ).trinityDesktop?.secureStore;
    if (!store) {
      return { present: false } as const;
    }
    const available = await store.isAvailable();
    const setOk = await store.set(key, 'secret-value');
    const got = await store.get(key);
    await store.delete(key);
    const afterDelete = await store.get(key);
    // The secret must never live in the renderer's own storage.
    const inLocalStorage = Object.values(localStorage).some((v) =>
      v.includes('secret-value'),
    );
    return { present: true, available, setOk, got, afterDelete, inLocalStorage };
  }, KEY);

  expect(result.present).toBe(true);
  if (!result.present) {
    return;
  }
  expect(result.inLocalStorage).toBe(false);
  if (result.available) {
    expect(result.setOk).toBe(true);
    expect(result.got).toBe('secret-value');
    expect(result.afterDelete).toBeNull();
  } else {
    expect(result.setOk).toBe(false);
    expect(result.got).toBeNull();
  }
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
