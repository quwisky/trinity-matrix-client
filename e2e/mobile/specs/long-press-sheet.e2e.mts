import { browser, expect } from '@wdio/globals';
import { login, sheetAtRest, tap, waitForRooms } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  sendMessage,
  uniqueId,
} from '../support/matrix.mts';
import { native, resetApp, webview } from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

const PRESSES = 5;
/** Past the 500 ms long press and WebKit's own text-selection hold, with the sheet already up. */
const HOLD_MS = 1_500;
/** Past the guard's 300 ms grace for the lift's click. */
const AFTER_LIFT_MS = 600;
/** For the guard to release after the lift; its own backstop is 10 s. */
const RELEASE_TIMEOUT_MS = 2_000;
/** The edit menu WebKit shows over a selection, and the callout of a held link or image. */
const CALLOUT = `-ios predicate string:(type == "XCUIElementTypeMenuItem" OR type == "XCUIElementTypeButton") AND label IN {"Copy", "Look Up", "Translate", "Select All", "Share…", "Open Link"}`;

const SHEET = '[role="dialog"][aria-label="Message actions"]';

/** What the held finger left behind in the WebView once it lifted. */
const afterLift = () =>
  browser.execute((sheetSelector: string) => {
    const selection = getSelection();
    const sheet = document.querySelector(sheetSelector);
    return {
      selected: selection?.toString() ?? '',
      sheetSelected:
        !!sheet &&
        !!selection &&
        !selection.isCollapsed &&
        selection.containsNode(sheet, true),
      sheetOpen: !!sheet,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      replying: !!document.querySelector('.composer__banner'),
    };
  }, SHEET);

// #1868: the finger that opens the sheet is still down when it appears under it. XCUITest's
// synthesized hold did not reproduce the selection on the iOS 27.2 Simulator even without the
// guard, so this pins the real-touch path rather than proving the device report.
describe('long press on a message', function () {
  this.timeout(300_000);
  before(onlyOn('ios', 'the held touch carrying into a selection is WebKit’s'));

  it('selects nothing, shows no menu and picks no row in the sheet it opens', async () => {
    await resetApp();
    const user = uniqueId('long-press');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    const token = await accessToken(user, pass);
    const roomName = `Long press ${user}`;
    const roomId = await createRoom(token, roomName);
    const body = `hold me ${user} with enough words to select`;
    await sendMessage(token, roomId, body);

    await login(user, pass);
    await waitForRooms();
    await tap(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    const text = $(
      `//*[contains(@class,"msg__text")][contains(.,"hold me ${user}")]`,
    );
    await expect(text).toBeDisplayed({ wait: 30_000 });

    for (let press = 1; press <= PRESSES; press += 1) {
      await browser
        .action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ origin: text })
        .down()
        .pause(HOLD_MS)
        .move({ origin: 'pointer', x: 3, y: 2, duration: 50 })
        .up()
        .perform();
      await browser.pause(AFTER_LIFT_MS);

      const left = await afterLift();
      await native();
      const menus = await $$(CALLOUT).length;
      await webview();
      // One object, so a failure names the press and everything it left behind.
      expect({ press, ...left, menus }).toEqual({
        press,
        selected: '',
        sheetSelected: false,
        sheetOpen: true,
        dialogs: 1,
        replying: false,
        menus: 0,
      });
      // The guard lets go 300 ms after the lift, and a slow runner can run that timer late. Well under
      // its 10 s backstop, so a guard that stays stuck still fails.
      await browser.waitUntil(
        () =>
          browser.execute(
            () => getComputedStyle(document.body).userSelect !== 'none',
          ),
        {
          timeout: RELEASE_TIMEOUT_MS,
          timeoutMsg: `press ${press}: the guard never released body selection`,
        },
      );

      await sheetAtRest();
      // The backdrop is the way out; a tap at its centre would land on the sheet.
      await browser.execute(() =>
        document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click(),
      );
      await browser.waitUntil(
        async () =>
          !(await browser.execute(
            (selector: string) => !!document.querySelector(selector),
            SHEET,
          )),
        {
          timeout: 5_000,
          timeoutMsg: `press ${press}: the sheet never closed`,
        },
      );
    }
  });
});
