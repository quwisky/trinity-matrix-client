import { expect, type Locator, type Page } from '@playwright/test';
import { readSession } from './session.mts';
import type { HomeserverKind, HomeserverRuntime } from './homeserver/kind.mts';
import type { Navigate } from './platform-contracts.mts';
export const webNavigate: Navigate = async (page, path) => {
  await page.goto(path, { waitUntil: 'networkidle' });
};
export type { Navigate };
const capacitorStoragePrefix = 'CapacitorStorage.';

function preferenceKey(key: string): string {
  return key.startsWith(capacitorStoragePrefix)
    ? key.slice(capacitorStoragePrefix.length)
    : key;
}

/** Read a Capacitor Preferences value without depending on its platform backend. */
export async function readPreference(
  page: Page,
  key: string,
): Promise<string | null> {
  const logicalKey = preferenceKey(key);
  return page.evaluate(
    (value) => localStorage.getItem(`CapacitorStorage.${value}`),
    logicalKey,
  );
}

/** Enumerate Capacitor Preferences keys through the backend active on this platform. */
export async function preferenceKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('CapacitorStorage.'))
      .map((key) => key.slice('CapacitorStorage.'.length)),
  );
}

/** Every IndexedDB database name, or [] where the browser cannot enumerate. */
export function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    if (typeof indexedDB.databases !== 'function') {
      return [];
    }
    const dbs = await indexedDB.databases();
    return dbs.map((d) => d.name).filter((n): n is string => !!n);
  });
}

/** Seed a preference before a journey reads it during application startup. */
export async function seedPreference(
  page: Page,
  key: string,
  value: string,
): Promise<void> {
  const logicalKey = preferenceKey(key);
  const seed = ([storageKey, storageValue]: readonly [string, string]) =>
    localStorage.setItem(`CapacitorStorage.${storageKey}`, storageValue);
  const preference = [logicalKey, value] as const;
  // A brand-new Playwright page is still at about:blank and needs an init script
  // for the first application boot. Once the app origin is loaded, write only the
  // live document: keeping an init script there would resurrect a preference after
  // the clear-data journey removes storage and reloads the application.
  if (page.url() === 'about:blank') {
    await page.addInitScript(seed, preference);
  } else {
    await page.evaluate(seed, preference);
  }
}

/** The Dex-backed account Synapse created via SSO, so it has no Matrix password. */
export interface SsoAccount {
  user: string;
  email: string;
  pass: string;
  /** Dex's form-free mock identity (TRINITY_E2E_SSO_PROVIDER=mock); `pass` is then empty. */
  mock?: boolean;
}

export interface HomeserverSession {
  available: boolean;
  hs?: string;
  user?: string;
  pass?: string;
  /**
   * The running server (`TRINITY_E2E_HOMESERVER`). Branch on it only where Matrix servers
   * legitimately differ, and keep both expectations.
   */
  kind?: HomeserverKind;
  version?: string;
  /** Docker Compose, or host processes (`native`), where harness-served pages live on loopback. */
  runtime?: HomeserverRuntime;
  secondary?: {
    hs: string;
    serverName: string;
    registrationSecret: string;
  };
  /** Absent when the harness predates the Dex provider, so specs can gate on it. */
  sso?: SsoAccount;
  /**
   * A second Dex identity, for the one spec that leaves permanent state on the account
   * it uses and asserts that nothing else moved. Kept apart from `sso` because
   * `fullyParallel` runs the two SSO specs in different workers — see e2e/support/homeserver/dex.yaml.
   */
  ssoReset?: SsoAccount;
  /** A third Dex identity, which the account-deletion journey deletes for good. */
  ssoDelete?: SsoAccount;
  /** The opt-in MAS stack's account (TRINITY_E2E_MAS=1); absent when it is not running. */
  mas?: {
    hs: string;
    serverName: string;
    issuer: string;
    user: string;
    pass: string;
  };
}

/** Read the homeserver session published by the invocation owner. */
export function homeserverSession(): HomeserverSession {
  return readSession().homeserver ?? { available: false };
}

