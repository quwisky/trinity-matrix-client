import { expect, test, type Locator } from '@playwright/test';
import { overlayRecipeStory } from './overlay-recipe-story-url.mts';

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
  await page.goto(overlayRecipeStory('layered-surfaces'));

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

test('dropdowns preserve keyboard, focus, disabled, and danger behavior', async ({
  page,
}) => {
  await page.goto(overlayRecipeStory('dropdowns'));
  const trigger = page.getByTestId('dropdown-trigger');

  await trigger.focus();
  await trigger.press('Enter');
  const neutral = page.getByTestId('dropdown-neutral');
  const danger = page.getByTestId('dropdown-danger');
  const disabled = page.getByTestId('dropdown-disabled');
  await expect(neutral).toBeFocused();
  await expect(disabled).toBeDisabled();
  await expect(danger).toHaveAttribute('data-trn-variant', 'danger');

  await page.keyboard.press('ArrowDown');
  await expect(danger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dropdown-result')).toHaveText('Danger chosen');
  await expect(trigger).toBeFocused();

  await trigger.press('Enter');
  await page.keyboard.press('Escape');
  await expect(neutral).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('canonical dialog placements render and restore focus', async ({
  page,
}) => {
  await page.goto(overlayRecipeStory('dialogs'));

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
  await expect(canonicalSurface).toHaveAttribute('data-trn-layout', 'panel');
  await page.getByTestId('story-dialog-close').click();
  await expect(canonicalSurface).toHaveCount(0);
  await expect(page.getByTestId('dialog-result')).toHaveText(
    'Canonical inline-end',
  );
  await expect(canonicalTrigger).toBeFocused();
});

test('alerts, sheets, and toasts render canonical semantic variants', async ({
  page,
}) => {
  await page.goto(overlayRecipeStory('feedback'));

  await page.getByTestId('alert-canonical').click();
  const canonicalAlert = page.getByTestId('alert-surface');
  await expect(page.getByTestId('alert-confirm')).toHaveAttribute(
    'data-trn-variant',
    'danger',
  );
  await expect(page.getByTestId('alert-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(canonicalAlert).toHaveCount(0);

  await page.getByTestId('sheet-canonical').click();
  const canonicalSheet = page.getByTestId('action-sheet-surface');
  await expect(page.getByTestId('sheet-danger')).toHaveAttribute(
    'data-trn-variant',
    'danger',
  );
  await expect(page.getByTestId('sheet-disabled')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(canonicalSheet).toHaveCount(0);

  await page.getByTestId('toast-warning').click();
  const warningToast = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: 'Canonical warning' });
  await expect(warningToast).toBeVisible();
  await expect(warningToast).toHaveAttribute('data-type', 'warning');

  await page.getByTestId('toast-danger').click();
  const dangerToast = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: 'Canonical danger' });
  await expect(dangerToast).toBeVisible();
  await expect(dangerToast).toHaveAttribute('data-type', 'error');
});

test('overlay behavior stays immediate under reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(overlayRecipeStory('dropdowns'));

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

  await page.goto(overlayRecipeStory('dialogs'));
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
