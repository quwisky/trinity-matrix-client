import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  sendMessage,
  uniqueId,
} from '../support/matrix.mts';
import { native, resetApp, webview } from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

/** The pane under test, and the lowest `scrollTop` it has reported since the tap. */
type TapProbe = Window & { tapPane?: Element; tapLowest?: number };

/** The scrollable pane at the centre of the screen: what a status bar tap should scroll. */
const frontPane = (): Promise<{ name: string; top: number } | null> =>
  browser.execute(() => {
    let el = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    while (el) {
      const { overflowY } = getComputedStyle(el);
      if (
        el.scrollHeight > el.clientHeight &&
        (overflowY === 'auto' || overflowY === 'scroll')
      ) {
        return { name: `${el.tagName}.${el.className}`, top: el.scrollTop };
      }
      el = el.parentElement;
    }
    return null;
  });

/** Scroll the pane down, tap the status bar the way a finger does, and wait for the top. */
async function expectStatusTapScrollsToTop(): Promise<void> {
  await browser.execute(() => {
    let el = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    while (el) {
      const { overflowY } = getComputedStyle(el);
      if (
        el.scrollHeight > el.clientHeight &&
        (overflowY === 'auto' || overflowY === 'scroll')
      ) {
        el.scrollTop = el.scrollHeight;
        (window as TapProbe).tapPane = el;
        return;
      }
      el = el.parentElement;
    }
  });
  await browser.waitUntil(async () => ((await frontPane())?.top ?? 0) > 200, {
    timeoutMsg: 'the pane never scrolled down',
  });

  // A timeline that reaches its top loads older history and keeps the reader's row, so its
  // scrollTop leaves 0 again within a few frames: watch for the top being reached, not kept.
  await browser.execute(() => {
    const probe = window as TapProbe;
    const pane = probe.tapPane;
    if (!pane) return;
    probe.tapLowest = pane.scrollTop;
    pane.addEventListener(
      'scroll',
      () => {
        if (probe.tapPane === pane) {
          probe.tapLowest = Math.min(probe.tapLowest ?? 0, pane.scrollTop);
        }
      },
      { passive: true },
    );
  });

  await native();
  // The status bar is not in the XCUITest hierarchy; a touch in its strip is what a finger does.
  await browser.execute('mobile: tap', { x: 200, y: 10 });
  await webview();

  const lowest = (): Promise<number | undefined> =>
    browser.execute(() => (window as TapProbe).tapLowest);
  await browser.waitUntil(async () => ((await lowest()) ?? 1) <= 0, {
    timeout: 10_000,
    timeoutMsg: 'a status bar tap did not scroll the front pane to its top',
  });
}

describe('status bar tap', function () {
  this.timeout(300_000);
  before(onlyOn('ios', 'Android has no status bar tap'));

  it('scrolls the timeline, the room list and Settings to the top', async () => {
    await resetApp();
    const user = uniqueId('status-tap');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    const token = await accessToken(user, pass);
    const roomName = `Status tap ${user}`;
    const roomId = await createRoom(token, roomName);
    for (let i = 0; i < 40; i += 1) {
      await sendMessage(token, roomId, `message ${i} ${'x'.repeat(40)}`);
    }
    for (let i = 0; i < 20; i += 1) {
      await createRoom(token, `Filler ${i} ${user}`);
    }

    await login(user, pass);
    await waitForRooms();
    await tap('[data-testid="rail-rooms"]');
    await expectStatusTapScrollsToTop();

    await tap('[data-testid="open-settings"]');
    await expect($('[role="dialog"][aria-label="Settings"]')).toBeDisplayed({
      wait: 20_000,
    });
    await expectStatusTapScrollsToTop();
    await tap('[data-testid="close-settings"]');

    const roomButton = `//button[contains(@class,"channel")][contains(.,"${roomName}")]`;
    await tap(roomButton);
    await expect($('[data-message-scroller]')).toBeDisplayed({ wait: 30_000 });
    await expectStatusTapScrollsToTop();
  });
});
