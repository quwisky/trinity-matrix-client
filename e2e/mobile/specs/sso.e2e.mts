import { browser } from '@wdio/globals';
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

const uiSelector = (selector: string) => $(`android=${selector}`);

/** Complete Dex's login form in the Custom Tab, through the native accessibility tree. */
async function answerDexInCustomTab(
  email: string,
  pass: string,
): Promise<void> {
  const login = uiSelector(
    'new UiSelector().className("android.widget.EditText").instance(0)',
  );
  await browser.waitUntil(async () => login.isExisting(), {
    timeout: 60_000,
    interval: 1_000,
    timeoutMsg: 'the identity provider page never opened in the Custom Tab',
  });
  await login.click();
  await login.setValue(email);
  const password = uiSelector(
    'new UiSelector().className("android.widget.EditText").instance(1)',
  );
  await password.click();
  await password.setValue(pass);
  // Enter submits the form without needing the soft keyboard dismissed first.
  await browser.pressKeyCode(66);
}

describe('Android SSO sign-in', () => {
  beforeEach(async () => {
    await native();
    await shell('sh', [
      '-c',
      `echo '${CHROME_FLAGS}' > /data/local/tmp/chrome-command-line`,
    ]);
    await shell('am', ['force-stop', CHROME]);
    await resetApp();
  });

  it('signs in through the Custom Tab and returns on the eu.qwky.trinity callback', async () => {
    const sso = readSession().homeserver?.sso;
    if (!sso) throw new Error('the E2E stack came up without an SSO account');

    await fillByLabel('Homeserver', HS_TLS);
    await tap('//button[normalize-space()="Continue"]');
    await tap('//button[normalize-space()="Continue with SSO"]');

    await native();
    await answerDexInCustomTab(sso.email, sso.pass);

    // The homeserver redirects to eu.qwky.trinity://sso-callback, which Android hands to
    // the app; the Rooms shell appearing proves the login token was exchanged.
    await webview();
    await waitForRooms(90_000);
  });
});
