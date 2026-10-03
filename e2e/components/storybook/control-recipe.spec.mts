import { expect, test, type Locator } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;
const CANONICAL = story('components-choice-controls--canonical-states');

const box = (locator: Locator) =>
  locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { height: bounds.height, width: bounds.width };
  });

test('choice controls expose accessible interaction states', async ({
  page,
}) => {
  await page.goto(CANONICAL);

  const checkbox = page.getByTestId('checkbox-invalid').getByRole('checkbox');
  await expect(checkbox).toHaveAttribute('aria-invalid', 'true');
  await expect(checkbox).toHaveAttribute('aria-describedby', 'checkbox-error');

  const activeCheckboxHost = page.getByTestId('checkbox-accent');
  const activeCheckbox = activeCheckboxHost.getByRole('checkbox');
  await expect(activeCheckbox).toBeChecked();
  await activeCheckboxHost.click();
  await expect(activeCheckbox).not.toBeChecked();

  const activeSwitchHost = page.getByTestId('switch-accent');
  const activeSwitch = activeSwitchHost.getByRole('switch');
  await expect(activeSwitch).toBeChecked();
  await activeSwitchHost.click();
  await expect(activeSwitch).not.toBeChecked();

  const disabledSwitch = page
    .getByTestId('switch-disabled')
    .getByRole('switch');
  await expect(disabledSwitch).toBeDisabled();

  const radioGroup = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(page.getByTestId('radio-canonical')).toHaveCSS(
    'display',
    'block',
  );
  await expect(radioGroup).toBeVisible();
  await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();
  await page.getByTestId('radio-dark').click();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
});

test('ordinal sizes resolve canonically', async ({ page }) => {
  await page.goto(CANONICAL);
  const smallCheckbox = page
    .getByTestId('checkbox-invalid')
    .locator(':scope > span');
  const mediumCheckbox = page
    .getByTestId('checkbox-accent')
    .locator(':scope > span');
  expect(await box(smallCheckbox)).toEqual({ height: 14, width: 14 });
  expect(await box(mediumCheckbox)).toEqual({ height: 16, width: 16 });
});

test('buttons announce loading while native disabled remains authoritative', async ({
  page,
}) => {
  await page.goto(story('components-button--canonical-states'));
  const loading = page.getByTestId('canonical-loading');

  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(loading).toBeDisabled();
});
