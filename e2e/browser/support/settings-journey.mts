import { devices, expect, test, type Page } from '../../fixtures.mts';
import { isAndroidE2E, login, synapseSession } from '../../support/app.mts';
import { openSettingsFromRooms } from '../../support/journeys/navigation.mts';

// Authenticated journeys through Settings — theme switching, profile editing,
// device management, and the responsive section submenu (two-pane on desktop,
// list → sub-page on mobile). They need a live homeserver, so the suite skips
// itself when the disposable Synapse wasn't available (no Docker).
export const session = synapseSession();
export const PIXEL_5 = devices['Pixel 5'];

export const SECTIONS = [
  'profile',
  'presence',
  'appearance',
  'devices',
  'account',
  'security',
  'notifications',
  'server',
  'privacy',
  'gifs',
  'stickers',
  'shortcuts',
  'experimental',
  'advanced',
];

// A 1x1 transparent PNG — a valid image the homeserver accepts as an avatar.
export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const hasDarkMode = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

/** The active Theme, reflected as <html data-theme>; null for the default. */
export const themeAttr = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));

/** Open a section inside whichever Settings surface the host owns. */
export async function openSection(page: Page, path: string): Promise<void> {
  await page.getByTestId(`settings-nav-${path}`).click();
  if (isAndroidE2E) {
    await page.waitForURL((url) => url.pathname === `/settings/${path}`, {
      timeout: 20_000,
    });
  }
  await expect(page.getByTestId('settings-detail')).not.toBeEmpty();
}

/** Difference between the title text edge and the navigation's content edge. */
export async function settingsTitleAlignment(page: Page): Promise<number> {
  return page.locator('[data-settings-autofocus]').evaluate((title) => {
    const nav = document.querySelector<HTMLElement>(
      'nav[aria-label="Settings sections"]',
    );
    const text = title.firstChild;
    if (!nav || !text) throw new Error('settings title geometry missing');

    const range = document.createRange();
    range.selectNodeContents(text);
    const textRect = range.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const navStyle = getComputedStyle(nav);
    const paddingStart = Number.parseFloat(navStyle.paddingInlineStart);

    return navStyle.direction === 'rtl'
      ? navRect.right - paddingStart - textRect.right
      : textRect.left - (navRect.left + paddingStart);
  });
}

/** Register the shared authenticated settings setup in each focused spec. */
export function configureSettingsSuite(): void {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.beforeEach(async ({ page }) => {
    await login(page, session);
    await openSettingsFromRooms(page);
    // The host-owned shell loads; on the desktop viewport it auto-lands on Profile.
    await expect(page.getByTestId('settings-nav-profile')).toBeVisible({
      timeout: 20_000,
    });
  });
}
