import { expect, test } from '../../../fixtures.mts';
import {
  configureSettingsSuite,
  openSection,
} from '../../support/settings-journey.mts';

interface ResetDebugWindow extends Window {
  ng: {
    getComponent(element: Element): {
      config: {
        entries: Array<{
          path: string;
          reset: () => unknown;
        }>;
      };
    };
  };
}

test.describe('Preference reset recovery', () => {
  configureSettingsSuite();

  test('gates reset and presents value-free outstanding work', async ({
    page,
  }, testInfo) => {
    await openSection(page, 'advanced');
    await page.getByTestId('advanced-reset').click();

    const confirmation = page.getByLabel('Type DEFAULTS to confirm');
    await expect(confirmation).toBeVisible();
    await expect(page.getByText('Unsent message drafts')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('advanced-reset-partial')).toHaveCount(0);

    await page.evaluate(() => {
      const root = document.querySelector('trn-advanced-settings');
      if (!root) throw new Error('Advanced Settings unavailable');
      const component = (window as unknown as ResetDebugWindow).ng.getComponent(
        root,
      );
      const entry = component.config.entries.find(
        (candidate) => candidate.path === 'appearance.theme',
      );
      if (!entry) throw new Error('Appearance Theme entry unavailable');
      entry.reset = () => Promise.reject(new Error('injected reset failure'));
    });

    await page.getByTestId('advanced-reset').click();
    await page.getByLabel('Type DEFAULTS to confirm').fill('DEFAULTS');
    await page.getByRole('button', { name: 'Reset settings' }).click();

    const partial = page.getByTestId('advanced-reset-partial');
    await expect(partial).toBeVisible();
    await expect(partial).toContainText('appearance.theme — failed');
    await expect(partial).not.toContainText('{');
    await expect(
      partial.getByRole('button', { name: 'Retry outstanding settings' }),
    ).toBeVisible();
    await testInfo.attach('preference-reset-partial', {
      body: await partial.screenshot(),
      contentType: 'image/png',
    });
  });
});
