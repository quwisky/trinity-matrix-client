import { expect, type Locator, type Page } from '@playwright/test';

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
  await expect(page.getByTestId('settings-detail')).not.toBeEmpty();
}

/** Close the web settings modal and wait until its focus trap is gone. */
export async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId('close-settings').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
}

/**
 * Open System Status from the rooms shell. The global banner slot shows one banner at a
 * time, so a limited-capability summary can be hidden behind the encryption prompt; the
 * sidebar button (or the room overflow menu on a phone) is always reachable.
 */
export async function openSystemStatusFromRooms(page: Page): Promise<void> {
  const sidebar = page.getByTestId('open-system-status');
  if (await sidebar.isVisible()) {
    await sidebar.click();
    return;
  }
  await page.getByTestId('room-actions-overflow').click();
  await page.getByTestId('overflow-open-system-status').click();
}
