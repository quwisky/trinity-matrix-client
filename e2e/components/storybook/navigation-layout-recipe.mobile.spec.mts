import { expect, test } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

test('page and toolbar headers retain their mobile geometry', async ({
  page,
}) => {
  await page.goto(story('components-page-header--page'));
  const pageHeader = page.locator('header');
  await expect(pageHeader).toHaveAttribute('data-trn-layout', 'page');
  await expect(pageHeader).toHaveCSS('min-height', '56px');

  await page.goto(story('components-page-header--toolbar'));
  const toolbar = page.locator('header');
  await expect(toolbar).toHaveAttribute('data-trn-layout', 'toolbar');
  await expect(toolbar).toHaveCSS('height', '48px');
});
