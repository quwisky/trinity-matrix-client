import { test, expect, type Page } from '@playwright/test';
import { login, fillLabeledInput, synapseSession } from './support/app.mts';

// Authenticated journeys through Settings — theme switching, profile editing,
// device management, and the responsive section submenu (two-pane on desktop,
// list → sub-page on mobile). They need a live homeserver, so the suite skips
// itself when the disposable Synapse wasn't available (no Docker).
const session = synapseSession();

const SECTIONS = [
  'profile',
  'presence',
  'appearance',
  'devices',
  'account',
  'security',
  'notifications',
  'server',
  'privacy',
  'gifs',
  'shortcuts',
  'experimental',
];

// A 1x1 transparent PNG — a valid image the homeserver accepts as an avatar.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const hasDarkPalette = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

/** The active colour palette, reflected as <html data-theme>; null for the default. */
const paletteAttr = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));

/** Open a settings section from the submenu and wait for its sub-page URL. */
async function openSection(page: Page, path: string): Promise<void> {
  await page.getByTestId(`settings-nav-${path}`).click();
  await page.waitForURL(new RegExp(`/settings/${path}$`), { timeout: 20_000 });
}

test.describe('Settings', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.beforeEach(async ({ page }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();
    // The settings shell (submenu) loads; on the desktop viewport it auto-lands
    // on the first section (Profile).
    await expect(page.getByTestId('settings-nav-profile')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('lists and navigates between sections from the submenu', async ({
    page,
  }) => {
    for (const path of SECTIONS) {
      await expect(page.getByTestId(`settings-nav-${path}`)).toBeVisible();
    }
    // Selecting a section routes to its sub-page and shows that section.
    await openSection(page, 'appearance');
    await expect(page.getByTestId('theme-dark')).toBeVisible();
    await openSection(page, 'experimental');
    await expect(page.getByTestId('flag-virtual-timeline')).toBeVisible();
  });

  test('desktop: auto-selects the first section and shows both panes', async ({
    page,
  }) => {
    // The default (wide) viewport auto-redirects the bare index into the first
    // section, and renders the submenu AND the section detail together (two-pane).
    await page.waitForURL(/\/settings\/profile$/, { timeout: 20_000 });
    await expect(page.getByTestId('settings-nav-profile')).toBeVisible();
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    // The active section link is marked current for assistive tech.
    await expect(page.getByTestId('settings-nav-profile')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('desktop: back leaves settings without retracing visited sections', async ({
    page,
  }) => {
    // Lateral section switches on the two-pane layout must not stack history.
    await openSection(page, 'appearance');
    await openSection(page, 'devices');
    await openSection(page, 'gifs');

    // A single back exits settings entirely, not to a previously-viewed section.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.waitForURL(/\/rooms/, { timeout: 20_000 });
  });

  test('toggles the app theme between dark and light', async ({ page }) => {
    await openSection(page, 'appearance');
    await page.getByTestId('theme-dark').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(true);

    await page.getByTestId('theme-light').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(false);
  });

  test('selects a colour palette from the dropdown', async ({ page }) => {
    await openSection(page, 'appearance');

    // The default palette sets no data-theme attribute.
    expect(await paletteAttr(page)).toBeNull();

    const trigger = page.getByTestId('palette-select').locator('button');
    const amethyst = page.getByTestId('palette-amethyst');

    // Closed to start: the options live in the popover overlay, absent until opened.
    // (A missing *hlmSelectPortal renders them inline and the dropdown can never close.)
    await expect(amethyst).toHaveCount(0);

    // Open → the options appear; pick Amethyst → <html data-theme> reflects it AND the
    // overlay closes again. jsdom can't drive this overlay; the unit spec covers the rest.
    await trigger.click();
    await expect(amethyst).toBeVisible();
    await amethyst.click();
    await expect.poll(() => paletteAttr(page)).toBe('amethyst');
    await expect(amethyst).toHaveCount(0); // closed after selecting
    // #168: and the closed trigger reads the label, not the stored id `amethyst`.
    await expect(trigger).toHaveText('Amethyst');

    // Back to the default palette → the attribute is removed again.
    await trigger.click();
    await page.getByTestId('palette-trinity').click();
    await expect.poll(() => paletteAttr(page)).toBeNull();
    await expect(amethyst).toHaveCount(0);
    await expect(trigger).toHaveText('Trinity');
  });

  test('shows the homeserver software and version for the signed-in account', async ({
    page,
  }) => {
    // The one claim jsdom cannot make: that a real cross-origin request for
    // /_matrix/federation/v1/version survives the app's real CSP
    // (`connect-src 'self' https: wss:`) in a real browser. The probe logic, its two-attempt
    // fallback and the whole failure taxonomy are unit-tested; this is the wire.
    await openSection(page, 'server');

    const block = page.getByTestId('server-block').first();
    await expect(block).toBeVisible({ timeout: 20_000 });

    // The shape, not the number: hardcoding the version would make this a second place the
    // Synapse image pin has to be bumped, and it would fail for a reason that is not a bug.
    await expect(block.getByTestId('hs-software')).toHaveText(
      /^\s*Synapse \d+\.\d+/,
      { timeout: 20_000 },
    );
    await expect(block.getByTestId('hs-url')).toHaveText(session.hs as string);
    // Spec versions come from a separate request, so a green software row does not imply it.
    await expect(block.getByTestId('hs-spec-versions')).toContainText('v1.');
  });

  test('shows the server version under the account in the switcher', async ({
    page,
  }) => {
    // The one assertion that exercises the whole switcher chain end to end: reaching for the
    // menu → `accountsOpened` → `RoomShellViewModel.loadHomeserverInfo()` → the per-account
    // signal → the row. Each link is unit-tested in isolation; nothing but this joins them,
    // and the binding in `rooms.page.html` is the kind a unit test in this repo never covers.
    await page.goto('/rooms');
    await page.getByTestId('user-menu-trigger').click();

    await expect(page.getByTestId('account-row-server').first()).toHaveText(
      /^\s*Synapse \d+\.\d+/,
      { timeout: 20_000 },
    );
  });

  test('re-checks the server on demand', async ({ page }) => {
    // "Check again" is the requirement the whole surface exists for — noticing that the
    // value CHANGED — so the button has to actually re-run the probe rather than re-render
    // what was cached at login.
    await openSection(page, 'server');
    const software = page
      .getByTestId('server-block')
      .first()
      .getByTestId('hs-software');
    await expect(software).toHaveText(/^\s*Synapse/, { timeout: 20_000 });

    const versions = page.waitForResponse(
      (res) => res.url().includes('/_matrix/federation/v1/version'),
      { timeout: 20_000 },
    );
    await page.getByTestId('server-check-again').click();
    await versions;

    await expect(software).toHaveText(/^\s*Synapse/);
  });

  test('edits and saves the display name', async ({ page }) => {
    await openSection(page, 'profile');
    const name = `E2E ${Date.now()}`;
    await fillLabeledInput(page, 'Display name', name);
    await page.getByTestId('save-name').click();

    // The profile header reflects the persisted name (Save round-trips the HS).
    await expect(page.getByTestId('profile-display-name')).toHaveText(name, {
      timeout: 20_000,
    });
  });

  test('shows the app version and commit in the settings footer', async ({
    page,
  }) => {
    // "Trinity v<semver> · <short commit>" — the version + a real git short hash
    // regenerated at build time (a `-dirty` suffix may follow on a modified tree).
    await expect(page.getByTestId('settings-build')).toHaveText(
      /Trinity v\d+\.\d+\.\d+ · [0-9a-f]{7}/,
    );
  });

  test('sets your presence state and status message', async ({ page }) => {
    await openSection(page, 'presence');

    // Each presence state is offered; pick "Away" and add a status message.
    await expect(page.getByTestId('presence-online')).toBeVisible();
    await page.getByTestId('presence-unavailable').click();
    await page.getByTestId('presence-status').fill('at lunch');

    // Save round-trips setPresence to the homeserver; the section confirms.
    await page.getByTestId('presence-save').click();
    await expect(page.getByTestId('presence-saved')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('changes the profile picture from the avatar corner badge', async ({
    page,
  }) => {
    await openSection(page, 'profile');
    const change = page.getByTestId('change-avatar');
    await expect(change).toBeVisible();
    // Icon-only control: a labelled button carrying an SVG icon, no "Change" text.
    await expect(change).toHaveAttribute(
      'aria-label',
      'Change profile picture',
    );
    await expect(change.locator('svg')).toBeVisible();
    await expect(change).not.toContainText('Change');

    // Clicking the badge opens the hidden file input's chooser; upload a PNG.
    const chooserPromise = page.waitForEvent('filechooser');
    await change.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });

    // setAvatar patches the profile's mxc, so the picture round-trips the
    // homeserver and the avatar (beside the badge) renders as an <img>.
    const avatar = change.locator('..').locator('trn-avatar img');
    await expect(avatar).toBeVisible({ timeout: 30_000 });
  });

  test('lists the current device under Devices', async ({ page }) => {
    await openSection(page, 'devices');
    const devices = page.locator('trn-devices-section');
    await expect(devices.getByText('Devices', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Once the list loads, the signed-in session carries a "This device" badge.
    await expect(devices.getByText('This device')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('toggles and persists the virtualized-timeline flag', async ({
    page,
  }) => {
    await openSection(page, 'experimental');
    // Capacitor Preferences stores non-secret prefs in localStorage under this key.
    const KEY = 'CapacitorStorage.trinity.flags.virtual-timeline';
    const read = () => page.evaluate((k) => localStorage.getItem(k), KEY);

    const checkbox = page
      .getByTestId('flag-virtual-timeline')
      .locator('trn-checkbox');
    await expect(checkbox).toBeVisible();
    // The virtualized timeline is on by default (163fcc4) and nothing is persisted
    // until the flag is toggled, so the first click turns it OFF and writes 'false'.
    expect(await read()).toBeNull();

    await checkbox.click();
    await expect.poll(read).toBe('false'); // persisted to Preferences

    // Survives a reload — the deep-linked sub-page restores and the flag reads back.
    await page.reload();
    await expect(
      page.getByTestId('flag-virtual-timeline').locator('trn-checkbox'),
    ).toBeVisible({ timeout: 20_000 });
    expect(await read()).toBe('false');

    // Toggling back on persists too.
    await page
      .getByTestId('flag-virtual-timeline')
      .locator('trn-checkbox')
      .click();
    await expect.poll(read).toBe('true');
  });

  test('mobile: shows the category list, drills into a section, and backs out', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/settings'); // narrow: the index stays on the category list

    const appearance = page.getByTestId('settings-nav-appearance');
    await expect(appearance).toBeVisible({ timeout: 20_000 });
    // The index shows only the list — no section detail (theme options) yet.
    await expect(page.getByTestId('theme-dark')).toBeHidden();

    // Drilling into a section swaps to its detail; the list collapses (single-pane).
    await appearance.click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    await expect(page.getByTestId('theme-dark')).toBeVisible();
    await expect(appearance).toBeHidden();

    // The header back returns to the category list.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(appearance).toBeVisible();
    await expect(page.getByTestId('theme-dark')).toBeHidden();
  });

  test('mobile: a deep-linked section can still reach the list via back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    // Deep-link straight into a section — no prior /settings entry in history.
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('theme-dark')).toBeVisible({
      timeout: 20_000,
    });
    // Single-pane detail view: the category list is collapsed.
    await expect(page.getByTestId('settings-nav-appearance')).toBeHidden();

    // Header back goes UP to the list even though history holds no /settings entry
    // (Location.back() would leave settings; the shell routes up instead).
    await page.getByRole('button', { name: 'Back' }).click();
    await page.waitForURL(/\/settings$/, { timeout: 20_000 });
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
    await expect(page.getByTestId('theme-dark')).toBeHidden();
  });
});
