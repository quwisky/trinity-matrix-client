import { expect, test } from '../../../fixtures.mts';
import { configureSettingsSuite } from '../../support/settings-journey.mts';

// Each settings section lists its parts (groups) in the nav; a part is reachable from the
// URL fragment and the nav row follows the scroll. Appearance is the section with parts.
test.describe('Settings parts', () => {
  configureSettingsSuite();

  test('deep-links to a part, scrolls on click, and follows the scroll', async ({
    page,
  }) => {
    // Short enough that Timeline can scroll to the top; on a taller window the last
    // parts share the end of the page and the spy rightly reports the last one.
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto('/settings/appearance#timeline');
    const timeline = page.locator('#part-timeline');
    await expect(timeline).toBeInViewport({ timeout: 20_000 });
    await expect(page.getByTestId('settings-part-timeline')).toHaveAttribute(
      'aria-current',
      'location',
    );

    await page.getByTestId('settings-part-code-blocks').click();
    await expect(page).toHaveURL(/\/settings\/appearance#code-blocks$/);
    await expect(page.locator('#part-code-blocks')).toBeInViewport();
    await expect(page.locator('#part-code-blocks')).toBeFocused();

    await page.getByTestId('settings-detail').hover();
    await page.mouse.wheel(0, -10_000);
    // Appearance opens with an untitled preview, so no part is current at the very top.
    await expect(
      page.locator('.settings-layout__part[aria-current="location"]'),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/appearance$/);
  });

  test('opens at the top and clears the fragment for an unknown part', async ({
    page,
  }) => {
    await page.goto('/settings/appearance#nope');
    await expect(page.getByTestId('mode-dark')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(page.locator('#part-mode-and-theme')).toBeInViewport();
  });

  test('keeps the part chips pinned while a long section scrolls on a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings/appearance');
    const chips = page.locator('.settings-layout__chips');
    await expect(chips).toBeVisible({ timeout: 20_000 });
    const detail = page.getByTestId('settings-detail');
    await detail.hover();
    await page.mouse.wheel(0, 2_000);
    await expect
      .poll(() =>
        detail.evaluate((element) => {
          const scroller = element.querySelector(
            '.settings-layout__column',
          )?.parentElement;
          return scroller?.scrollTop ?? 0;
        }),
      )
      .toBeGreaterThan(1_500);
    const box = await chips.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(box?.y ?? Infinity).toBeLessThan(120);
  });

  test('uses the full phone width with the close button in the top bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings/appearance');
    const back = page.getByRole('button', { name: 'Back to sections' });
    const close = page.getByRole('button', { name: 'Close settings' });
    await expect(close).toBeVisible({ timeout: 20_000 });
    await expect(back).toBeVisible();
    const centre = async (button: typeof back): Promise<number> => {
      const box = await button.boundingBox();
      return box ? box.y + box.height / 2 : Number.NaN;
    };
    // Measured until the section has settled; the first frame can catch the top bar mid-layout.
    await expect
      .poll(async () => Math.abs((await centre(back)) - (await centre(close))))
      .toBeLessThan(8);
    const row = page.locator('[data-slot="settings-row"]').first();
    await expect
      .poll(async () => {
        const box = await row.boundingBox();
        return box ? Math.abs(box.x - (390 - box.x - box.width)) : Number.NaN;
      })
      .toBeLessThan(2);
  });

  test('lines the phone section list up with a section page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings');
    const listTitle = page.locator('.settings-layout__list-head h1');
    await expect(listTitle).toBeVisible({ timeout: 20_000 });
    const close = page.getByRole('button', { name: 'Close settings' });
    const [titleBox, closeBox] = await Promise.all([
      listTitle.boundingBox(),
      close.boundingBox(),
    ]);
    // The X sits as far from the right edge as the title does from the left.
    expect(
      Math.abs(
        (titleBox?.x ?? 0) -
          (390 - (closeBox?.x ?? 0) - (closeBox?.width ?? 0)),
      ),
    ).toBeLessThan(8);

    await page.getByTestId('settings-nav-appearance').click();
    const sectionTitle = page.locator('.settings-layout__column h1');
    await expect(sectionTitle).toBeVisible();
    await expect
      .poll(async () => (await sectionTitle.boundingBox())?.x)
      .toBeCloseTo(titleBox?.x ?? -1, 0);
  });
});
