import { test, expect } from './support/fixtures.mts';
import { openSettingsFromRooms } from './journeys/navigation.mts';
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

  test('opens settings from rooms without replacing the room route', async ({
    page,
  }) => {
    await login(page, session);

    // rooms → settings via the user-panel settings button (in the sidebar user
    // bar). This is what the removed-behavior test below used to drive; kept as a
    // real (still-true) regression check that the plain router-outlet completes
    // the transition — no dead router.
    await openSettingsFromRooms(page);
  });

  // CDK owns the equivalent modal behavior: focus enters the named dialog, remains
  // trapped there, and returns to the persistent opener after dismissal.
  test('traps focus inside settings and restores the opener', async ({
    page,
  }) => {
    await login(page, session);

    const opener = page.getByTestId('open-settings');
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-settings-autofocus]')).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
