import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { keyboardShown, goBack, resetApp } from '../support/session.mts';

describe('Android composer formatting', () => {
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
    const room = $(
      `//*[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await room.click();
    const composer = $('[data-testid="composer-input"]');
    await expect(composer).toBeDisplayed({ wait: 20_000 });

    await tap('[data-testid="composer-input"]');
    await browser.keys('say hello');
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="composer-input"]',
      )!;
      input.focus();
      input.setSelectionRange(4, 9);
    });
    await tap('[data-testid="composer-format"]');
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
    await tap(
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

    await tap('[data-testid="composer-format"]');
    await expect($('[data-testid="format-cancel"]')).toBeDisplayed();
    const unchanged = await browser.execute(
      () =>
        document.querySelector<HTMLTextAreaElement>(
          '[data-testid="composer-input"]',
        )!.value,
    );
    await goBack();
    await expect($('[data-testid="format-cancel"]')).not.toExist();
    await expect(composer).toHaveValue(unchanged);
  });
});
