import {
  expect,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';

/** The heading a tab shows while another tab of the same browser runs Trinity. */
export function waitingNotice(page: Page): Locator {
  return page.getByRole('heading', { name: 'Trinity is open in another tab' });
}

function isSyncUrl(url: string): boolean {
  return new URL(url).pathname.endsWith('/sync');
}

/** A successful Matrix /sync response: one full round trip of the tab that sent it. */
export function isSyncResponse(response: Response): boolean {
  return isSyncUrl(response.url()) && response.ok();
}

/** Count the Matrix /sync requests a page sends from now on, across its reloads. */
export function countSyncRequests(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (isSyncUrl(request.url())) count += 1;
  });
  return () => count;
}

/**
 * Open the app in a second tab of the SAME browser context, which shares the first tab's
 * storage and Web Locks as two tabs of one browser profile do. A new context is a separate
 * profile and would never compete for the session lock. Waits for the waiting notice.
 */
export async function openWaitingTab(
  page: Page,
): Promise<{ readonly page: Page; readonly syncs: () => number }> {
  const tab = await page.context().newPage();
  const syncs = countSyncRequests(tab);
  // Not networkidle: the first tab's /sync long-poll keeps the context busy.
  await tab.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(waitingNotice(tab)).toBeVisible({ timeout: 30_000 });
  return { page: tab, syncs };
}
