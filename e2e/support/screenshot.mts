import type { Page } from '@playwright/test';
import { isAndroidE2E } from './navigation.mts';

/** Capture proof without letting Android's screenshot session reset the test viewport. */
export async function captureScreenshot(
  page: Page,
  capture: () => Promise<Buffer>,
): Promise<Buffer> {
  const viewport = page.viewportSize();
  try {
    return await capture();
  } finally {
    // Attached WebViews use a separate CDP session for emulation. Screenshot capture
    // restores the screenshot session's native metrics, so reapply the test's size.
    if (isAndroidE2E && viewport && !page.isClosed()) {
      await page.setViewportSize(viewport);
    }
  }
}
