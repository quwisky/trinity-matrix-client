import { expect, type Locator, type Page } from '@playwright/test';

export type Activate = (control: Locator) => Promise<void>;

const click: Activate = async (control) => {
  await control.click();
};

/** Drive the shared rooms-to-settings journey and verify the route rendered. */
export async function openSettingsFromRooms(
  page: Page,
  activate: Activate = click,
): Promise<void> {
  await activate(page.getByTestId('open-settings'));
  await page.waitForURL(/\/settings(\/|$)/, { timeout: 20_000 });
  await expect(page.locator('trn-settings')).toBeVisible({ timeout: 20_000 });
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
