import { expect, test } from '@playwright/test';

const story = (name: string) =>
  `/iframe.html?id=components-overlay-recipes--${name}&viewMode=story`;

test('document and portal overlay surfaces stay inside a real mobile viewport', async ({
  page,
}) => {
  await page.goto(story('layered-surfaces'));
  const portal = page.getByTestId('portal-overlay-surface');
  await expect(portal).toBeVisible();

  const bounds = await portal.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(393);
  expect(bounds.bottom).toBeLessThanOrEqual(664);
});

test('the action sheet stays bottom-bound, scrollable, touch-sized, and disabled-aware', async ({
  page,
}) => {
  await page.goto(story('feedback-compatibility'));
  await page.getByTestId('sheet-canonical').tap();

  const sheet = page.getByTestId('action-sheet-surface');
  const bounds = await sheet.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
  expect(bounds!.height).toBeLessThanOrEqual(viewport!.height * 0.8 + 1);

  const danger = page.getByTestId('sheet-danger');
  expect(
    await danger.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('sheet-disabled')).toBeDisabled();
});

test('the inline-end dialog becomes a viewport panel on mobile', async ({
  page,
}) => {
  await page.goto(story('dialog-compatibility'));
  await page.getByTestId('dialog-canonical-end').tap();

  const surface = page.getByTestId('story-dialog-surface');
  const bounds = await surface.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBe(0);
  expect(bounds!.width).toBe(viewport!.width);
  expect(bounds!.height).toBe(viewport!.height);
  await expect(surface).toHaveAttribute('data-trn-layout', 'panel');

  await page.getByTestId('story-dialog-close').tap();
  await expect(page.getByTestId('dialog-canonical-end')).toBeFocused();
});
