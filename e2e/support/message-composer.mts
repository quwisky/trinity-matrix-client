import { expect, type Locator, type Page } from '@playwright/test';
import { isAndroidE2E } from './navigation.mts';

/** Open one named room through the real room rail and wait for its composer. */
export async function openNamedRoom(
  page: Page,
  roomName: string,
): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Whether the app treats this page as a phone or tablet, mirroring the web tier of
 * `isMobileOs()`: the installed Android WebView always is, a browser page is when its
 * (emulated) user agent names Android/iPhone/iPod, an iPadOS desktop disguise, or
 * UA-CH reports mobile.
 */
async function isMobileComposerPage(page: Page): Promise<boolean> {
  if (isAndroidE2E) {
    return true;
  }
  return page.evaluate(() => {
    const ua = navigator.userAgent;
    const hints = (navigator as { userAgentData?: { mobile?: boolean } })
      .userAgentData;
    return (
      /Android|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ||
      hints?.mobile === true
    );
  });
}

/**
 * Send the draft in one composer instance. Desktop sends on Enter; on a mobile device
 * Enter inserts a new line (d3b27323), so there the Send button of that same composer
 * (room or thread) sends.
 */
export async function sendComposerDraft(composer: Locator): Promise<void> {
  if (!(await isMobileComposerPage(composer.page()))) {
    await composer.press('Enter');
    return;
  }
  const send = composer
    .locator('xpath=ancestor::trn-message-composer[1]')
    .getByTestId('composer-send');
  await expect(send).toBeEnabled({ timeout: 20_000 });
  await send.click();
}

/** Type a message with real newlines: Shift+Enter inserts one, then the draft is sent. */
export async function sendComposerLines(
  page: Page,
  lines: readonly string[],
): Promise<void> {
  const composer = page.getByTestId('composer-input');
  await composer.click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      await composer.press('Shift+Enter');
    }
    // pressSequentially, not fill: the composer's mention/emoji autocomplete and draft
    // persistence all hang off per-key input events. (Locator.type is deprecated.)
    await composer.pressSequentially(line);
  }
  // A local echo can render before the authoritative send settles. Once this draft exists,
  // wait for the actual single-flight control before sending so the next send cannot be
  // discarded. An empty composer intentionally keeps this control disabled.
  await expect(page.getByTestId('composer-send')).toBeEnabled({
    timeout: 20_000,
  });
  await sendComposerDraft(composer);
}
