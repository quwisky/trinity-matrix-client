import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// One scrollbar in Settings, never two.
//
// The section list and the detail pane are separate scrollers, so on a short window both
// overflowed and drew a bar — the list's sitting right beside the content's. The list is
// twelve items that only overflow when the window is short; the content's bar is the one
// that carries meaning, so the list's is suppressed and the content's is left alone.
//
// Measured here rather than asserted from the class, because the class was the bug: the kit
// has carried `no-scrollbar` on its select panel since it was vendored, and it compiled to
// nothing at all — the preset defining it was never imported. A DOM assertion would have
// been green throughout.
const session = synapseSession();

/**
 * Every element that overflows vertically AND would paint a scrollbar.
 *
 * Read from `scrollbar-width`, not from `offsetWidth - clientWidth`. The gutter measurement
 * is the obvious one and it is useless here: headless Chromium draws OVERLAY scrollbars, so
 * the gutter is 0 whether or not a bar appears — a first version of this spec passed with
 * the fix removed. `scrollbar-width` is the property the fix actually sets, and it is
 * readable in the engine that would draw the bar.
 */
async function scrollbarPainters(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const walk = (node: Element) => {
      const style = getComputedStyle(node);
      const scrolls =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 1;
      if (scrolls && style.scrollbarWidth !== 'none') {
        found.push(
          `${node.tagName}[${node.getAttribute('data-testid') ?? node.className.slice(0, 30)}]`,
        );
      }
      for (const child of node.children) walk(child);
    };
    walk(document.body);
    return found;
  });
}

test.describe('Settings scrollbars', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  // Short enough that the section list overflows in every section — that is what put a
  // second bar beside the content's.
  test.use({ viewport: { width: 1280, height: 560 } });

  test('shows one scrollbar at most, whichever section is open', async ({
    page,
  }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();

    // Notifications and Appearance are the two whose content is long enough to scroll on
    // its own; the others prove the list alone never draws one.
    for (const section of ['notifications', 'appearance', 'privacy']) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await page.waitForURL(new RegExp(`/settings/${section}$`), {
        timeout: 20_000,
      });

      const bars = await scrollbarPainters(page);
      expect(bars.filter((bar) => bar.includes('NAV'))).toEqual([]);
      expect(bars.length).toBeLessThanOrEqual(1);
    }
  });

  test('the section list still scrolls, it just does not draw a bar', async ({
    page,
  }) => {
    // Hiding a scrollbar must not take the scrolling away — the list is taller than the
    // window here, and everything below the fold has to stay reachable.
    await login(page, session);
    await page.getByTestId('open-settings').click();
    const nav = page.locator('nav[aria-label="Settings sections"]');
    await expect(nav).toBeVisible({ timeout: 20_000 });

    const overflow = await nav.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(overflow).toBeGreaterThan(0);

    await nav.evaluate((el) => el.scrollTo({ top: 200 }));
    expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // And the last section is reachable rather than clipped away.
    await expect(page.getByTestId('settings-nav-experimental')).toBeVisible();
  });
});
