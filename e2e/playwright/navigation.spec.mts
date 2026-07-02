import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// Historical context: this file used to guard the IonRouterOutlet transition lock
// (ionic-framework#30240) — a route transition had to relocate focus INTO the
// entering page, otherwise a control that triggered the navigation stayed focused
// inside the LEAVING page; once IonRouterOutlet's StackController set aria-hidden on
// that page, recent Chromium/Electron would refuse to hide a focused subtree and the
// transition promise stalled (blank entering page + dead router). Ionic supplied the
// fix via `provideIonicAngular({ focusManagerPriority: […] })` in
// apps/trinity/src/main.ts (commit 58dab21).
//
// Phase 4e ("build(shell): remove @ionic entirely", commit fb2be88) dropped Ionic —
// and `provideIonicAngular` with it — from main.ts. The shell now renders a plain
// Angular `<router-outlet>` (see apps/trinity/src/app/app.component.html) with no
// StackController/aria-hidden step, so the dead-router failure mode this file guarded
// against is gone structurally, not just papered over. But the accessibility behavior
// that rode in on the same config is *also* gone: nothing moves focus into the
// entering page on navigation any more (see the quarantined test below).
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

  test('navigates from rooms to settings via the toolbar button', async ({
    page,
  }) => {
    await login(page, session);

    // rooms → settings via the toolbar button. This is what the removed-behavior
    // test below used to drive; kept as a real (still-true) regression check that
    // the plain router-outlet completes the transition — no dead router.
    await page.getByTestId('open-settings').click();
    await page.waitForURL('**/settings', { timeout: 20_000 });
    await expect(page.locator('trn-settings')).toBeVisible({
      timeout: 20_000,
    });
  });

  // QUARANTINED — targets behavior that no longer exists (see the file header).
  // `test.fixme(title, body)` declares the test without running it, so it can't
  // fail a live run, but it also stays visible (not silently deleted) as a
  // tracked a11y gap: Ionic used to move focus into the entering page on every
  // route change for keyboard/screen-reader users; the plain Angular
  // router-outlet that replaced IonRouterOutlet does not. Left as `test.fixme`
  // rather than rewritten to assert "focus does NOT move" — a green test
  // asserting the absence would read as an intentional spec instead of a known
  // regression to raise with the app owner. Un-fixme (and keep the assertion
  // below) if/when focus management is reintroduced on the router-outlet.
  test.fixme('relocates focus into the entering page', async ({ page }) => {
    await login(page, session);

    await page.getByTestId('open-settings').click();
    await page.waitForURL('**/settings', { timeout: 20_000 });

    // Would need the app to explicitly move focus on navigation — nothing does
    // this today, so this currently sits at `false` indefinitely.
    await expect
      .poll(() => focusInside(page, 'trn-settings'), { timeout: 10_000 })
      .toBe(true);
  });
});
