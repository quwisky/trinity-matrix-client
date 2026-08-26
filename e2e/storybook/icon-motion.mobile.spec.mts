import { expect, test } from '@playwright/test';

test('touch press moves the glyph and returns without sticky hover', async ({
  context,
  page,
}) => {
  await page.goto(
    '/iframe.html?id=components-icon-motion--nudge-up-right&viewMode=story',
  );
  const button = page.getByRole('button', { name: 'Send' });
  const icon = button.locator('ng-icon');
  await expect(icon.locator('svg')).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(
    false,
  );

  const rest = await icon.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send('Input.emulateTouchFromMouseEvent', {
      type: 'mousePressed',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
    });
    await expect
      .poll(() =>
        icon.evaluate((element) => {
          const matrix = new DOMMatrix(getComputedStyle(element).transform);
          return Math.round(matrix.a * 100);
        }),
      )
      .toBe(90);
  } finally {
    await cdp.send('Input.emulateTouchFromMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
    });
  }

  await expect
    .poll(() => icon.evaluate((element) => getComputedStyle(element).transform))
    .toBe(rest);
});
