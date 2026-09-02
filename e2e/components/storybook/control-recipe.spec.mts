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
  await expect(radioGroup).toBeVisible();
  await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();
  await page.getByTestId('radio-dark').click();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();

  const idle = page.getByTestId('toggle-idle');
  await expect(idle).toHaveAttribute('aria-pressed', 'false');
  await idle.click();
  await expect(idle).toHaveAttribute('aria-pressed', 'true');
  await idle.press('Space');
  await expect(idle).toHaveAttribute('aria-pressed', 'false');

  const selected = page.getByTestId('toggle-selected');
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await selected.focus();
  await expect
    .poll(() =>
      selected.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe('none');

  const readOnly = page.getByTestId('toggle-readonly');
  await expect(readOnly).toHaveAttribute('aria-disabled', 'true');
  await readOnly.click({ force: true });
  await expect(readOnly).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByTestId('toggle-disabled')).toBeDisabled();
});

test('toggle groups keep one tab stop and move it with arrow keys', async ({
  page,
}) => {
  await page.goto(CANONICAL);
  const group = page.getByTestId('toggle-group-canonical');
  const buttons = group.getByRole('button');
  await expect(buttons).toHaveCount(3);

  expect(
    await buttons.evaluateAll(
      (items) =>
        items.filter((item) => (item as HTMLButtonElement).tabIndex === 0)
          .length,
    ),
  ).toBe(1);

  await buttons.nth(0).focus();
  await buttons.nth(0).press('ArrowRight');
  await expect(buttons.nth(1)).toBeFocused();
  await buttons.nth(1).press('ArrowRight');
  await expect(buttons.nth(0)).toBeFocused();
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