/**
 * Fill a native `<input>` by its associated `<label hlmLabel for="…">`
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
  await input.waitFor({ state: 'visible', timeout: 30_000 });
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

/** Open a message row's overflow menu and choose an item as one replace-safe action. */
export async function clickRowMenuItem(
  row: Locator,
  menuItem: Locator,
): Promise<void> {
  await expect(async () => {
    await row.hover();
    await row.getByTestId('msg-more').click({ timeout: 2_000 });
    await menuItem.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Switch a settings surface to one section and wait for its visible panel. Responsive settings
 * hubs reveal their directory before choosing another section on mobile.
 */
export async function openSettingsTab(
  page: Page,
  prefix: 'room-settings' | 'space-settings',
  tab:
    | 'general'
    | 'for-you'
    | 'access'
    | 'contents'
    | 'members'
    | 'addresses'
    | 'widgets',
): Promise<void> {
  const tabButton = page.getByTestId(`${prefix}-tab-${tab}`);
  const backButton = page.getByTestId(`${prefix}-mobile-back`);
  // Wait for the dialog to settle before choosing a layout: a one-shot
  // visibility check races the first render and would click a back button
  // that desktop never has.
  await expect(tabButton.or(backButton).first()).toBeVisible({
    timeout: 10_000,
  });
  if (!(await tabButton.isVisible())) {
    await backButton.click();
  }
  await tabButton.click();
  await expect(page.getByTestId(`${prefix}-panel-${tab}`)).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * What a sign-in helper does when a new device of an account with an encryption identity
 * opens on the new-device check (`/encryption/confirm`). Browser and protocol journeys run
 * the development build, whose check offers "Skip for now (debug build)".
 * - `skip-if-shown` (default): take the skip when the check appears.
 * - `expect`: stop on the check; fail if Rooms opens instead.
 * - `forbid`: fail if the check appears.
 */
export type DeviceCheckHandling = 'skip-if-shown' | 'expect' | 'forbid';

/** Whether `url` is the new-device check. */
export const onDeviceCheck = (url: URL): boolean =>
  url.pathname === '/encryption/confirm';

const onRooms = (url: URL): boolean =>
  url.pathname === '/rooms' &&
  (url.searchParams.get('account')?.length ?? 0) > 0;

/**
 * Wait until a sign-in lands on Rooms or on the new-device check, then handle the check.
 * The route guard holds navigation for up to ten seconds while the device's status
 * loads, so the landing waits on the URL, never on a fixed delay. A desktop without a usable
 * keyring (headless Linux CI) first asks to store the account unprotected; the helper agrees.
 */
export async function settleSignIn(
  page: Page,
  handling: DeviceCheckHandling = 'skip-if-shown',
  timeout = 30_000,
): Promise<'rooms' | 'check'> {
  const keyringConsent = page.locator('trn-alert-dialog', {
    hasText: 'Store this account without a keyring?',
  });
  await expect(async () => {
    if (await keyringConsent.isVisible()) {
      await keyringConsent.getByTestId('alert-confirm').click();
    }
    const url = new URL(page.url());
    expect(onRooms(url) || onDeviceCheck(url)).toBe(true);
  }).toPass({ timeout });
  await page.waitForURL((url) => onRooms(url) || onDeviceCheck(url), {
    timeout,
  });
  const landed = onDeviceCheck(new URL(page.url())) ? 'check' : 'rooms';
  if (landed === 'rooms') {
    if (handling === 'expect') {
      throw new Error(
        'Expected the new-device check, but the sign-in opened Rooms.',
      );
    }
    return landed;
  }
  if (handling === 'forbid') {
    throw new Error('The sign-in opened the new-device check.');
  }
  if (handling === 'expect') return landed;
  await page.getByTestId('device-confirmation-skip').click({ timeout });
  await waitForRooms(page, timeout);
  return landed;
}

/** Log in through the UI (homeserver → Continue → credentials → Sign in), then settle. */
export async function login(
  page: Page,
  s: HomeserverSession,
  navigate: Navigate = webNavigate,
  deviceCheck: DeviceCheckHandling = 'skip-if-shown',
): Promise<void> {
  await navigate(page, '/login');
  await fillLabeledInput(page, 'Homeserver', s.hs as string);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', s.user as string);
  await fillLabeledInput(page, 'Password', s.pass as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await settleSignIn(page, deviceCheck);
}

/** Wait for Application Runtime's stable, Account-qualified Rooms destination. */
export async function waitForRooms(
  page: Page,
  timeout = 30_000,
): Promise<void> {
  await page.waitForURL(
    (url) =>
      url.pathname === '/rooms' &&
      (url.searchParams.get('account')?.length ?? 0) > 0,
    { timeout },
  );
}

/** Type a word into the "Erase all Trinity data" confirmation and press its confirm button. */
export async function confirmErase(page: Page, word: string): Promise<void> {
  const dialog = page.locator('trn-alert-dialog', {
    hasText: 'Erase all Trinity data',
  });
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.locator('input').fill(word);
  await dialog.getByTestId('alert-confirm').click();
}
