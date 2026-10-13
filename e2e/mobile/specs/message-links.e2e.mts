import { browser, expect } from '@wdio/globals';
import { login, tap } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  sendFormattedMessage,
  uniqueId,
} from '../support/matrix.mts';
import { APP_PACKAGE, native, resetApp, webview } from '../support/session.mts';

/** XCUITest and UiAutomator2 both report 4 for an app in the foreground. */
const RUNNING_IN_FOREGROUND = 4;

/** The settle wait's timeout message: the app never left the foreground. */
const STAYED_IN_FOREGROUND = 'the app stayed in the foreground';

const pathname = async (): Promise<string> =>
  new URL(await browser.getUrl()).pathname;

/** The app's state as the OS reports it; read from the native context. */
const appState = async (): Promise<number> =>
  (await browser.execute(
    'mobile: queryAppState',
    browser.isIOS ? { bundleId: APP_PACKAGE } : { appId: APP_PACKAGE },
  )) as number;

// Owner decision 8 (spec part D): a message link must leave the WebView. The page it
// opens must never replace Trinity inside the app's own WebView; where it would, the
// platform sends message links through ExternalBrowserService (the in-app browser sheet).
describe('message links on a phone', () => {
  it('opens an external message link outside the app’s WebView', async () => {
    await resetApp();
    const user = uniqueId('message-link');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    const token = await accessToken(user, pass);
    const roomName = `Links ${user}`;
    const roomId = await createRoom(token, roomName);
    await sendFormattedMessage(
      token,
      roomId,
      'external check https://example.org/trinity-link-check',
      'external check <a href="https://example.org/trinity-link-check">the external page</a>',
    );

    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    const roomButton = `//button[contains(@class,"channel")][contains(.,"${roomName}")]`;
    await expect($(roomButton)).toBeDisplayed({ wait: 30_000 });
    await tap(roomButton);
    const link = '//a[contains(@href,"example.org/trinity-link-check")]';
    await expect($(link)).toBeDisplayed({ wait: 30_000 });
    const roomPath = await pathname();

    await tap(link);
    await native();
    // Settle: give the OS up to 10 s to bring the system browser to the front. Keep the
    // result: a no-op window.open (or an Android launch with no browser to handle it) leaves
    // the app in the foreground, and must fail rather than pass as "left the WebView".
    // Only the timeout means "stayed in the foreground"; a failing queryAppState (a driver or
    // capability error) is rethrown, so it can't pass for "the link opened nothing".
    const left = await browser
      .waitUntil(async () => (await appState()) !== RUNNING_IN_FOREGROUND, {
        timeout: 10_000,
        timeoutMsg: STAYED_IN_FOREGROUND,
      })
      .then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && error.message === STAYED_IN_FOREGROUND)
            return false;
          throw error;
        },
      );
    await browser.activateApp(APP_PACKAGE);
    // On iOS, webview() only accepts a WKWebView showing capacitor://localhost, so a WebView
    // that navigated away fails here ("no WKWebView context loaded capacitor://localhost"),
    // not at the pathname check below: read that error as "the link stayed in the WebView".
    await webview();

    // The WebView is back on the room it showed before the tap.
    expect(await pathname()).toBe(roomPath);
    // And the link really went to the system browser (spec part D, decision 8).
    expect(left).toBe(true);
  });
});
