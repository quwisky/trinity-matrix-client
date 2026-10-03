import { expect, test } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

test('cards expose only their bounded visual choices', async ({ page }) => {
  await page.goto(story('components-card--geometry'));
  const compact = page.getByTestId('card-neutral-sm');
  const standard = page.getByTestId('card-neutral-md');
  await expect(compact).toHaveAttribute('data-size', 'sm');
  await expect(standard).toHaveAttribute('data-size', 'md');
  expect(
    await compact.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThan(
    await standard.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  );
});
