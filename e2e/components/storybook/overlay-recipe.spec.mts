import { expect, test, type Locator } from '@playwright/test';
import { renderedRecipeStyle } from './recipe-appearance.mts';

const story = (name: string) =>
  `/iframe.html?id=components-overlay-recipes--${name}&viewMode=story`;

const overlayStyle = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      color: style.color,
    };
  });

test('one layered surface recipe renders identically in the document and portal', async ({
  page,
}) => {
  await page.goto(story('layered-surfaces'));

  const documentSurface = page.getByTestId('document-overlay-surface');
  const portalSurface = page.getByTestId('portal-overlay-surface');
  await expect(portalSurface).toBeVisible();
  expect(await overlayStyle(portalSurface)).toEqual(
    await overlayStyle(documentSurface),
  );
  await expect(portalSurface).toHaveAttribute('data-trn-variant', 'neutral');
  await expect(portalSurface).toHaveAttribute('data-trn-size', 'sm');
  expect(
    await portalSurface.evaluate(
      (element) =>
        element.closest('.cdk-overlay-container')?.parentElement ===
        document.body,
    ),
  ).toBe(true);

  await documentSurface.click();
  await expect(portalSurface).toHaveCount(0);
  await page.getByTestId('anchored-overlay-trigger').click();
  await expect(portalSurface).toBeVisible();
});

test('dropdowns preserve keyboard, focus, disabled, danger, and compatibility behavior', async ({
  page,
}) => {
  await page.goto(story('dropdown-compatibility'));
  const trigger = page.getByTestId('dropdown-trigger');

  await trigger.focus();
  await trigger.press('Enter');
  const neutral = page.getByTestId('dropdown-neutral');
  const danger = page.getByTestId('dropdown-danger');
  const legacyDanger = page.getByTestId('dropdown-legacy-danger');
  const disabled = page.getByTestId('dropdown-disabled');
  await expect(neutral).toBeFocused();
  await expect(disabled).toBeDisabled();
  await expect(danger).toHaveAttribute('data-trn-variant', 'danger');
  await expect(legacyDanger).toHaveAttribute('data-trn-variant', 'danger');
  expect(await overlayStyle(danger)).toEqual(await overlayStyle(legacyDanger));

  await page.keyboard.press('ArrowDown');
  await expect(danger).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(legacyDanger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dropdown-result')).toHaveText(
    'Legacy danger chosen',
  );
  await expect(trigger).toBeFocused();

  await trigger.press('Enter');
  await page.keyboard.press('Escape');
  await expect(neutral).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('canonical and legacy dialog placements share geometry and restore focus', async ({
  page,
}) => {
  await page.goto(story('dialog-compatibility'));

  const centerTrigger = page.getByTestId('dialog-canonical-center');
  await centerTrigger.click();
  const centerDialog = page.getByRole('dialog', {
    name: 'Canonical center dialog',
  });
  await expect(centerDialog).toBeVisible();
  await expect(page.getByTestId('story-dialog-close')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('story-dialog-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(centerDialog).toHaveCount(0);
  await expect(centerTrigger).toBeFocused();

  const canonicalTrigger = page.getByTestId('dialog-canonical-end');
  await canonicalTrigger.click();
  const canonicalSurface = page.getByTestId('story-dialog-surface');
  const canonicalBounds = await canonicalSurface.boundingBox();
  const canonicalStyle = await overlayStyle(canonicalSurface);
  await page.getByTestId('story-dialog-close').click();
  await expect(canonicalSurface).toHaveCount(0);

  const legacyTrigger = page.getByTestId('dialog-legacy-end');
  await legacyTrigger.click();
  const legacySurface = page.getByTestId('story-dialog-surface');
  await expect(legacySurface).toHaveAttribute('data-trn-layout', 'panel');
  await expect.poll(() => legacySurface.boundingBox()).toEqual(canonicalBounds);
  await expect.poll(() => overlayStyle(legacySurface)).toEqual(canonicalStyle);
  await page.getByTestId('story-dialog-close').click();
  await expect(page.getByTestId('dialog-result')).toHaveText('Legacy end');
  await expect(legacyTrigger).toBeFocused();
});

test('alerts, sheets, and toasts normalize canonical and temporary legacy forms', async ({
  page,
}) => {
  await page.goto(story('feedback-compatibility'));

  await page.getByTestId('alert-canonical').click();
  const canonicalAlert = page.getByTestId('alert-surface');
  const canonicalAlertStyle = await overlayStyle(canonicalAlert);
  const canonicalConfirmStyle = await renderedRecipeStyle(
    page.getByTestId('alert-confirm'),
  );
  await expect(page.getByTestId('alert-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(canonicalAlert).toHaveCount(0);

  await page.getByTestId('alert-legacy').click();
  const legacyAlert = page.getByTestId('alert-surface');
  await expect(legacyAlert).toHaveAttribute('data-trn-layout', 'dialog');
  await expect
    .poll(() => overlayStyle(legacyAlert))
    .toEqual(canonicalAlertStyle);
  await expect
    .poll(() => renderedRecipeStyle(page.getByTestId('alert-confirm')))
    .toEqual(canonicalConfirmStyle);
  await page
    .locator('.cdk-overlay-backdrop')
    .click({ position: { x: 1, y: 1 } });
  await expect(legacyAlert).toHaveCount(0);

  await page.getByTestId('sheet-canonical').click();
  const canonicalSheet = page.getByTestId('action-sheet-surface');
  const canonicalSheetStyle = await overlayStyle(canonicalSheet);
  const canonicalDangerStyle = await renderedRecipeStyle(
    page.getByTestId('sheet-danger'),
  );
  await expect(page.getByTestId('sheet-disabled')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(canonicalSheet).toHaveCount(0);

  await page.getByTestId('sheet-legacy').click();
  const legacySheet = page.getByTestId('action-sheet-surface');
  await expect(legacySheet).toHaveAttribute('data-trn-layout', 'sheet');
  await expect
    .poll(() => overlayStyle(legacySheet))
    .toEqual(canonicalSheetStyle);
  await expect
    .poll(() => renderedRecipeStyle(page.getByTestId('sheet-legacy-danger')))
    .toEqual(canonicalDangerStyle);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByTestId('toast-warning').click();
  await expect(
    page.getByText('Canonical warning', { exact: true }),
  ).toBeVisible();
  await page.getByTestId('toast-danger').click();
  await expect(
    page.getByText('Canonical danger', { exact: true }),
  ).toBeVisible();
  await page.getByTestId('toast-legacy').click();
  await expect(
    page.getByText('Legacy destructive', { exact: true }),
  ).toBeVisible();
});

test('overlay behavior stays immediate under reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(story('dropdown-compatibility'));

  await page.getByTestId('dropdown-trigger').click();
  const menu = page.locator('[trnDropdownMenu]');
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((element) => {
      const duration = getComputedStyle(element).animationDuration;
      return duration.endsWith('ms')
        ? Number.parseFloat(duration)
        : Number.parseFloat(duration) * 1000;
    }),
  ).toBeLessThanOrEqual(0.01);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.goto(story('dialog-compatibility'));
  await page.getByTestId('dialog-canonical-center').click();
  const surface = page.getByTestId('story-dialog-surface');
  await expect(surface).toBeVisible();
  expect(
    await surface.evaluate((element) => {
      const duration = getComputedStyle(element).transitionDuration;
      return duration.endsWith('ms')
        ? Number.parseFloat(duration)
        : Number.parseFloat(duration) * 1000;
    }),
  ).toBeLessThanOrEqual(0.01);
  await page.keyboard.press('Escape');
  await expect(surface).toHaveCount(0);
});
