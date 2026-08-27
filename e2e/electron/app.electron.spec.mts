import { test, expect, type Page } from '@playwright/test';
import { type ElectronApplication } from 'playwright';
import { launchApp } from './support/launch.mts';

// One Electron instance for the whole file (launching is expensive).
let app: ElectronApplication;
let page: Page;
/** Every URL the renderer asked for, from the first window onward. */
const requested: string[] = [];

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  // Attached before the load settles: Angular registers a service worker on app
  // stabilisation, which is after this point, so the boot traffic is all captured.
  page.on('request', (request) => requested.push(request.url()));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('boots the app over the trinity:// custom scheme', async () => {
  // Served via the privileged trinity://app scheme (secure context), not file://.
  await expect
    .poll(() => page.evaluate(() => location.origin))
    .toBe('trinity://app');
  // Unauthenticated → the login screen renders (proves the SPA + assets loaded).
  await expect(page.getByLabel('Homeserver')).toBeVisible();
});

test('boots the shell without renderer errors', async () => {
  // Deliberately NOT a WASM assertion, despite what this test used to be called.
  // `preloadCryptoWasm()` is only reached from an authenticated session
  // (matrix-client.service.ts and crypto-spike.service.ts), and this spec never
  // leaves the login screen — so nothing here instantiates WebAssembly. The real
  // WASM gate is the next test. This one is worth keeping for what it does check:
  // that the shell boots far enough to be interactive with a clean console.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('Continue', { exact: true }).waitFor();
  expect(errors).toEqual([]);
});

test('stream-instantiates the crypto WASM over the trinity:// scheme', async () => {
  // THE assertion the hand-rolled shell exists to make, and until now it was never
  // made anywhere in this repo.
  //
  // `WebAssembly.compileStreaming` is the strict form on purpose: it rejects unless
  // the response arrives with `Content-Type: application/wasm` over a streamable
  // body from a secure context. That is exactly the contract scheme.ts sets up —
  // trinity:// registered `standard + secure + supportFetchAPI + stream`, with
  // `.wasm` mapped at scheme.ts:36. A regression in any one of those (an Electron
  // major changing custom-scheme privileges, a lost MIME mapping, a non-streaming
  // response) fails here and nowhere else in the suite.
  const result = await page.evaluate(async () => {
    try {
      const response = await fetch(
        '/assets/crypto/matrix_sdk_crypto_wasm_bg.wasm',
      );
      const contentType = response.headers.get('content-type');
      const module = await WebAssembly.compileStreaming(response);
      return {
        ok: true,
        contentType,
        origin: location.origin,
        exports: WebAssembly.Module.exports(module).length,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  expect(result.ok, `compileStreaming failed: ${result.error ?? ''}`).toBe(
    true,
  );
  expect(result.contentType).toBe('application/wasm');
  expect(result.origin).toBe('trinity://app');
  // A real module, not an empty or truncated body.
  expect(result.exports).toBeGreaterThan(0);
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
          resolveCurrentLocation?: unknown;
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
      resolveCurrentLocation: typeof td?.resolveCurrentLocation,
    };
  });
  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.onDeepLink).toBe('function'); // the SSO deep-link bridge
  expect(exposure.showNotification).toBe('function'); // main-process notifications
  expect(exposure.onNotificationClick).toBe('function');
  expect(exposure.secureStore).toBe('object'); // OS-keychain secret storage (#1)
  expect(exposure.resolveCurrentLocation).toBe('function');
});

test('routes current location through the main-process provider', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
  });
  const result = await page.evaluate(() =>
    (
      globalThis as {
        trinityDesktop?: {
          resolveCurrentLocation?: () => Promise<unknown>;
        };
      }
    ).trinityDesktop?.resolveCurrentLocation?.(),
  );
  expect(result).toEqual({
    status: 'ok',
    lat: 47.4979,
    lng: 19.0402,
    accuracy: 10,
  });
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
    return {
      present: true,
      available,
      setOk,
      got,
      afterDelete,
      inLocalStorage,
    };
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

