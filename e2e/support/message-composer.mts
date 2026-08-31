import { expect, type Page } from '@playwright/test';

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

/** Type a message with real newlines: Shift+Enter inserts one, Enter sends. */
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
  // wait for the actual single-flight control before Enter so the next send cannot be
  // discarded. An empty composer intentionally keeps this control disabled.
  await expect(page.getByTestId('composer-send')).toBeEnabled({
    timeout: 20_000,
  });
  await composer.press('Enter');
}
