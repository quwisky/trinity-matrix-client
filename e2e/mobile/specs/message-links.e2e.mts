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

/** How long the OS gets to bring the system browser, already started, to the front. */
const LEAVE_TIMEOUT_MS = 30_000;

const SAFARI = 'com.apple.mobilesafari';

/** This test's budget; see the breakdown in the test. The suite default is 180 s. */
const TEST_TIMEOUT_MS = 300_000;

/**
 * The OS's first Safari launch on a CI Simulator took 17 s in one run and 54 s in another.
 * Pay it once, in a hook with its own budget, so the tap is measured against a Safari that
 * has already started: the claim is that Trinity hands the link to the system browser, not
 * how fast Safari boots. A link that opens nothing still leaves Trinity in the foreground.
 */
async function startSafari(): Promise<void> {
  await native();
  await browser.execute('mobile: launchApp', { bundleId: SAFARI });
  await browser.waitUntil(
    async () =>
      (await browser.execute('mobile: queryAppState', {
        bundleId: SAFARI,
      })) === RUNNING_IN_FOREGROUND,
    { timeout: 150_000, interval: 1_000, timeoutMsg: 'Safari never started' },
  );
}

const pathname = async (): Promise<string> =>
  new URL(await browser.getUrl()).pathname;

/** The app's state as the OS reports it; read from the native context. */
const appState = async (): Promise<number> =>
  (await browser.execute(
    'mobile: queryAppState',
    browser.isIOS ? { bundleId: APP_PACKAGE } : { appId: APP_PACKAGE },
  )) as number;

/**
 * Whether the app left the foreground within `timeout`. Every reading runs to completion,
 * and the deadline is checked only between readings: WebDriverAgent can hold a query for
 * as long as the OS takes to switch apps (38 s on a CI runner), and a wall-clock wait that
 * gives up on that pending query would report "stayed in the foreground" when its answer
 * is "left". A failing query (a driver or capability error) rejects instead, so it can't
 * pass for "the link opened nothing".
 */
async function leftForeground(timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if ((await appState()) !== RUNNING_IN_FOREGROUND) return true;
    if (Date.now() >= deadline) return false;
    await browser.pause(250);
  }
}

/** Longer than the 150 ms a backfill runs before "Loading older messages…" shows. */
const SETTLE_WINDOW_MS = 750;

/**
 * Wait until the Room's timeline stops moving the element at `xpath`. Opening a Room
 * backfills its history, and a backfill slower than 150 ms shows the "Loading older
 * messages…" strip in flow above the rows. When the page lands, the strip goes and every row
 * moves up by its 36 px. On a CI Simulator that happened between tap()'s stability check and
 * the touch, which then hit the empty timeline under the link. So wait for no strip and the
 * same position across a window longer than the strip's show delay. The element is looked
 * up again each time, because a landing page can re-render its row.
 */
async function waitForSettledTimeline(xpath: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.executeAsync(
        (path: string, windowMs: number, done: (settled: boolean) => void) => {
          const find = (): Element | null =>
            document.evaluate(
              path,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            ).singleNodeValue as Element | null;
          const loading = (): boolean =>
            document.querySelector('.load-older') !== null;
          const before = find()?.getBoundingClientRect();
          const loadingBefore = loading();
          setTimeout(() => {
            const after = find()?.getBoundingClientRect();
            done(
              !!before &&
                !!after &&
                !loadingBefore &&
                !loading() &&
                before.x === after.x &&
                before.y === after.y,
            );
          }, windowMs);
        },
        xpath,
        SETTLE_WINDOW_MS,
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `the timeline kept moving ${xpath} (still loading older messages)`,
    },
  );
}

// Owner decision 8 (spec part D): a message link must leave the WebView. The page it
// opens must never replace Trinity inside the app's own WebView; where it would, the
// platform sends message links through ExternalBrowserService (the in-app browser sheet).
describe('message links on a phone', () => {
  before(async () => {
    if (browser.isIOS) await startSafari();
  });

  it('opens an external message link outside the app’s WebView', async function () {
    // Measured on a cold CI runner: 165 s of reinstall, launch retries and first sign-in
    // before the tap, up to 30 s for the timeline to settle, up to 70 s to see the app
    // leave (a 30 s window plus a 38 s query WebDriverAgent held) and 26 s to bring it back.
    this.timeout(TEST_TIMEOUT_MS);
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
    await waitForSettledTimeline(link);
    const roomPath = await pathname();

    await tap(link);
    await native();
    // Settle, and keep the result: a no-op window.open (or an Android launch with no browser
    // to handle it) leaves the app in the foreground, and must fail rather than pass as
    // "left the WebView".
    const left = await leftForeground(LEAVE_TIMEOUT_MS);
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
