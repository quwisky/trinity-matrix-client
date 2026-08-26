import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// One scrollbar in Settings, never two.
//
// The section list and the detail pane are separate scrollers, so on a short window both
// overflowed and drew a bar — the list's sitting right beside the content's. The list is
// thirteen items that only overflow when the window is short; the content's bar is the one
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

  test('never draws the list its own bar, and still draws the content its one', async ({
    page,
  }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();

    // Per section, and EXACT — not "at most one". A `<= 1` assertion passes at zero, so a
    // section that rendered nothing at all would have satisfied it; and the rule has two
    // halves ("never the outer, only the inner when necessary"), of which only the first
    // survives a count. Notifications and Appearance are the sections whose own content is
    // long enough to scroll here; Privacy's is not.
    const expected: Record<string, string[]> = {
      notifications: ['SECTION[settings-detail]'],
      appearance: ['SECTION[settings-detail]'],
      privacy: [],
    };

    for (const [section, bars] of Object.entries(expected)) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await page.waitForURL(new RegExp(`/settings/${section}$`), {
        timeout: 20_000,
      });
      // The pane has rendered, so an empty result below means "no bar" rather than
      // "nothing to measure".
      await expect(page.getByTestId('settings-detail')).not.toBeEmpty();

      await expect.poll(() => scrollbarPainters(page)).toEqual(bars);
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

    // A wheel over the list, which is the input path the fix promises still works — and the
    // one a hidden scrollbar actually costs a pointer user.
    await nav.hover();
    await page.mouse.wheel(0, 200);
    await expect
      .poll(() => nav.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    // And the LAST section is genuinely reachable. `toBeVisible` would not have shown this:
    // an element scrolled out of an `overflow: auto` ancestor still has a bounding box, so
    // that assertion passes whether or not the list scrolls. A click has to reach it.
    await page.getByTestId('settings-nav-advanced').click();
    await page.waitForURL(/\/settings\/advanced$/, { timeout: 20_000 });
  });

  test('keeps notification overflow inside the settings shell', async ({
    page,
  }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();
    await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });

    // The detail pane owns vertical scrolling. Its routed content must not enlarge the
    // document's scrollable overflow area in a framed Electron window, where the title-bar
    // inset makes the body become a second scrollbar at the content threshold.
    await expect
      .poll(() =>
        page
          .locator('trn-settings')
          .evaluate((shell) => getComputedStyle(shell).overflowY),
      )
      .toBe('hidden');
    await expect
      .poll(() => scrollbarPainters(page))
      .toEqual(['SECTION[settings-detail]']);
  });
});