test('dark palette wins the cascade when .dark is set (regression)', async () => {
  // Regression for the desktop dark-theme bug: the class lands on <html>, but the
  // dark tokens must actually beat the light :root in the real Electron renderer.
  // This is why apps/trinity/project.json sets optimization.styles.inlineCritical to
  // false — the deferred stylesheet onload never fires over the trinity:// scheme, so
  // a regression here shows up as an unstyled or light-in-dark desktop app.
  const result = await page.evaluate(() => {
    const html = document.documentElement;
    const railVar = () =>
      getComputedStyle(html).getPropertyValue('--trinity-rail').trim();
    html.classList.remove('dark');
    const light = railVar();
    html.classList.add('dark');
    const dark = railVar();
    return { light, dark };
  });
  expect(result.light).toBe('#e3e5e8'); // :root light default
  expect(result.dark).toBe('#1e1f22'); // :root.dark (0,2,0) out-ranks :root (0,1,0)
});

test('registers no service worker in the desktop shell', async () => {
  // The service-worker enable predicate in main.ts is gated on `isElectronRenderer()`
  // and NOT on Capacitor's isNativePlatform(), which is false here — so a regression in
  // that predicate registers ngsw against the custom `trinity://` scheme. What follows
  // is not a clean failure: the SW would then answer navigations from a precache built
  // for an http origin, and the shell would go on serving a stale bundle after an
  // update with no way for the user to clear it. This is the only place it can be seen,
  // because the predicate reads a global that exists only in the real shell.
  const registrations = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      return { state: 'absent', count: 0 };
    }
    try {
      const all = await navigator.serviceWorker.getRegistrations();
      return { state: 'queryable', count: all.length };
    } catch (error) {
      // `trinity://` is not a service-worker-capable origin, so the container is present
      // on `navigator` but throws InvalidStateError the moment it is used. The `in`
      // check above is therefore not enough on its own — this test spent its life
      // failing on the query rather than on the thing it asserts. A throw here is not a
      // problem to route around: an origin that cannot answer the question cannot be
      // hosting a registration either, which is exactly the state we want.
      return { state: 'unusable', count: 0, reason: String(error) };
    }
  });

  expect(registrations.count).toBe(0);

  // The assertion that actually discriminates. Under `trinity://` the container throws on
  // use, so the query above can only ever report zero here — it cannot tell "no service
  // worker" from "one registered and the API is unusable", which is precisely the
  // regression this test is named for. What a wrong predicate WOULD do is make Angular
  // fetch the worker script on stabilisation, and that is observable no matter what the
  // container does afterwards.
  expect(requested.some((url) => /ngsw-worker\.js/.test(url))).toBe(false);
  // Non-vacuity: prove the collector saw the boot at all, or the line above passes for a
  // renderer that requested nothing.
  expect(requested.length).toBeGreaterThan(0);
});

test('exposes the CORS-allowlist bridge (a plain send, not an invoke)', async () => {
  // Renderer-side of the CORS scoping: the app publishes its live homeserver origins
  // so main can scope the shim (electron/src/cors.ts). Assert the bridge surface is
  // present and one-way — setAllowedOrigins/allowOrigin are fire-and-forget `send`s, so
  // they return undefined rather than a Promise. Behaviour (that main actually narrows
  // the shim to these origins) is covered by the cors/cors-ipc unit tests; here we prove
  // the preload actually exposes the channel in the real, sandboxed renderer.
  const shape = await page.evaluate(() => {
    const cors = (
      globalThis as {
        trinityDesktop?: {
          cors?: {
            setAllowedOrigins?: (o: readonly string[]) => unknown;
            allowOrigin?: (o: string) => unknown;
          };
        };
      }
    ).trinityDesktop?.cors;
    return {
      present: typeof cors,
      setAllowedOrigins: typeof cors?.setAllowedOrigins,
      allowOrigin: typeof cors?.allowOrigin,
      // A fire-and-forget send returns undefined; an invoke would return a Promise.
      returnsUndefined: cors?.setAllowedOrigins?.(['https://hs.example']),
    };
  });

  expect(shape.present).toBe('object');
  expect(shape.setAllowedOrigins).toBe('function');
  expect(shape.allowOrigin).toBe('function');
  expect(shape.returnsUndefined).toBeUndefined();
});
