import { expect, test, type Locator } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;
const CANONICAL = story('components-field-controls--canonical-states');

const box = (locator: Locator) =>
  locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { height: bounds.height, width: bounds.width };
  });

test('field controls preserve native names, descriptions and validation', async ({
  page,
}) => {
  await page.goto(CANONICAL);

  const roomName = page.getByRole('textbox', { name: 'Room name' });
  await expect(roomName).toHaveAttribute('data-size', 'sm');
  await roomName.focus();
  await expect(roomName).toBeFocused();
  await expect
    .poll(() =>
      roomName.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe('none');

  const invalid = page.getByRole('textbox', { name: 'Server name' });
  await expect(invalid).toHaveAttribute('aria-invalid', 'true');
  await expect(invalid).toHaveAttribute(
    'aria-describedby',
    'server-name-error',
  );
  await expect(page.locator('#server-name-error')).toHaveText(
    'Enter a valid server name.',
  );

  const topic = page.getByRole('textbox', { name: 'Room topic' });
  await expect(topic).toHaveAttribute('data-size', 'lg');
  await expect(topic).toHaveAttribute('aria-describedby', 'room-topic-help');
});

test('ordinal text sizes and owned select layout resolve in the browser', async ({
  page,
}) => {
  await page.goto(CANONICAL);

  const smallInput = page.getByTestId('field-input-small');
  const largeTextarea = page.getByTestId('field-textarea-large');
  expect((await box(largeTextarea)).height).toBeGreaterThan(
    (await box(smallInput)).height,
  );

  const selectHost = page.getByTestId('field-select');
  const select = page.getByRole('combobox', { name: 'Message density' });
  await expect(selectHost).toHaveCSS('display', 'block');
  expect((await box(select)).width).toBeCloseTo(
    (await box(selectHost)).width,
    0,
  );
  await expect(select).toHaveText('Comfortable');

  await select.click();
  await page.getByRole('option', { name: 'Compact' }).click();
  await expect(select).toHaveText('Compact');

  await select.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Comfortable' })).toBeVisible();
  await select.press('Escape');
  await expect(select).toBeFocused();
});
