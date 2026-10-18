import { browser, expect } from '@wdio/globals';
import { HS_TLS } from '../../support/homeserver/start.mjs';
import { readSession } from '../../support/session.mts';
import { fillByLabel, tap, waitForRooms } from '../support/app.mts';
import { native, resetApp, webview } from '../support/session.mts';

describe('mobile SSO sign-in', () => {
  before(function skipWithoutSso(this: Mocha.Context) {
    const sso = readSession().homeserver?.sso;
    const title = this.test?.parent?.fullTitle() ?? 'mobile SSO sign-in';
    if (!sso) {
      // Dex is part of the Docker stack, and of the native one when `dex` is on PATH.
      console.log(
        `[mobile] skipped: ${title} — the homeserver came up without Dex, so there is no SSO account`,
      );
      this.skip();
    }
    // XCUITest drops keystrokes typed into the authentication session on the iOS 26.5
    // Simulator, and the keyboard's accessory bar covers Dex's Login button, so iOS signs in
    // only through Dex's form-free mock connector. A homeserver shared with suites that fill
    // Dex's form (pnpm e2e:all) keeps the form, so the spec has nothing it can drive.
    if (browser.isIOS && !sso?.mock) {
      console.log(
        `[mobile] skipped on ios: ${title} — the homeserver uses Dex's password form; start it with TRINITY_E2E_SSO_PROVIDER=mock`,
      );
      this.skip();
    }
  });

  beforeEach(async () => {
    await native();
    await resetApp();
  });

  it('signs in on iOS through an authentication session that returns the callback to the app', async function (this: Mocha.Context) {
    if (!browser.isIOS) this.skip();

    await fillByLabel('Homeserver', HS_TLS);
    // As login() does: an element click reaches the button wherever the keyboard sits; a
    // touch aimed at it missed on the iOS 26.5 Simulator.
    await $('//button[normalize-space()="Continue"]').click();
    const sso = $('//button[normalize-space()="Continue with SSO"]');
    await expect(sso).toBeDisplayed({ wait: 30_000 });
    await sso.click();

    // The ephemeral session shows no consent prompt; it hands the
    // dev.trinityproject.trinity://sso-callback redirect straight back to the app. The Rooms
    // shell appearing proves the login token was exchanged.
    await webview();
    await waitForRooms(90_000);
  });

  it('explains on Android that the server’s SSO is not offered in the app', async function (this: Mocha.Context) {
    if (browser.isIOS) this.skip();

    await fillByLabel('Homeserver', HS_TLS);
    await tap('//button[normalize-space()="Continue"]');

    await expect($('[data-testid="sso-unavailable"]')).toHaveText(
      "This server's single sign-on isn't supported in the Android app yet. Sign in on the web or desktop app.",
      { wait: 30_000 },
    );
    await expect(
      $('//button[normalize-space()="Continue with SSO"]'),
    ).not.toBeExisting();
  });
});
