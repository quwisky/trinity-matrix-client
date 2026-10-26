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

/**
 * XCUITest and UiAutomator2 share these `queryAppState` values: 1 not running, 2 suspended
 * or running in the background, 3 running in the background, 4 in the foreground.
 */
const RUNNING_IN_FOREGROUND = 4;
const RUNNING_BEHIND = [2, 3];

/** How long the OS gets to bring the system browser, already started, to the front. */
const LEAVE_TIMEOUT_MS = 30_000;

const SAFARI = 'com.apple.mobilesafari';

/** Safari's launch plus its wait for the foreground; a held query can add up to 38 s. */
const SAFARI_START_MS = 120_000;

/**
 * The default test budget is 180 s (300 s on iOS). Measured on cold CI runners: 165 s of reinstall, launch retries
 * and first sign-in before the tap (one tap alone was held for 69 s), and 26 s to bring the
 * app back; plus the waits' limits: 30 s for the timeline to settle, and 30 s to see the app
 * leave, which a held query (38 s seen) can overrun.
 */
const TEST_TIMEOUT_MS = 300_000;

/**
 * The OS's first Safari launch on a CI Simulator took 17 s in one run and 54 s in another.
 * Pay it once, in a hook with its own budget, so the tap is measured against a Safari that
 * has already started: the claim is that Trinity hands the link to the system browser, not
 * how fast Safari boots. A link that opens nothing still leaves Trinity in the foreground.
 */
async function startSafari(): Promise<void> {
  const deadline = Date.now() + SAFARI_START_MS;
  await native();
  await browser.execute('mobile: launchApp', { bundleId: SAFARI });
  const state = await appStateWithin(
    SAFARI,
    (reading) => reading === RUNNING_IN_FOREGROUND,
    Math.max(0, deadline - Date.now()),
  );
  if (state !== RUNNING_IN_FOREGROUND)
    throw new Error(`Safari never reached the foreground (state ${state})`);
}

const pathname = async (): Promise<string> =>
  new URL(await browser.getUrl()).pathname;

/** An app's state as the OS reports it; read from the native context. */
const appState = async (id: string): Promise<number> =>
  (await browser.execute(
    'mobile: queryAppState',
    browser.isIOS ? { bundleId: id } : { appId: id },
  )) as number;

/**
 * Read `id`'s state until `accept` takes it or `timeout` passes; return the last reading.
 * Every reading runs to completion, and the deadline is checked only between readings:
 * WebDriverAgent can hold a query for as long as the OS takes to switch apps (38 s on a CI
 * runner), and a wall-clock wait that gave up on that pending query reported "stayed in the
 * foreground" when its answer was "left". A failing query (a driver or capability error)
 * rejects instead, so it can't pass for "the link opened nothing".
 */
async function appStateWithin(
  id: string,
  accept: (state: number) => boolean,
  timeout: number,
): Promise<number> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await appState(id);
    if (accept(state) || Date.now() >= deadline) return state;
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
      browser.execute(
        async (path: string, windowMs: number): Promise<boolean> => {
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
          await new Promise((resolve) => setTimeout(resolve, windowMs));
          const after = find()?.getBoundingClientRect();
          return (
            !!before &&
            !!after &&
            !loadingBefore &&
            !loading() &&
            before.x === after.x &&
            before.y === after.y
          );
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
describe('message links on a phone', function () {
  // Set on the suite, not in the test: WebdriverIO arms its own timer from the test's
  // timeout before the body runs, so a this.timeout() inside the test is ignored.
  this.timeout(TEST_TIMEOUT_MS);

  before(async () => {
    if (browser.isIOS) await startSafari();
  });

  // Leave no Safari behind: its page is a WEBVIEW_ context too, and on a CI runner the next
  // spec's webview() hung for minutes switching into it.
  after(async () => {
    if (browser.isIOS) await browser.terminateApp(SAFARI);
  });

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
    await waitForSettledTimeline(link);
    const roomPath = await pathname();

    await tap(link);
    await native();
    // The link went to the system browser (spec part D, decision 8). A no-op window.open (or
    // an Android launch with no browser to handle it) leaves Trinity in the foreground; a
    // crash leaves it not running. Neither may pass as "left the WebView": Trinity must be
    // running behind another app, and on iOS that app is Safari.
    const left = await appStateWithin(
      APP_PACKAGE,
      (state) => state !== RUNNING_IN_FOREGROUND,
      LEAVE_TIMEOUT_MS,
    );
    expect(RUNNING_BEHIND).toContain(left);
    if (browser.isIOS) {
      const safari = await appStateWithin(
        SAFARI,
        (state) => state === RUNNING_IN_FOREGROUND,
        LEAVE_TIMEOUT_MS,
      );
      expect(safari).toBe(RUNNING_IN_FOREGROUND);
    }

    await browser.activateApp(APP_PACKAGE);
    // On iOS, webview() only accepts a WKWebView showing capacitor://localhost, so a WebView
    // that navigated away fails here ("no WKWebView context loaded capacitor://localhost"),
    // not at the pathname check below: read that error as "the link stayed in the WebView".
    await webview();

    // The WebView is back on the room it showed before the tap.
    expect(await pathname()).toBe(roomPath);
  });
});
