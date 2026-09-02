import { expect, test } from '@playwright/test';
import { overlayRecipeStory } from './overlay-recipe-story-url.mts';

test('WebKit renders and dismisses portal surfaces with focus restoration', async ({
  page,
}) => {
  await page.goto(overlayRecipeStory('layered-surfaces'));
  const portal = page.getByTestId('portal-overlay-surface');
  await expect(portal).toBeVisible();
  await page.getByTestId('document-overlay-surface').click();
  await expect(portal).toHaveCount(0);

  await page.goto(overlayRecipeStory('dialog-compatibility'));
  const trigger = page.getByTestId('dialog-canonical-center');
  await trigger.click();
  const surface = page.getByTestId('story-dialog-surface');
  await expect(surface).toBeVisible();
  await expect(page.getByTestId('story-dialog-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(surface).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
