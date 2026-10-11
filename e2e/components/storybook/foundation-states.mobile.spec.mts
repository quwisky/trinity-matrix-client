import { expect, test } from '@playwright/test';

test('compact media controls retain the coarse-pointer target floor', async ({
  page,
}) => {
  const globals = encodeURIComponent('mode:dark;theme:trinity;density:compact');
  await page.goto(
    `/iframe.html?id=components-media-bubble--compact-file&viewMode=story&globals=${globals}`,
  );

  const file = page.getByRole('button', {
    name: /modern-interface-review\.pdf/i,
  });
  await expect(file).toBeVisible();
  const bounds = await file.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
});

test('compact banner actions retain the coarse-pointer target floor', async ({
  page,
}) => {
  const globals = encodeURIComponent('mode:dark;theme:trinity;density:compact');
  await page.goto(
    `/iframe.html?id=components-banner--accent&viewMode=story&globals=${globals}`,
  );

  const action = page.getByRole('button', { name: 'Set up' });
  await expect(action).toBeVisible();
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
});

test('banner actions wrap below the message instead of squeezing it (#1221)', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=components-banner--accent-actions&viewMode=story',
  );
  const banner = page.locator('.banner');
  const text = page.locator('.banner__text');
  const actions = page.locator('.banner__actions');
  await expect(actions.getByRole('button')).toHaveCount(2);

  const bannerBox = (await banner.boundingBox())!;
  const textBox = (await text.boundingBox())!;
  const actionsBox = (await actions.boundingBox())!;
  // The message keeps its readable minimum (12rem) rather than a word-wide column.
  const rem = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(textBox.width).toBeGreaterThanOrEqual(12 * rem);
  expect(actionsBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(
    bannerBox.x + bannerBox.width,
  );
});

test('a lone banner action leaves no blank message row (#1221)', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=components-banner--action-only&viewMode=story',
  );
  const banner = page.locator('.banner');
  const action = page.getByRole('button', { name: 'Search all messages' });
  await expect(action).toBeVisible();

  const bannerBox = (await banner.boundingBox())!;
  const actionBox = (await action.boundingBox())!;
  const padding = await banner.evaluate((element) => {
    const style = getComputedStyle(element);
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  });
  // One row: the banner is the action plus its padding, with no empty line above it.
  expect(bannerBox.height).toBeLessThanOrEqual(actionBox.height + padding + 1);
});
