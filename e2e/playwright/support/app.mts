import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { SESSION_FILE } from './synapse-session.mts';
import { touchLongPress } from './touch-platform.mts';

export type Navigate = (page: Page, path: string) => Promise<void>;

export const webNavigate: Navigate = async (page, path) => {
  if (isAndroidE2E) {
    const target = new URL(path, page.url()).href;
    if (target === page.url()) return;
    await page.evaluate((url) => {
      const state = {
        ...window.history.state,
        navigationId:
          typeof window.history.state?.navigationId === 'number'
            ? window.history.state.navigationId + 1
            : 1,
      };
      window.history.pushState(state, '', url);
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
    }, target);
    return;
  }
  await page.goto(path, { waitUntil: 'networkidle' });
};

export const isAndroidE2E = process.env['TRINITY_E2E_PLATFORM'] === 'android';
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
  if (!isAndroidE2E) {
    return page.evaluate(
      (value) => localStorage.getItem(`CapacitorStorage.${value}`),
      logicalKey,
    );
  }
  return page.evaluate(async (value) => {
    const capacitor = (
      window as typeof window & {
        Capacitor?: {
          Plugins?: {
            Preferences?: {
              get(options: { key: string }): Promise<{ value: string | null }>;
            };
          };
        };
      }
    ).Capacitor;
    const preferences = capacitor?.Plugins?.Preferences;
    if (!preferences)
      throw new Error('Capacitor Preferences plugin is unavailable');
    return (await preferences.get({ key: value })).value;
  }, logicalKey);
}

/** Enumerate Capacitor Preferences keys through the backend active on this platform. */
export async function preferenceKeys(page: Page): Promise<string[]> {
  if (!isAndroidE2E) {
    return page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith('CapacitorStorage.'))
        .map((key) => key.slice('CapacitorStorage.'.length)),
    );
  }
  return page.evaluate(async () => {
    const capacitor = (
      window as typeof window & {
        Capacitor?: {
          Plugins?: { Preferences?: { keys(): Promise<{ keys: string[] }> } };
        };
      }
    ).Capacitor;
    const preferences = capacitor?.Plugins?.Preferences;
    if (!preferences)
      throw new Error('Capacitor Preferences plugin is unavailable');
    return (await preferences.keys()).keys;
  });
}

/** Seed a preference before a journey reads it during application startup. */
export async function seedPreference(
  page: Page,
  key: string,
  value: string,
): Promise<void> {
  const logicalKey = preferenceKey(key);
  if (!isAndroidE2E) {
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
    return;
  }
  await page.evaluate(
    async ([storageKey, storageValue]) => {
      const capacitor = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: {
              Preferences?: {
                set(options: { key: string; value: string }): Promise<void>;
              };
            };
          };
        }
      ).Capacitor;
      const preferences = capacitor?.Plugins?.Preferences;
      if (!preferences)
        throw new Error('Capacitor Preferences plugin is unavailable');
      await preferences.set({ key: storageKey, value: storageValue });
    },
    [logicalKey, value],
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** The Dex-backed account Synapse created via SSO, so it has no Matrix password. */
export interface SsoAccount {
  user: string;
  email: string;
  pass: string;
}

export interface SynapseSession {
  available: boolean;
  hs?: string;
  user?: string;
  pass?: string;
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
   * `fullyParallel` runs the two SSO specs in different workers — see e2e/synapse/dex.yaml.
   */
  ssoReset?: SsoAccount;
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

/** Open the message actions surface used by the iOS/Android interaction model. */
export async function openMessageActionSheet(
  page: Page,
  row: Locator,
): Promise<Locator> {
  await touchLongPress(page, row);
  const sheet = page.getByRole('dialog', { name: 'Message actions' });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  return sheet;
}

/**
 * Switch a settings dialog to one of its tabs, and wait until that panel is the visible one.
 *
 * `prefix` is `room-settings` or `space-settings`. Both dialogs render every panel eagerly —
 * one `<form>` spans all of them — so an inactive panel is in the DOM and merely `hidden`.
 * That is exactly why this waits on VISIBILITY rather than on the element existing: a locator
 * that only asserts presence would pass before the tab was ever pressed.
 */
export async function openSettingsTab(
  page: Page,
  prefix: 'room-settings' | 'space-settings',
  tab: 'general' | 'access' | 'widgets' | 'bans',
): Promise<void> {
  await page.getByTestId(`${prefix}-tab-${tab}`).click();
  await expect(page.getByTestId(`${prefix}-panel-${tab}`)).toBeVisible({
    timeout: 10_000,
  });
}

/** Log in through the UI (homeserver → Continue → credentials → Sign in) → /rooms. */
export async function login(
  page: Page,
  s: SynapseSession,
  navigate: Navigate = webNavigate,
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
  await waitForRooms(page);
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
