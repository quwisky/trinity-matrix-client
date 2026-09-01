import { expect, test, type Locator } from '@playwright/test';

const STORY =
  '/iframe.html?id=components-button--canonical-and-compatibility&viewMode=story';

const recipeStyle = (control: Locator) =>
  control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      color: style.color,
      height: style.height,
      paddingBlock: style.paddingBlock,
      paddingInline: style.paddingInline,
      width: style.width,
    };
  });

test('canonical button recipes render like their compatibility inputs', async ({
  page,
}) => {
  await page.goto(STORY);

  const canonicalPrimary = page.getByTestId('canonical-primary');
  const canonicalDanger = page.getByTestId('canonical-danger');
  const canonicalIcon = page.getByTestId('canonical-icon');
  await expect(canonicalPrimary).toBeVisible();
  await expect(canonicalDanger).toBeVisible();
  await expect(canonicalIcon).toBeVisible();

  await expect
    .poll(() => recipeStyle(canonicalPrimary))
    .toEqual(await recipeStyle(page.getByTestId('legacy-primary')));
  await expect
    .poll(() => recipeStyle(canonicalDanger))
    .toEqual(await recipeStyle(page.getByTestId('legacy-danger')));
  await expect
    .poll(() => recipeStyle(canonicalIcon))
    .toEqual(await recipeStyle(page.getByTestId('legacy-icon')));

  expect(await recipeStyle(canonicalDanger)).not.toEqual(
    await recipeStyle(canonicalPrimary),
  );
});
