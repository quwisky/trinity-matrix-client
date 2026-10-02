import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __appBadgeCalls: unknown[][];
    __appBadgeCount: number;
  }
}

/** Record the badge sink selected by the app without depending on launcher support. */
export async function installBadgeRecorder(page: Page): Promise<void> {
  function install(): void {
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

    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    nav.setAppBadge = async (count?: number) => recordSet(count);
    nav.clearAppBadge = async () => recordClear();
  }

  await page.addInitScript(install);
  await page.evaluate(install);
}

export async function recordedBadgeCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__appBadgeCount ?? 0);
}

export async function recordedBadgeCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => window.__appBadgeCalls ?? []);
}
