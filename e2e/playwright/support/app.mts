import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
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
