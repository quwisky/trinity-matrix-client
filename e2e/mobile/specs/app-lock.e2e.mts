import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import {
  SECURE_WINDOW_COMMAND,
  parseSecureWindow,
} from '../support/android-shell.mts';
import { registerUser, uniqueId } from '../support/matrix.mts';
import { onlyOn } from '../support/platform.mts';
import { resetApp, shell } from '../support/session.mts';

// App lock on Android (spec 2026-10-12). The emulator has no screen lock, so App lock runs on
// the Trinity PIN alone (decision 24). FLAG_SECURE on Trinity's window proves the app-switcher
// cover (decision 13) follows App lock. The PIN is a test value; no failure message carries it.
const PIN = '482913';
const settingsDialog = '[role="dialog"][aria-label="Settings"]';
const pinDialog = '[data-testid="app-lock-pin-dialog"]';
const cover = '[data-testid="app-lock-cover"]';

/** Type into an input after a touch tap, which focuses it as a person would. */
async function typeInto(selector: string, value: string): Promise<void> {
  await tap(selector);
  await $(selector).setValue(value);
}

/** The cover is set and cleared over the bridge after the setting changes: poll for it. */
async function expectSecureWindow(secure: boolean): Promise<void> {
  await browser.waitUntil(
    async () =>
      parseSecureWindow(await shell(SECURE_WINDOW_COMMAND)) === secure,
    {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: `FLAG_SECURE never became ${String(secure)}`,
    },
  );
}

async function openSecuritySettings(): Promise<void> {
  await tap('[data-testid="open-settings"]');
  await expect($(settingsDialog)).toBeDisplayed({ wait: 20_000 });
  // The sheet is still sliding in: tap waits for the row to hold still.
  await tap('[data-testid="settings-nav-security"]');
  await expect($('#app-lock-switch')).toExist({ wait: 20_000 });
}

async function closeSettings(): Promise<void> {
  await tap('[data-testid="close-settings"]');
  await expect($(settingsDialog)).not.toBeDisplayed({ wait: 20_000 });
}

const coverOpen = (): Promise<boolean> =>
  browser.execute(
    (selector: string) =>
      document.querySelector(selector)?.hasAttribute('open') ?? false,
    cover,
  );

describe('App lock on Android', () => {
  before(
    onlyOn(
      'android',
      'reads FLAG_SECURE from the window manager; the iOS app-switcher blur is an owner check',
    ),
  );
  beforeEach(resetApp);

  it('turns on with the PIN alone, covers the app switcher, locks, unlocks and turns off', async () => {
    const user = uniqueId('android-app-lock');
    await registerUser(user, `${user}-pass`);
    await login(user, `${user}-pass`);
    await waitForRooms();
    await expectSecureWindow(false);

    await openSecuritySettings();
    await tap('#app-lock-switch');
    await expect($(pinDialog)).toBeDisplayed({ wait: 20_000 });
    await typeInto('#app-lock-pin-input', PIN);
    await typeInto('#app-lock-pin-confirm', PIN);
    await tap(`${pinDialog} [data-testid="app-lock-pin-submit"]`);
    await expect($('[data-testid="app-lock-after"]')).toBeDisplayed({
      wait: 20_000,
    });
    // The new PIN counts at once: Change PIN works and no "no PIN" note shows.
    await expect($('[data-testid="app-lock-change-pin"]')).toBeEnabled();
    await expect($('[data-testid="app-lock-no-pin"]')).not.toExist();
    await expect(
      $('[data-testid="app-lock-screen-lock-hint"]'),
    ).toBeDisplayed();
    await expect($('[data-testid="app-lock-screen-privacy"]')).toHaveText(
      /blocks screenshots and screen recording, and hides its preview in recent apps\.$/u,
    );
    await expectSecureWindow(true);
    await closeSettings();

    // Lock after defaults to 1 minute; lock now from the account menu instead.
    await tap('[data-testid="user-menu-trigger"]');
    await tap('[data-testid="lock-trinity"]');
    await browser.waitUntil(coverOpen, {
      timeout: 20_000,
      timeoutMsg: 'the lock screen never opened',
    });
    await typeInto(`${cover} [data-testid="app-lock-pin"]`, PIN);
    await tap(`${cover} [data-testid="app-lock-pin-submit"]`);
    await browser.waitUntil(async () => !(await coverOpen()), {
      timeout: 20_000,
      timeoutMsg: 'the lock screen stayed open after the PIN',
    });
    // The cover stays on while App lock is on, locked or not.
    await expectSecureWindow(true);

    // Turning App lock off asks for the PIN again, then takes the cover down.
    await openSecuritySettings();
    // Settings reads support again as it opens: wait for it before a guarded change.
    await expect($('[data-testid="app-lock-change-pin"]')).toBeEnabled({
      wait: 20_000,
    });
    await tap('#app-lock-switch');
    await expect($(pinDialog)).toBeDisplayed({ wait: 20_000 });
    await typeInto('#app-lock-pin-input', PIN);
    await tap(`${pinDialog} [data-testid="app-lock-pin-submit"]`);
    await expect($('[data-testid="app-lock-after"]')).not.toExist({
      wait: 20_000,
    });
    await expectSecureWindow(false);
  });
});
