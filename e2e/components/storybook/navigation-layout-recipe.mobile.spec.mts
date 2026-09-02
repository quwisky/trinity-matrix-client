import { expect, test } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

test('tabs remain operable in a real mobile device profile', async ({
  page,
}) => {
  await page.goto(story('components-tabs--neutral-pill'));

  const members = page.getByRole('tab', { name: 'Members' });
  await members.tap();
  await expect(members).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Members' })).toBeVisible();

  const list = page.getByRole('tablist');
  const bounds = await list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(393);
  expect(bounds.width).toBeGreaterThan(0);
});

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
  await expect(toolbar).toHaveCSS('height', '56px');
});
