import { test, expect } from '@playwright/test';
import { focusInside, openSettingsFromRooms } from './journeys/navigation.mts';
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
// against is gone structurally. The accessibility behavior that rode in on the same
// config — moving focus INTO the entering page on each navigation — is reintroduced
// by NavigationFocusService (apps/trinity/src/app/navigation-focus.service.ts), wired
// via provideAppInitializer in main.ts; the second test asserts it.
const session = synapseSession();

test.describe('Route transitions', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test('navigates from rooms to settings via the settings button', async ({
    page,
  }) => {
    await login(page, session);

    // rooms → settings via the user-panel settings button (in the sidebar user
    // bar). This is what the removed-behavior test below used to drive; kept as a
    // real (still-true) regression check that the plain router-outlet completes
    // the transition — no dead router.
    await openSettingsFromRooms(page);
  });

  // NavigationFocusService moves focus into the entering page after each route
  // change (replacing Ionic's focus manager). After rooms → settings, focus should
  // land inside the settings page (its heading), not stay on the settings button
  // that triggered the navigation.
  test('relocates focus into the entering page', async ({ page }) => {
    await login(page, session);

    await page.getByTestId('open-settings').click();
    await page.waitForURL(/\/settings(\/|$)/, { timeout: 20_000 });

    await expect
      .poll(() => focusInside(page, 'trn-settings'), { timeout: 10_000 })
      .toBe(true);
  });
});
