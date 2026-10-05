import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { keyboardShown, goBack, resetApp } from '../support/session.mts';

/**
 * Press a control while the composer holds the soft keyboard. On iOS, Appium converts a
 * touch's web coordinates with the page's viewport, and the keyboard leaves WKWebView
 * zoomed and offset (run 37294494885: innerHeight 530, visual viewport scale 1.067, offset
 * 36): "Converted web coords {261,491} into real coords {357,1796}", off the screen, so the
 * Aa tap hit nothing. A WebDriver element click does not depend on that conversion.
 */
async function press(selector: string): Promise<void> {
  if (browser.isIOS) await $(selector).click();
  else await tap(selector);
}

describe('mobile composer formatting', () => {
  beforeEach(resetApp);

  it('formats a selected word through Aa, restores the keyboard, and dismisses on Back', async () => {
    const user = uniqueId('android-format');
    const pass = `${user}-pass`;
    const roomName = `Format ${user}`;
    await registerUser(user, pass);
    await createRoom(await accessToken(user, pass), roomName);
    await login(user, pass);
    await waitForRooms();
    await $('[data-testid="rail-rooms"]').click();
    // A `button`, not `*`: `*` matches the outer `.channel-row` first, whose centre XCUITest
    // atom clicks do not hit-test onto the button (#933 smoke).
    const room = $(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await room.click();
    const composer = $('[data-testid="composer-input"]');
    await expect(composer).toBeDisplayed({ wait: 20_000 });

    await tap('[data-testid="composer-input"]');
    if (browser.isIOS) {
      // WebDriverAgent's native typing can't reach a script-focused WKWebView textarea (#933 smoke).
      await $('[data-testid="composer-input"]').addValue('say hello');
    } else {
      await browser.keys('say hello');
    }
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="composer-input"]',
      )!;
      input.focus();
      input.setSelectionRange(4, 9);
    });
    await press('[data-testid="composer-format"]');
    const menu = $('[data-testid="action-sheet-surface"]');
    await expect(menu).toBeDisplayed();
    const fit = await browser.execute(() => {
      const box = document
        .querySelector('[data-testid="action-sheet-surface"]')
        ?.getBoundingClientRect();
      return box
        ? {
            x: box.x,
            y: box.y,
            right: box.x + box.width,
            bottom: box.y + box.height,
            width: innerWidth,
            height: innerHeight,
          }
        : null;
    });
    expect(fit).not.toBeNull();
    expect(fit!.x).toBeGreaterThanOrEqual(0);
    expect(fit!.y).toBeGreaterThanOrEqual(0);
    // WebView rounds its CSS viewport through native device-pixel ratios.
    expect(fit!.right).toBeLessThanOrEqual(fit!.width + 0.5);
    expect(fit!.bottom).toBeLessThanOrEqual(fit!.height + 0.5);
    await press(
      '[data-testid="action-sheet-surface"] [data-testid="format-italic"]',
    );
    await expect(composer).toHaveValue('say *hello*');
    await expect(menu).not.toBeDisplayed();
    await expect(composer).toBeFocused();
    expect(
      await browser.execute(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="composer-input"]',
        )!;
        return [input.selectionStart, input.selectionEnd];
      }),
    ).toEqual([5, 10]);
    await browser.waitUntil(keyboardShown, {
      timeout: 10_000,
      timeoutMsg: 'soft keyboard never restored',
    });

    await press('[data-testid="composer-format"]');
    await expect($('[data-testid="format-cancel"]')).toBeDisplayed();
    const unchanged = await browser.execute(
      () =>
        document.querySelector<HTMLTextAreaElement>(
          '[data-testid="composer-input"]',
        )!.value,
    );
    if (browser.isIOS) {
      // No system Back on iOS, and the edge swipe is off while the sheet is open.
      await press('[data-testid="format-cancel"]');
    } else {
      await goBack();
    }
    await expect($('[data-testid="format-cancel"]')).not.toExist();
    await expect(composer).toHaveValue(unchanged);
  });
});
