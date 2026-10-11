import { expect, test, type Page } from '@playwright/test';

/**
 * Opens the story with Playwright's fake clock already in place. Installing it on a live
 * page swaps `Date`, `performance` and the timer globals underneath pending timers and the
 * tooltip's running enter animation; WebKit's renderer crashed inside that swap on CI. Here
 * the clock arrives as an init script, so every page script sees one clock from the start.
 */
async function openTouchActionStory(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto(
    '/iframe.html?id=components-tooltip--touch-action&viewMode=story',
  );
}

test('keyboard tooltip remains open when the pointer leaves its content', async ({
  page,
}) => {
  await openTouchActionStory(page);
  const source = page.getByTestId('tooltip-touch-source');
  await page.getByTestId('tooltip-touch-target').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(source).toBeFocused();

  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await tooltip.hover();
  await page.mouse.move(0, 0);
  await page.clock.runFor(1_000);

  await expect(source).toBeFocused();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-state', 'open');

  await page.keyboard.press('Tab');
  await expect(tooltip).toBeHidden();
});

test('mouse tooltip remains hoverable and closes after the pointer leaves', async ({
  page,
}) => {
  await openTouchActionStory(page);
  await page.getByTestId('tooltip-touch-source').hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await tooltip.hover();
  await page.clock.runFor(1_000);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-state', 'open');

  await page.mouse.move(0, 0);
  await page.clock.runFor(1_000);
  await expect(tooltip).toBeHidden();
});

test.describe('tooltip on a touch-capable desktop', () => {
  test.use({ hasTouch: true });

  test('does not open when focus is restored after a tap', async ({ page }) => {
    await openTouchActionStory(page);
    await page.getByTestId('tooltip-touch-target').tap();
    // What a closing sheet does: hand focus back to the control that opened it.
    await page
      .getByTestId('tooltip-touch-source')
      .evaluate((el) => (el as HTMLElement).focus());
    await page.clock.runFor(1_000);

    await expect(page.getByTestId('tooltip-touch-source')).toBeFocused();
    await expect(page.getByRole('tooltip')).toBeHidden();
  });

  test('switches from touch activation to mouse hover', async ({ page }) => {
    await openTouchActionStory(page);
    const source = page.getByTestId('tooltip-touch-source');
    await expect(source).toBeVisible();
    await source.tap();
    await page.clock.runFor(1_000);
    await expect(page.getByRole('tooltip')).toBeHidden();

    await page.mouse.move(0, 0);
    await source.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toBeHidden();
  });
});
