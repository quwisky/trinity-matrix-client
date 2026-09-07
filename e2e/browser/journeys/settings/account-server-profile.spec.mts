import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  fillLabeledInput,
  isAndroidE2E,
  readPreference,
} from '../../../support/app.mts';
import {
  PNG_1x1,
  configureSettingsSuite,
  openSection,
  session,
} from '../../support/settings-journey.mts';

test.describe('Settings', () => {
  configureSettingsSuite();

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

  test('expanding the unstable features does not add a second scrollbar', async ({
    page,
  }) => {
    // jsdom has no layout, so this can only be checked in a browser. At a line per flag the
    // disclosure added ~256px to the block, which pushed the settings detail pane into its
    // own scrollbar beside the submenu's on any window under ~610px tall. 600px is inside
    // the band that used to fail and is an ordinary laptop-with-dock height.
    await page.setViewportSize({ width: 1280, height: 600 });
    await openSection(page, 'server');
    await expect(page.getByTestId('hs-software')).toBeVisible({
      timeout: 20_000,
    });

    const detailGeometry = () =>
      page.getByTestId('settings-detail').evaluate((pane) => {
        const rect = pane.getBoundingClientRect();
        let ancestorScrollbars = 0;
        for (
          let parent = pane.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const overflow = getComputedStyle(parent).overflowY;
          if (
            /^(auto|scroll)$/.test(overflow) &&
            parent.scrollHeight > parent.clientHeight + 1
          ) {
            ancestorScrollbars++;
          }
        }
        return {
          overflows: pane.scrollHeight > pane.clientHeight + 1,
          ancestorScrollbars,
          documentOverflow: document.scrollingElement
            ? document.scrollingElement.scrollHeight -
              document.scrollingElement.clientHeight
            : 0,
          contained: rect.left >= -1 && rect.right <= innerWidth + 1,
          horizontalOverflow: pane.scrollWidth - pane.clientWidth,
        };
      });

    expect((await detailGeometry()).overflows).toBe(false);
    await page.getByTestId('hs-unstable').locator('summary').click();
    await expect(page.getByTestId('hs-unstable')).toHaveAttribute('open', '');

    const expanded = await detailGeometry();
    expect(expanded.ancestorScrollbars).toBe(0);
    expect(expanded.documentOverflow).toBeLessThanOrEqual(1);
    expect(expanded.contained).toBe(true);
    expect(expanded.horizontalOverflow).toBeLessThanOrEqual(1);
    // Native Settings is routed, with host chrome above the detail pane. Its one
    // content scroller may be needed; the fixed-height desktop dialog still fits.
    if (!isAndroidE2E) expect(expanded.overflows).toBe(false);
    const flagRows = await page
      .getByTestId('hs-unstable')
      .locator('li')
      .evaluateAll((flags) => ({
        count: flags.length,
        rows: new Set(
          flags.map((flag) => Math.round(flag.getBoundingClientRect().top)),
        ).size,
      }));
    expect(flagRows.count).toBeGreaterThan(1);
    expect(
      flagRows.rows,
      'flags wrap compactly instead of one flag per line',
    ).toBeLessThan(flagRows.count);
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
    const name = `E2E ${testResourceId('display-name')}`;
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
    const KEY = 'trinity.flags.virtual-timeline';
    const read = () => readPreference(page, KEY);

    const checkbox = page
      .getByTestId('flag-virtual-timeline')
      .locator('trn-switch');
    await expect(checkbox).toBeVisible();
    // The virtualized timeline is on by default (163fcc4) and nothing is persisted
    // until the flag is toggled, so the first click turns it OFF and writes 'false'.
    expect(await read()).toBeNull();

    await checkbox.click();
    await expect.poll(read).toBe('false'); // persisted to Preferences

    // Survives a reload through the deliberate routed deep-link fallback.
    await page.goto('/settings/experimental');
    await page.reload();
    await expect(
      page.getByTestId('flag-virtual-timeline').locator('trn-switch'),
    ).toBeVisible({ timeout: 20_000 });
    expect(await read()).toBe('false');

    // Toggling back on persists too.
    await page
      .getByTestId('flag-virtual-timeline')
      .locator('trn-switch')
      .click();
    await expect.poll(read).toBe('true');
  });
});
