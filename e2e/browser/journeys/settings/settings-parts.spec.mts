import { expect, test } from '../../../fixtures.mts';
import { configureSettingsSuite } from '../../support/settings-journey.mts';

// Each settings section lists its parts (groups) in the nav; a part is reachable from the
// URL fragment and the nav row follows the scroll. Appearance is the section with parts.
test.describe('Settings parts', () => {
  configureSettingsSuite();

  test('deep-links to a part, scrolls on click, and follows the scroll', async ({
    page,
  }) => {
    await page.goto('/settings/appearance#timeline');
    const timeline = page.locator('#part-timeline');
    await expect(timeline).toBeInViewport({ timeout: 20_000 });
    await expect(page.getByTestId('settings-part-timeline')).toHaveAttribute(
      'aria-current',
      'location',
    );

    await page.getByTestId('settings-part-code').click();
    await expect(page).toHaveURL(/\/settings\/appearance#code$/);
    await expect(page.locator('#part-code')).toBeInViewport();
    await expect(page.locator('#part-code')).toBeFocused();

    await page.getByTestId('settings-detail').hover();
    await page.mouse.wheel(0, -10_000);
    await expect(
      page.getByTestId('settings-part-mode-and-theme'),
    ).toHaveAttribute('aria-current', 'location');
    await expect(page).toHaveURL(/\/settings\/appearance$/);
  });

  test('opens at the top and clears the fragment for an unknown part', async ({
    page,
  }) => {
    await page.goto('/settings/appearance#nope');
    await expect(page.getByTestId('mode-dark')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(page.locator('#part-mode-and-theme')).toBeInViewport();
  });
});
