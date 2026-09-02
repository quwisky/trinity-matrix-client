import { expect, test } from '@playwright/test';

const STORY =
  '/iframe.html?id=components-choice-controls--canonical-states&viewMode=story';

test('choice-control recipes keep touch targets at least 44 pixels', async ({
  page,
}) => {
  await page.goto(STORY);

  for (const testId of [
    'checkbox-accent',
    'checkbox-invalid',
    'switch-accent',
    'switch-disabled',
    'toggle-idle',
    'toggle-selected',
    'toggle-readonly',
    'toggle-disabled',
  ]) {
    const bounds = await page.getByTestId(testId).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    });
    expect(bounds.height, testId).toBeGreaterThanOrEqual(44);
    expect(bounds.width, testId).toBeGreaterThanOrEqual(44);
  }

  for (const testId of ['radio-system', 'radio-light', 'radio-dark']) {
    const bounds = await page.getByTestId(testId).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    });
    expect(bounds.height, testId).toBeGreaterThanOrEqual(44);
    expect(bounds.width, testId).toBeGreaterThanOrEqual(44);
  }
});
