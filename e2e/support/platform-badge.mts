import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __appBadgeCalls: unknown[][];
    __appBadgeCount: number;
  }
}

/** Record the badge sink selected by the app without depending on launcher support. */
export async function installBadgeRecorder(page: Page): Promise<void> {
  function install(nativeExpected: boolean): void {
    const w = window;
    w.__appBadgeCalls = [];
    w.__appBadgeCount = 0;

    const recordSet = (count = 0): void => {
      w.__appBadgeCount = count;
      w.__appBadgeCalls.push(['set', count]);
    };
    const recordClear = (): void => {
      w.__appBadgeCount = 0;
      w.__appBadgeCalls.push(['clear']);
    };

    const capacitor = (
      window as typeof window & {
        Capacitor?: {
          nativePromise?(
            pluginName: string,
            methodName: string,
            options?: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    ).Capacitor;
    if (!capacitor && nativeExpected) {
      setTimeout(() => install(nativeExpected), 0);
      return;
    }
    if (nativeExpected && capacitor?.nativePromise) {
      let nativePromise = capacitor.nativePromise.bind(capacitor);
      const badgeAwareNativePromise = (
        pluginName: string,
        methodName: string,
        options: Record<string, unknown> = {},
      ): Promise<unknown> => {
        if (pluginName !== 'Badge') {
          return nativePromise(pluginName, methodName, options);
        }
        if (methodName === 'isSupported') {
          return Promise.resolve({ isSupported: true });
        }
        if (
          methodName === 'requestPermissions' ||
          methodName === 'checkPermissions'
        ) {
          return Promise.resolve({ display: 'granted' });
        }
        if (methodName === 'set') {
          recordSet(Number(options['count'] ?? 0));
          return Promise.resolve();
        }
        if (methodName === 'clear') {
          recordClear();
          return Promise.resolve();
        }
        if (methodName === 'get') {
          return Promise.resolve({ count: w.__appBadgeCount });
        }
        return nativePromise(pluginName, methodName, options);
      };
      capacitor.nativePromise = badgeAwareNativePromise;
      return;
    }

    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    nav.setAppBadge = async (count?: number) => recordSet(count);
    nav.clearAppBadge = async () => recordClear();
  }

  // The injected native bridge exists before @capacitor/core and Angular boot.
  // Wrapping it at document init matters: MobileBadgeService probes support on
  // its first zero-count update and memoizes that readiness result.
  const nativeExpected = process.env['TRINITY_E2E_PLATFORM'] === 'android';
  await page.addInitScript(install, nativeExpected);
  if (nativeExpected) {
    // The Android fixture attaches after the first application boot, by which point
    // MobileBadgeService may already have memoized the emulator launcher's real support
    // result. Restart this still-signed-out document so the recorder owns the bridge
    // before Angular constructs the service. Callers intentionally install it before login.
    await page.reload({ waitUntil: 'domcontentloaded' });
    return;
  }
  await page.evaluate(install, nativeExpected);
}

export async function recordedBadgeCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__appBadgeCount ?? 0);
}

export async function recordedBadgeCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => window.__appBadgeCalls ?? []);
}
