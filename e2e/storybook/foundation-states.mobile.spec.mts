import { expect, test } from '@playwright/test';

test('compact media controls retain the coarse-pointer target floor', async ({
  page,
}) => {
  const globals = encodeURIComponent(
    'mode:dark;palette:trinity;density:compact',
  );
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
