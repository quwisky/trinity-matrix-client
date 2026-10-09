import { browser, expect } from '@wdio/globals';
import { HS_TLS } from '../../support/homeserver/start.mjs';
import { readSession } from '../../support/session.mts';
import { fillByLabel, tap, waitForRooms } from '../support/app.mts';
import { native, resetApp, shell, webview } from '../support/session.mts';

const CHROME = 'com.android.chrome';
// Chrome reads this file on debuggable images (the google_apis emulator). `_` stands for
// the program name. The homeserver's TLS front is self-signed, and a fresh Chrome would
// otherwise stop at its first-run screen and at the certificate interstitial.
const CHROME_FLAGS =
  '_ --ignore-certificate-errors --no-first-run --disable-fre --no-default-browser-check';
const CHROME_FLAGS_FILE = '/data/local/tmp/chrome-command-line';

const uiSelector = (selector: string) => $(`android=${selector}`);

/** Complete Dex's login form in the Custom Tab, through the native accessibility tree. */
async function answerDexInCustomTab(
  email: string,
  pass: string,
): Promise<void> {
  const field = (n: number) =>
    uiSelector(
      `new UiSelector().className("android.widget.EditText").instance(${n})`,
    );
  // Fallback for a Chrome that ignores the command-line file: it may put a first-run screen
  // or the certificate interstitial in front of Dex.
  const hurdles = [
    'Use without an account',
    'Accept & continue',
    'No thanks',
    'Got it',
    'Advanced',
    'Proceed to localhost (unsafe)',
  ];
  // Chrome can raise the first-run screen over a page that already loaded, so dismiss
  // hurdles on every attempt and retry the fill (the page also re-renders once).
  let lastError: unknown;
  await browser
    .waitUntil(
      async () => {
        for (const text of hurdles) {
          const button = uiSelector(
            `new UiSelector().textStartsWith("${text}")`,
          );
          if (await button.isExisting()) await button.click().catch(() => {});
        }
        try {
          await field(0).setValue(email);
          await field(1).setValue(pass);
          return true;
        } catch (error) {
          lastError = error;
          return false;
        }
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg:
          'could not fill the identity provider login in the Custom Tab',
      },
    )
    .catch((error: unknown) => {
      throw new Error(
        `${String(error)}; last fill error: ${String(lastError)}`,
      );
    });
  // Enter submits the form without dismissing the soft keyboard first.
  await browser.pressKeyCode(66);
}

/**
 * Complete Dex's login form in the SFSafariViewController that Capacitor's Browser opens on
 * iOS. Its page is part of the app's accessibility tree, so XCUITest fills it natively.
 */
async function answerDexInSafariView(
  email: string,
  pass: string,
): Promise<void> {
  // Dex's own button first: it proves the Safari view is up, so the fields below are its
  // and never the app's own sign-in form behind it.
  const login = $(
    '-ios predicate string:type == "XCUIElementTypeButton" AND label == "Login"',
  );
  await login.waitForExist({
    timeout: 90_000,
    timeoutMsg: 'the identity provider login never appeared in the Safari view',
  });
  await $('-ios predicate string:type == "XCUIElementTypeTextField"').setValue(
    email,
  );
  await $(
    '-ios predicate string:type == "XCUIElementTypeSecureTextField"',
  ).setValue(pass);
  await login.click();
}

describe('mobile SSO sign-in', () => {
  before(function skipWithoutSso(this: Mocha.Context) {
    if (readSession().homeserver?.sso) return;
    // Dex is part of the Docker stack, and of the native one when `dex` is on PATH.
    console.log(
      `[mobile] skipped: ${this.test?.parent?.fullTitle() ?? 'mobile SSO sign-in'} — the homeserver came up without Dex, so there is no SSO account`,
    );
    this.skip();
  });

  beforeEach(async () => {
    await native();
    if (browser.isIOS) {
      await resetApp();
      return;
    }
    // `adb shell` joins its arguments into one device command line, so pass the whole
    // script as the command: split into `sh -c` arguments, the redirect wrote an empty file.
    await shell(`echo '${CHROME_FLAGS}' > ${CHROME_FLAGS_FILE}`);
    const written = (await shell(`cat ${CHROME_FLAGS_FILE}`)).trim();
    if (written !== CHROME_FLAGS)
      throw new Error(`Chrome flags not written: ${JSON.stringify(written)}`);
    await shell('am', ['force-stop', CHROME]);
    await resetApp();
  });

  it('signs in through the in-app browser and returns on the eu.qwky.trinity callback', async () => {
    const sso = readSession().homeserver?.sso;
    if (!sso) throw new Error('the E2E stack came up without an SSO account');

    await fillByLabel('Homeserver', HS_TLS);
    if (browser.isIOS) {
      // As login() does: an element click reaches the button wherever the keyboard sits; a
      // touch aimed at it missed on the iOS 26.5 Simulator.
      await $('//button[normalize-space()="Continue"]').click();
      const sso = $('//button[normalize-space()="Continue with SSO"]');
      await expect(sso).toBeDisplayed({ wait: 30_000 });
      await sso.click();
    } else {
      await tap('//button[normalize-space()="Continue"]');
      await tap('//button[normalize-space()="Continue with SSO"]');
    }

    await native();
    if (browser.isIOS) await answerDexInSafariView(sso.email, sso.pass);
    else await answerDexInCustomTab(sso.email, sso.pass);

    // The homeserver redirects to eu.qwky.trinity://sso-callback, which the OS hands to the
    // app (its scene delegate on iOS); the Rooms shell appearing proves the login token was
    // exchanged.
    await webview();
    await waitForRooms(90_000);
  });
});
