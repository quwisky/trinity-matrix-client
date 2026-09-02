import { expect, test } from '@playwright/test';

const STORY =
  '/iframe.html?id=components-field-controls--canonical-states&viewMode=story';

test('field controls keep their touch targets on a mobile device profile', async ({
  page,
}) => {
  await page.goto(STORY);

  for (const control of [
    page.getByTestId('field-input-small'),
    page.getByRole('combobox', { name: 'Message density' }),
  ]) {
    const bounds = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    });
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
});
