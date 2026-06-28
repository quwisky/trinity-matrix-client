import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// Regression for the IonRouterOutlet transition lock (ionic-framework#30240): a route
// transition must relocate focus INTO the entering page, otherwise a control activated
// to trigger the navigation stays focused inside the LEAVING page when it's aria-hidden,
// which stalls the transition on recent Chromium/Electron (blank page + dead router).
// Guards the `focusManagerPriority` config in apps/trinity/src/main.ts.
const session = synapseSession();

/** Is `document.activeElement` inside the given page component (piercing shadow roots)? */
const focusInside = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((sel) => {
    const host = document.querySelector(sel);
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

test.describe('Route transitions', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test('relocates focus into the entering page', async ({ page }) => {
    await login(page, session);

    // rooms → settings via the toolbar button (a focus-retaining activation).
    await page.getByTestId('open-settings').click();
    await page.waitForURL('**/settings', { timeout: 20_000 });

    // Ionic's focus manager must move focus into the entering page on afterTransition;
    // without the config it stays on body / the activating control in the leaving page.
    await expect
      .poll(() => focusInside(page, 'trn-settings'), { timeout: 10_000 })
      .toBe(true);
  });
});
