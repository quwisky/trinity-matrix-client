import { expect, type Locator } from '@playwright/test';

/**
 * Focus an element the way a keyboard user arrives: through Tab, so the browser records
 * keyboard modality and the element matches `:focus-visible`.
 *
 * `locator.focus()` is programmatic focus. After any earlier mouse click Chromium does not
 * treat it as `:focus-visible`, and `trnTooltip` deliberately stays closed for that. Tab off
 * the element and back on rather than pressing a page-level key such as Escape, which would
 * close an open dialog.
 */
export async function focusWithKeyboard(target: Locator): Promise<void> {
  const keyboard = target.page().keyboard;
  await target.focus();
  await keyboard.press('Shift+Tab');
  await keyboard.press('Tab');
  await expect(target).toBeFocused();
}
