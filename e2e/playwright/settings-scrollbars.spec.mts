import { test, expect, type Locator, type Page } from './support/fixtures.mts';
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
 * The gutter measurement is the obvious one and it is useless here: overlay scrollbars leave
 * it at 0 whether or not a bar appears. Chromium/WebKit expose their pseudo-element paint;
 * headless Firefox normalizes `scrollbar-width` to `none` even when the authored `thin` rule
 * applies, so its intentional hidden exception is identified by the explicit class and its
 * standards paint is asserted separately below.
 */
async function scrollbarPainters(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const walk = (node: Element) => {
      const style = getComputedStyle(node);
      const scrolls =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 1;
      const webkitScrollbar =
        !navigator.userAgent.includes('Firefox') &&
        CSS.supports('selector(::-webkit-scrollbar-thumb)')
          ? getComputedStyle(node, '::-webkit-scrollbar')
          : undefined;
      const hidden = navigator.userAgent.includes('Firefox')
        ? node.classList.contains('no-scrollbar')
        : style.scrollbarWidth === 'none' ||
          webkitScrollbar?.display === 'none';
      if (scrolls && !hidden) {
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

async function visibleScrollbarPaint(scroller: Locator) {
  return scroller.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.cssText = [
      'position:absolute',
      'width:var(--trinity-scrollbar-size)',
      'border-radius:var(--trinity-scrollbar-radius)',
      'background:var(--trinity-scrollbar-thumb)',
    ].join(';');
    element.append(probe);

    const probeStyle = getComputedStyle(probe);
    const usesWebkit =
      !navigator.userAgent.includes('Firefox') &&
      CSS.supports('selector(::-webkit-scrollbar-thumb)');
    const bar = usesWebkit
      ? getComputedStyle(element, '::-webkit-scrollbar')
      : undefined;
    const thumb = usesWebkit
      ? getComputedStyle(element, '::-webkit-scrollbar-thumb')
      : undefined;
    const track = usesWebkit
      ? getComputedStyle(element, '::-webkit-scrollbar-track')
      : undefined;
    const corner = usesWebkit
      ? getComputedStyle(element, '::-webkit-scrollbar-corner')
      : undefined;
    const elementStyle = getComputedStyle(element);
    const paint = {
      usesWebkit,
      standardWidth: elementStyle.scrollbarWidth,
      standardColor: elementStyle.scrollbarColor,
      width: bar?.width,
      height: bar?.height,
      thumb: thumb?.backgroundColor,
      radius: thumb?.borderRadius,
      track: track?.backgroundColor,
      corner: corner?.backgroundColor,
      expectedSize: probeStyle.width,
      expectedThumb: probeStyle.backgroundColor,
      expectedRadius: probeStyle.borderRadius,
    };
    probe.remove();
    return paint;
  });
}

test.describe('Settings scrollbars', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('owns exactly one painted scrollbar at every desktop acceptance size', async ({
    page,
  }) => {
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

    const viewports = [
      { width: 1280, height: 700 },
      { width: 1024, height: 700 },
      { width: 1280, height: 862 },
    ];

    await login(page, session);
    const roomUrl = page.url();
    await page.getByTestId('open-settings').click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).toHaveURL(roomUrl);

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const [section, bars] of Object.entries(expected)) {
        await page.getByTestId(`settings-nav-${section}`).click();
        await expect(page.getByTestId('settings-detail')).not.toBeEmpty();

        await expect.poll(() => scrollbarPainters(page)).toEqual(bars);
        const geometry = await page.evaluate(() => {
          const workspace = document.querySelector<HTMLElement>(
            '[data-testid=settings-workspace]',
          );
          const shell = document.querySelector<HTMLElement>(
            '[data-testid=settings-dialog]',
          );
          if (!workspace || !shell) throw new Error('settings shell missing');
          const frame = workspace.getBoundingClientRect();
          return {
            documentOverflow:
              document.documentElement.scrollHeight -
              document.documentElement.clientHeight,
            shellOverflowY: getComputedStyle(shell).overflowY,
            frame: {
              top: frame.top,
              right: frame.right,
              bottom: frame.bottom,
              left: frame.left,
            },
          };
        });
        expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
        expect(geometry.shellOverflowY).toBe('hidden');
        expect(geometry.frame.left).toBeGreaterThan(0);
        expect(geometry.frame.right).toBeLessThan(viewport.width);
        expect(geometry.frame.top).toBeGreaterThan(0);
        expect(geometry.frame.bottom).toBeLessThanOrEqual(viewport.height + 1);
      }
    }
  });

  test('the section list still scrolls, it just does not draw a bar', async ({
    page,
  }) => {
    // Hiding a scrollbar must not take the scrolling away — the list is taller than the
    // window here, and everything below the fold has to stay reachable.
    await login(page, session);
    await page.setViewportSize({ width: 1280, height: 560 });
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
    await expect(page.getByTestId('settings-detail')).not.toBeEmpty();
  });

  test('keeps notification overflow inside the settings shell', async ({
    page,
  }) => {
    await login(page, session);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();

    // The detail pane owns vertical scrolling. Its routed content must not enlarge the
    // document's scrollable overflow area in a framed Electron window, where the title-bar
    // inset makes the body become a second scrollbar at the content threshold.
    await expect
      .poll(() =>
        page
          .getByTestId('settings-dialog')
          .evaluate((shell) => getComputedStyle(shell).overflowY),
      )
      .toBe('hidden');
    await expect
      .poll(() => scrollbarPainters(page))
      .toEqual(['SECTION[settings-detail]']);
  });

  test('uses the shared visible design across mode and palette changes', async ({
    page,
  }) => {
    await login(page, session);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();

    const detail = page.getByTestId('settings-detail');
    const nav = page.locator('nav[aria-label="Settings sections"]');
    await expect
      .poll(() => scrollbarPainters(page))
      .toEqual(['SECTION[settings-detail]']);

    for (const theme of [
      { palette: 'amethyst', dark: false },
      { palette: 'onyx', dark: true },
    ]) {
      await page.evaluate(({ palette, dark }) => {
        document.documentElement.dataset['theme'] = palette;
        document.documentElement.classList.toggle('dark', dark);
      }, theme);

      const paint = await visibleScrollbarPaint(detail);
      if (paint.usesWebkit) {
        expect.soft(paint.width).toBe(paint.expectedSize);
        expect.soft(paint.height).toBe(paint.expectedSize);
        expect.soft(paint.thumb).toBe(paint.expectedThumb);
        expect.soft(paint.radius).toBe(paint.expectedRadius);
        expect.soft(paint.track).toBe('rgba(0, 0, 0, 0)');
        expect.soft(paint.corner).toBe('rgba(0, 0, 0, 0)');
      } else {
        expect.soft(paint.standardColor).toContain(paint.expectedThumb);
      }
    }

    const hidden = await nav.evaluate((element) => ({
      standard: getComputedStyle(element).scrollbarWidth,
      usesWebkit:
        !navigator.userAgent.includes('Firefox') &&
        CSS.supports('selector(::-webkit-scrollbar-thumb)'),
      webkit:
        !navigator.userAgent.includes('Firefox') &&
        CSS.supports('selector(::-webkit-scrollbar-thumb)')
          ? getComputedStyle(element, '::-webkit-scrollbar').display
          : undefined,
    }));
    if (hidden.usesWebkit) {
      expect(hidden.webkit).toBe('none');
    } else {
      await expect(nav).toHaveClass(/\bno-scrollbar\b/);
    }
  });
});
