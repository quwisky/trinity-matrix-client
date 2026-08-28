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
