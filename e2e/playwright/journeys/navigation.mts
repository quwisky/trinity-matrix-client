import { expect, type Locator, type Page } from '@playwright/test';
import { isAndroidE2E } from '../support/app.mts';

export type Activate = (control: Locator) => Promise<void>;

const click: Activate = async (control) => {
  await control.click();
};

/** Drive the shared rooms-to-settings journey and verify the web modal rendered. */
export async function openSettingsFromRooms(
  page: Page,
  activate: Activate = click,
): Promise<void> {
  // Login first lands on the legacy `/rooms` spelling, then Workspace replaces it with
  // the canonical Account-qualified URL. Capture only after that startup repair settles;
  // otherwise opening the modal races the replace navigation and makes an unchanged URL
  // look as if Settings rewrote it.
  await expect(page).toHaveURL(
    (url) =>
      url.pathname.startsWith('/rooms') && url.searchParams.has('account'),
    { timeout: 20_000 },
  );
  const currentUrl = page.url();
  if (isAndroidE2E) {
    if (!new URL(page.url()).pathname.startsWith('/settings')) {
      await activate(page.getByTestId('open-settings'));
    }
    await page.waitForURL((url) => url.pathname.startsWith('/settings'), {
      timeout: 20_000,
    });
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }),
    ).toBeVisible({ timeout: 20_000 });
    return;
  }
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  if (!(await dialog.isVisible())) {
    await activate(page.getByTestId('open-settings'));
  }
  await expect(dialog).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(currentUrl);
}

/** Open Settings and choose one section without changing the current web URL. */
export async function openSettingsSection(
  page: Page,
  section: string,
): Promise<void> {
  await openSettingsFromRooms(page);
  await page.getByTestId(`settings-nav-${section}`).click();
  if (isAndroidE2E) {
    await page.waitForURL((url) => url.pathname === `/settings/${section}`, {
      timeout: 20_000,
    });
  }
  await expect(page.getByTestId('settings-detail')).not.toBeEmpty();
}

/** Close the web settings modal and wait until its focus trap is gone. */
export async function closeSettings(page: Page): Promise<void> {
  if (isAndroidE2E) {
    const back = page.getByRole('button', { name: 'Back' });
    if (new URL(page.url()).pathname !== '/settings') {
      await back.click();
      await page.waitForURL(
        (url) =>
          url.pathname === '/settings' || url.pathname.startsWith('/rooms'),
        { timeout: 20_000 },
      );
    }
    if (new URL(page.url()).pathname === '/settings') {
      await back.click();
    }
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/rooms') &&
        (url.searchParams.get('account')?.length ?? 0) > 0,
      { timeout: 20_000 },
    );
    return;
  }
  await page.getByTestId('close-settings').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
}

/** Is document.activeElement inside a component, piercing any shadow roots? */
export const focusInside = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((componentSelector) => {
    const host = document.querySelector(componentSelector);
    if (!host) return false;

    let node: Node | null = document.activeElement;
    while (node) {
      if (node === host) return true;
      const root = node.getRootNode();
      node =
        root instanceof ShadowRoot
          ? root.host
          : (node as Element).parentElement;
    }
    return false;
  }, selector);
