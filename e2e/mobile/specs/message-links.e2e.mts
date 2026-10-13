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
    const left = await browser
      .waitUntil(async () => (await appState()) !== RUNNING_IN_FOREGROUND, {
        timeout: 10_000,
      })
      .then(
        () => true,
        () => false,
      );
    await browser.activateApp(APP_PACKAGE);
    await webview();

    // The WebView itself never navigated: Trinity's room is still its document.
    expect(await pathname()).toBe(roomPath);
    // And the link really went to the system browser (spec part D, decision 8).
    expect(left).toBe(true);
  });
});
