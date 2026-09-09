import { expect, test } from '@playwright/test';

test('touch tap on a tooltip trigger does not block the following action', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=components-tooltip--touch-action&viewMode=story',
  );
  const source = page.getByTestId('tooltip-touch-source');
  await expect(source).toBeVisible();
  await page.clock.install();

  await source.tap();
  // Let the delayed focus request run before checking for an obstructing tooltip.
  await page.clock.runFor(1_000);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.getByTestId('tooltip-touch-target').tap();

  await expect(page).toHaveURL(/#touch-target-activated$/);

  await page.keyboard.press('Shift+Tab');
  await expect(source).toBeFocused();
  await page.clock.runFor(1_000);
  await expect(page.getByRole('tooltip')).toBeVisible();
});
