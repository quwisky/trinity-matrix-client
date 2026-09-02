import { expect, test } from '@playwright/test';
import { renderedColour, renderedRecipeStyle } from './recipe-appearance.mts';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

test('canonical tab and header axes preserve compatibility rendering', async ({
  page,
}) => {
  await page.goto(story('components-tabs--compatibility-aliases'));

  for (const [canonicalId, legacyId] of [
    ['tabs-canonical-pill', 'tabs-legacy-pill'],
    ['tabs-canonical-line', 'tabs-legacy-line'],
  ] as const) {
    const canonical = page.getByTestId(canonicalId);
    const legacy = page.getByTestId(legacyId);
    expect(
      await renderedRecipeStyle(
        canonical.getByRole('tab', { name: 'General' }),
      ),
    ).toEqual(
      await renderedRecipeStyle(legacy.getByRole('tab', { name: 'General' })),
    );
    await expect(canonical.locator('hlm-tabs-list')).toHaveAttribute(
      'data-trn-variant',
      'neutral',
    );
  }

  await page.goto(story('components-page-header--compatibility-aliases'));
  for (const [canonicalId, legacyId, layout] of [
    ['header-canonical-page', 'header-legacy-page', 'page'],
    ['header-canonical-toolbar', 'header-legacy-toolbar', 'toolbar'],
  ] as const) {
    const canonical = page.getByTestId(canonicalId).locator('header');
    const legacy = page.getByTestId(legacyId).locator('header');
    expect(await renderedRecipeStyle(canonical)).toEqual(
      await renderedRecipeStyle(legacy),
    );
    await expect(canonical).toHaveAttribute('data-trn-layout', layout);
    await expect(canonical).toHaveAttribute('data-trn-variant', 'neutral');
  }
});

test('tabs preserve keyboard, focus, disabled, and selected behavior', async ({
  page,
}) => {
  await page.goto(story('components-tabs--with-disabled-tab'));
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);

  await tabs.nth(0).focus();
  await tabs.nth(0).press('ArrowRight');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(1)).toBeDisabled();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Members' })).toBeVisible();
  await expect
    .poll(() =>
      tabs.nth(2).evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe('none');
});

test('manual tab activation moves focus before selection', async ({ page }) => {
  await page.goto(story('components-tabs--manual-activation'));
  const general = page.getByRole('tab', { name: 'General' });
  const access = page.getByRole('tab', { name: 'Access' });

  await general.focus();
  await general.press('ArrowRight');
  await expect(access).toBeFocused();
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect(access).toHaveAttribute('aria-selected', 'false');

  await access.press('Enter');
  await expect(access).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Access' })).toBeVisible();
});

test('cards and separators expose only their bounded visual choices', async ({
  page,
}) => {
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

  await page.goto(story('components-separator--semantic-treatments'));
  const neutral = page.getByTestId('separator-neutral');
  const accent = page.getByTestId('separator-accent');
  await expect(neutral).toHaveAttribute('data-variant', 'neutral');
  await expect(accent).toHaveAttribute('data-variant', 'accent');
  expect(await renderedColour(accent, 'backgroundColor')).toEqual(
    await renderedColour(accent, '--trinity-state-attention-surface'),
  );
  expect(await renderedColour(neutral, 'backgroundColor')).toEqual(
    await renderedColour(neutral, '--trinity-border-control'),
  );
});
