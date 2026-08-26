import { expect, test, type Locator } from '@playwright/test';

const transformOf = async (icon: Locator) =>
  icon.evaluate((element) => getComputedStyle(element).transform);

test('WebKit applies hover and press motion to a rendered glyph', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=components-icon-motion--rotate&viewMode=story',
  );
  const button = page.getByRole('button', { name: 'Settings' });
  const icon = button.locator('ng-icon');
  await expect(icon.locator('svg')).toBeVisible();
  const rest = await transformOf(icon);

  await button.hover();
  await expect.poll(() => transformOf(icon)).not.toBe(rest);
  await page.mouse.down();
  await expect
    .poll(() =>
      icon.evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return Math.round(Math.hypot(matrix.a, matrix.b) * 100);
      }),
    )
    .toBe(90);
  await page.mouse.up();
});

test('WebKit keeps reduced-motion glyphs static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(
    '/iframe.html?id=components-icon-motion--rotate&viewMode=story',
  );
  const button = page.getByRole('button', { name: 'Settings' });
  const icon = button.locator('ng-icon');
  await expect(icon.locator('svg')).toBeVisible();

  await button.hover();

  expect(await transformOf(icon)).toBe('none');
});
