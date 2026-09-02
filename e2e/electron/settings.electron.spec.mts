import { expect, test, type Page } from './fixtures.mts';

import { login, synapseSession, type Navigate } from '../support/app.mts';
import { launchApp } from './support/launch.mts';

const session = synapseSession();

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

test.describe('Electron settings geometry', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps settings overflow in one painted detail scrollbar', async () => {
    test.slow();
    const app = await launchApp();

    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        // Outer window size, not a synthetic renderer viewport: native menu/title-bar
        // chrome consumes part of this height before Angular receives its parent box.
        BrowserWindow.getAllWindows()[0]?.setSize(1024, 620);
      });
      await login(page, session, electronNavigate);
      const roomUrl = page.url();
      await page.getByTestId('open-settings').click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page).toHaveURL(roomUrl);
      // The Appearance page is intentionally used for the native geometry proof:
      // unlike Notifications, its overflow does not depend on account seed data.
      await page.getByTestId('settings-nav-appearance').click();
      await expect(page.getByTestId('mode-dark')).toBeVisible({
        timeout: 30_000,
      });

      const geometry = await page.evaluate(() => {
        const nav = document.querySelector<HTMLElement>('.settings-nav');
        const detail = document.querySelector<HTMLElement>(
          '[data-testid=settings-detail]',
        );
        const workspace = document.querySelector<HTMLElement>(
          '[data-testid=settings-workspace]',
        );
        if (!nav || !detail || !workspace) {
          throw new Error('settings geometry is incomplete');
        }
        const navStyle = getComputedStyle(nav);
        const detailStyle = getComputedStyle(detail);
        const frame = workspace.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentOverflow:
            document.documentElement.scrollHeight -
            document.documentElement.clientHeight,
          nav: {
            overflows: nav.scrollHeight > nav.clientHeight + 1,
            scrollbarWidth: navStyle.scrollbarWidth,
            webkitDisplay: getComputedStyle(nav, '::-webkit-scrollbar').display,
          },
          detail: {
            overflows: detail.scrollHeight > detail.clientHeight + 1,
            overflowY: detailStyle.overflowY,
            scrollbarWidth: detailStyle.scrollbarWidth,
            webkitDisplay: getComputedStyle(detail, '::-webkit-scrollbar')
              .display,
          },
          frame: {
            top: frame.top,
            right: frame.right,
            bottom: frame.bottom,
            left: frame.left,
          },
        };
      });

      expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(geometry.nav.overflows).toBe(true);
      expect(
        geometry.nav.scrollbarWidth === 'none' ||
          geometry.nav.webkitDisplay === 'none',
      ).toBe(true);
      expect(geometry.detail).toMatchObject({
        overflows: true,
        overflowY: 'auto',
      });
      expect(geometry.detail.scrollbarWidth).not.toBe('none');
      expect(geometry.detail.webkitDisplay).not.toBe('none');
      expect(geometry.frame.left).toBeGreaterThan(0);
      expect(geometry.frame.right).toBeLessThan(geometry.viewport.width);
      expect(geometry.frame.top).toBeGreaterThan(0);
      expect(geometry.frame.bottom).toBeLessThanOrEqual(
        geometry.viewport.height + 1,
      );

      const theme = page.getByTestId('theme-select').getByRole('combobox');
      await theme.focus();
      await expect(theme).toBeFocused();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await theme.click();
      const themeOverlay = page.locator('hlm-select-content').first();
      await expect(themeOverlay).toBeVisible();
      expect(
        await themeOverlay.evaluate(
          (element) => getComputedStyle(element).animationName,
        ),
      ).toBe('none');
      await page.getByTestId('theme-amethyst').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        'amethyst',
      );

      await page.getByTestId('density-select').getByRole('combobox').click();
      await page.getByTestId('density-compact').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-density',
        'compact',
      );
    } finally {
      await app.close();
    }
  });
});
