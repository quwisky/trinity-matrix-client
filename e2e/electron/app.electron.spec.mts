import { test, expect, type Page } from './fixtures.mts';
import { type ElectronApplication } from 'playwright';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
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

test('@renderer-smoke boots the app over the trinity:// custom scheme', async () => {
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

test('negotiates the grouped protocol-v1 bridge without exposing Node', async () => {
  const exposure = await page.evaluate(() => {
    const td = (
      globalThis as {
        trinityDesktop?: {
          protocolVersion?: unknown;
          isElectron?: unknown;
          platform?: unknown;
          negotiate?: (operations: readonly string[]) => Promise<unknown>;
          capabilities?: Record<string, unknown>;
          onDeepLink?: unknown;
          showNotification?: unknown;
          onNotificationClick?: unknown;
          secureStore?: unknown;
          ipcRenderer?: unknown;
        };
      }
    ).trinityDesktop;
    return Promise.resolve(
      td?.negotiate?.([
        'authentication-handoff',
        'deep-links',
        'back',
        'file-export',
        'notification-presentation',
        'location',
        'badge',
        'secure-store',
        'lifecycle',
        'updates',
      ]),
    ).then((negotiation) => ({
      require: typeof (globalThis as Record<string, unknown>)['require'],
      process: typeof (globalThis as Record<string, unknown>)['process'],
      topLevel: Object.keys(td ?? {}).sort(),
      capabilityGroups: Object.keys(td?.capabilities ?? {}).sort(),
      protocolVersion: td?.protocolVersion,
      isElectron: td?.isElectron,
      platform: typeof td?.platform,
      ipcRenderer: typeof td?.ipcRenderer,
      legacyFlatMethods: [
        typeof td?.onDeepLink,
        typeof td?.showNotification,
        typeof td?.onNotificationClick,
        typeof td?.secureStore,
      ],
      negotiation,
    }));
  });

  expect(exposure.protocolVersion).toBe(1);
  expect(exposure.isElectron).toBe(true);
  expect(exposure.platform).toBe('string');
  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.ipcRenderer).toBe('undefined');
  expect(exposure.topLevel).toEqual([
    'capabilities',
    'isElectron',
    'negotiate',
    'platform',
    'protocolVersion',
  ]);
  expect(exposure.capabilityGroups).toEqual([
    'badge',
    'deepLinks',
    'location',
    'networkCors',
    'notificationPresentation',
    'secureStore',
  ]);
  expect(exposure.legacyFlatMethods).toEqual([
    'undefined',
    'undefined',
    'undefined',
    'undefined',
  ]);
  expect(exposure.negotiation).toMatchObject({
    kind: 'accepted',
    protocolVersion: 1,
    operations: {
      'authentication-handoff': { kind: 'supported' },
      'deep-links': { kind: 'supported' },
      back: { kind: 'unavailable', reason: 'not-implemented' },
      'file-export': { kind: 'supported' },
      location: { kind: 'supported' },
      badge: { kind: 'supported' },
      'secure-store': { kind: 'supported' },
      lifecycle: { kind: 'supported' },
      updates: { kind: 'unavailable', reason: 'not-implemented' },
    },
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
          capabilities?: {
            secureStore?: {
              isAvailable: () => Promise<boolean>;
              get: (k: string) => Promise<string | null>;
              set: (k: string, v: string) => Promise<boolean>;
              delete: (k: string) => Promise<void>;
            };
          };
        };
      }
    ).trinityDesktop?.capabilities?.secureStore;
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

test('applies production Appearance through the custom protocol', async () => {
  const keys = [
    'CapacitorStorage.trinity.appearance.mode',
    'CapacitorStorage.trinity.appearance.theme',
    'CapacitorStorage.trinity.appearance.density',
  ] as const;
  const setAppearance = async (
    mode: 'light' | 'dark',
    theme: 'amethyst' | 'onyx',
    density: 'cosy' | 'compact',
  ): Promise<void> => {
    await page.evaluate(
      ([appearanceKeys, values]) => {
        for (const [index, key] of appearanceKeys.entries()) {
          localStorage.setItem(key, values[index]);
        }
      },
      [keys, [mode, theme, density]] as const,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Homeserver')).toBeVisible();
  };
  const appearance = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const stylesheets = [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      ];
      return {
        dark: root.classList.contains('dark'),
        theme: root.getAttribute('data-theme'),
        density: root.getAttribute('data-density'),
        rail: style.getPropertyValue('--trinity-rail').trim(),
        accent: style.getPropertyValue('--trinity-accent').trim(),
        linkedStylesheets: stylesheets.length,
        loadedStylesheets: stylesheets.filter(
          ({ sheet }) => sheet && sheet.cssRules.length > 0,
        ).length,
        asyncStyleSwaps: document.querySelectorAll(
          'link[rel="preload"][as="style"], link[rel="stylesheet"][onload]',
        ).length,
      };
    });

  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate((appearanceKeys) => {
      for (const key of appearanceKeys) localStorage.removeItem(key);
    }, keys);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Homeserver')).toBeVisible();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    await expect(page.locator('html')).not.toHaveAttribute('data-density');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    await setAppearance('light', 'amethyst', 'compact');
    const light = await appearance();
    expect(light).toMatchObject({
      asyncStyleSwaps: 0,
      dark: false,
      density: 'compact',
      theme: 'amethyst',
    });
    expect(light.linkedStylesheets).toBeGreaterThan(0);
    expect(light.loadedStylesheets).toBe(light.linkedStylesheets);
    expect(light.rail).not.toBe('');
    expect(light.accent).not.toBe('');

    // Fixed light remains authoritative while the OS stays dark.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);

    await setAppearance('dark', 'onyx', 'cosy');
    const dark = await appearance();
    expect(dark).toMatchObject({
      asyncStyleSwaps: 0,
      dark: true,
      density: null,
      theme: 'onyx',
    });
    expect(dark.linkedStylesheets).toBeGreaterThan(0);
    expect(dark.loadedStylesheets).toBe(dark.linkedStylesheets);
    expect(dark.rail).not.toBe(light.rail);
    expect(dark.accent).not.toBe(light.accent);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.animationDuration = '1s';
        probe.style.transitionDuration = '1s';
        document.body.append(probe);
        const style = getComputedStyle(probe);
        const milliseconds = (duration: string) =>
          Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1_000);
        const result = {
          animation: milliseconds(style.animationDuration),
          transition: milliseconds(style.transitionDuration),
        };
        probe.remove();
        return result;
      }),
    ).toEqual({ animation: 0.01, transition: 0.01 });
  } finally {
    await page.evaluate((appearanceKeys) => {
      for (const key of appearanceKeys) localStorage.removeItem(key);
    }, keys);
    await page.emulateMedia({ colorScheme: null, reducedMotion: null });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
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
          capabilities?: {
            networkCors?: {
              setAllowedOrigins?: (o: readonly string[]) => unknown;
              allowOrigin?: (o: string) => unknown;
            };
          };
        };
      }
    ).trinityDesktop?.capabilities?.networkCors;
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

test('fetches pack media through the scoped homeserver CORS bridge', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const server = createServer(
    {
      key: readFileSync(
        new URL('./fixtures/localhost-key.pem', import.meta.url),
      ),
      cert: readFileSync(
        new URL('./fixtures/localhost-cert.pem', import.meta.url),
      ),
    },
    (_request, response) => {
      // Deliberately no Access-Control-Allow-Origin: the Electron bridge must add it.
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(png);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await page.evaluate((allowed) => {
      (
        globalThis as {
          trinityDesktop?: {
            capabilities?: {
              networkCors?: { allowOrigin: (o: string) => void };
            };
          };
        }
      ).trinityDesktop?.capabilities?.networkCors?.allowOrigin(allowed);
    }, origin);

    await expect
      .poll(() =>
        page.evaluate(async (url) => {
          try {
            const response = await fetch(url);
            return response.ok && (await response.arrayBuffer()).byteLength > 0;
          } catch {
            return false;
          }
        }, `${origin}/_matrix/media/v3/download/hs/sticker`),
      )
      .toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
