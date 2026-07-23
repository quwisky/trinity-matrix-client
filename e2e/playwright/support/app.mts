import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { SESSION_FILE } from './global-setup.mts';

export interface SynapseSession {
  available: boolean;
  hs?: string;
  user?: string;
  pass?: string;
}

/** Read the homeserver session recorded by global-setup (available:false if Docker
 * wasn't there). Read at module load so `test.skip(...)` can gate suites. */
export function synapseSession(): SynapseSession {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SynapseSession;
  } catch {
    return { available: false };
  }
}

/**
 * Fill a native `<input hlmInput>` by its associated `<label hlmLabel for="…">`
 * (post-Ionic replacement for the old `<ion-input label="…">` targeting — every
 * current call site (login's Homeserver/Username/Password, settings' Display
 * name) has a real `<label for>` pointing at the input).
 */
export async function fillLabeledInput(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  // Exact match: the password field's "Show password" reveal button (aria-label)
  // otherwise also matches a substring `getByLabel('Password')`, tripping strict mode.
  const input = page.getByLabel(label, { exact: true });
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await input.fill(value);
}

/**
 * Wait until a just-sent message row carries the homeserver's own event id.
 *
 * A local echo renders immediately with matrix-js-sdk's `~roomId:txnId` placeholder as
 * its `data-mid`; the remote echo replaces that with the real `$…` id, which re-creates
 * the row (the timeline tracks rows by id). Acting on the row before then either races
 * that swap — a click landing mid-rerender is simply lost — or targets an id the server
 * has never seen: threading off it, pinning it or voting in its poll all break.
 */
export async function waitForSent(row: Locator): Promise<void> {
  await expect(row).toHaveAttribute('data-mid', /^\$/, { timeout: 20_000 });
}

/**
 * Hover a message row and click one of its hover-toolbar buttons.
 *
 * The toolbar is `opacity: 0; pointer-events: none` until the row is hovered (see
 * message-row.component.scss), so anything that moves the row between the hover and the
 * click — an arriving message, a read receipt, the timeline settling after a room switch
 * — leaves it inert under a cursor that is now over a *different* row. Playwright then
 * retries the click against the message body underneath until the test times out, since
 * its retries never re-hover. Re-hovering per attempt makes a re-render cost one attempt.
 */
export async function clickRowToolbar(
  row: Locator,
  button: Locator,
): Promise<void> {
  await expect(async () => {
    await row.hover();
    await button.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Log in through the UI (homeserver → Continue → credentials → Sign in) → /rooms. */
export async function login(page: Page, s: SynapseSession): Promise<void> {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await fillLabeledInput(page, 'Homeserver', s.hs as string);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', s.user as string);
  await fillLabeledInput(page, 'Password', s.pass as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
}
