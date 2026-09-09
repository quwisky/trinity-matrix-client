import { expect, test } from '@playwright/test';

test('keyboard tooltip remains open when the pointer leaves its content', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=components-tooltip--touch-action&viewMode=story',
  );
  const source = page.getByTestId('tooltip-touch-source');
  await page.getByTestId('tooltip-touch-target').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(source).toBeFocused();

  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await tooltip.hover();
  await page.clock.install();
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
  await page.goto(
    '/iframe.html?id=components-tooltip--touch-action&viewMode=story',
  );
  await page.getByTestId('tooltip-touch-source').hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await page.clock.install();
  await tooltip.hover();
  await page.clock.runFor(1_000);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-state', 'open');

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
});

test.describe('tooltip on a touch-capable desktop', () => {
  test.use({ hasTouch: true });

  test('switches from touch activation to mouse hover', async ({ page }) => {
    await page.goto(
      '/iframe.html?id=components-tooltip--touch-action&viewMode=story',
    );
    const source = page.getByTestId('tooltip-touch-source');
    await expect(source).toBeVisible();
    await page.clock.install();
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
