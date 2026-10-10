import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { native, resetApp, webview } from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

const SHEET = '[data-testid="action-sheet-surface"]';

/** iOS needs a WebDriver click (Appium's coordinate conversion misses under XCUITest). */
async function press(selector: string): Promise<void> {
  if (browser.isIOS) await $(selector).click();
  else await tap(selector);
}

async function openFreshRoom(prefix: string): Promise<void> {
  const user = uniqueId(prefix);
  const pass = `${user}-pass`;
  const roomName = `Capture ${user}`;
  await registerUser(user, pass);
  await createRoom(await accessToken(user, pass), roomName);
  await login(user, pass);
  await waitForRooms();
  await $('[data-testid="rail-rooms"]').click();
  // A `button`, not `*`: `*` matches the outer `.channel-row` first, whose centre XCUITest
  // atom clicks do not hit-test onto the button.
  const room = $(
    `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
  );
  await expect(room).toBeDisplayed({ wait: 30_000 });
  await room.click();
  await expect($('[data-testid="composer-input"]')).toBeDisplayed({
    wait: 20_000,
  });
}

async function openInsertSheet(): Promise<void> {
  await press('[data-testid="composer-insert"]');
  await expect($(SHEET)).toBeDisplayed({ wait: 10_000 });
}

type CaptureOutcome = 'photo' | 'no-camera' | 'none';

/**
 * Poll the WebView for what a capture left behind: a staged photo, or the "no camera" toast
 * (a sonner `[data-sonner-toast]` whose text sits in nested spans). 'none' when neither
 * shows within `timeout`.
 */
async function captureOutcome(timeout: number): Promise<CaptureOutcome> {
  const read = (): Promise<CaptureOutcome> =>
    browser.execute((): CaptureOutcome => {
      if (document.querySelector('[data-testid="composer-pending"] img')) {
        return 'photo';
      }
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')];
      return toasts.some((toast) =>
        toast.textContent?.includes('This device has no camera'),
      )
        ? 'no-camera'
        : 'none';
    });
  let outcome: CaptureOutcome = 'none';
  await browser
    .waitUntil(async () => (outcome = await read()) !== 'none', {
      timeout,
      interval: 200,
    })
    .catch(() => undefined);
  return outcome;
}

describe('mobile camera capture', () => {
  beforeEach(resetApp);

  it('offers Take photo and Record video right after Attach', async () => {
    await openFreshRoom('capture-menu');
    await openInsertSheet();

    const order = await browser.execute(
      (sheet: string) =>
        [...document.querySelectorAll(`${sheet} [data-testid^="insert-"]`)].map(
          (row) => row.getAttribute('data-testid'),
        ),
      SHEET,
    );
    expect(order.slice(0, 3)).toEqual([
      'insert-attach',
      'insert-take-photo',
      'insert-record-video',
    ]);
  });

  it('takes a photo through the Simulator camera and stages it', async function () {
    onlyOn(
      'ios',
      'drives the iOS camera UI through XCUITest; the Android emulator camera app is not adapted yet',
    ).call(this);
    await openFreshRoom('capture-photo');
    await openInsertSheet();
    await press(`${SHEET} [data-testid="insert-take-photo"]`);

    // The Simulator has no camera, so the composer answers within a moment with a toast that
    // lives only 4 s: look for the fast outcomes before leaving the WebView for the camera UI.
    let outcome = await captureOutcome(8_000);
    if (outcome === 'none') {
      // Where the Simulator offers a camera, press its shutter and accept the shot.
      await native();
      const shutter = $('~PhotoCapture');
      const hasCamera = await shutter
        .waitForDisplayed({ timeout: 15_000 })
        .then(
          () => true,
          () => false,
        );
      if (hasCamera) {
        await shutter.click();
        const usePhoto = $('~Use Photo');
        await usePhoto.waitForDisplayed({ timeout: 15_000 });
        await usePhoto.click();
      }
      await webview();
      outcome = await captureOutcome(30_000);
    }
    if (outcome === 'none') {
      throw new Error(
        'Take photo neither staged a photo nor reported a missing camera',
      );
    }
    if (outcome === 'no-camera') {
      console.log('[mobile] skipped: this Simulator reports no camera');
      this.skip();
    }
    await expect($('[data-testid="composer-pending"] img')).toBeDisplayed();
    expect(await $('.composer__pending-name').getText()).toMatch(
      /^photo\.(jpeg|png|heic)$/,
    );
  });
});
