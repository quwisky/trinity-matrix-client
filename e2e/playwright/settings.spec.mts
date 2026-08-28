import { devices, test, expect, type Page } from './support/fixtures.mts';
import {
  login,
  fillLabeledInput,
  readPreference,
  synapseSession,
} from './support/app.mts';
import {
  AA_NORMAL_TEXT,
  measureContrast,
  resolveTokenSrgb,
} from './support/contrast.mts';

// Authenticated journeys through Settings — theme switching, profile editing,
// device management, and the responsive section submenu (two-pane on desktop,
// list → sub-page on mobile). They need a live homeserver, so the suite skips
// itself when the disposable Synapse wasn't available (no Docker).
const session = synapseSession();
const PIXEL_5 = devices['Pixel 5'];

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
  'stickers',
  'shortcuts',
  'experimental',
  'advanced',
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

/** Open a settings section inside the web modal. */
async function openSection(page: Page, path: string): Promise<void> {
  await page.getByTestId(`settings-nav-${path}`).click();
  await expect(page.getByTestId('settings-detail')).not.toBeEmpty();
}

test.describe('Settings', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.beforeEach(async ({ page }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({
      timeout: 20_000,
    });
    // The modal shell loads; on the desktop viewport it auto-lands on Profile.
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
    // Selecting a section swaps the modal detail without changing the room URL.
    await openSection(page, 'appearance');
    await expect(page.getByTestId('theme-dark')).toBeVisible();
    await openSection(page, 'experimental');
    await expect(page.getByTestId('flag-virtual-timeline')).toBeVisible();
  });

  test('desktop: auto-selects the first section and shows both panes', async ({
    page,
  }) => {
    // The default (wide) viewport auto-selects the first section and renders the
    // submenu and detail together without replacing the underlying room route.
    await expect(page).not.toHaveURL(/\/settings/);
    await expect(page.getByTestId('settings-nav-profile')).toBeVisible();
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    // The active section link is marked current for assistive tech.
    await expect(page.getByTestId('settings-nav-profile')).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Two panes SIDE BY SIDE, and the active link visibly marked. Both used to come from
    // `settings.page.scss` media queries and now come from md-prefixed utilities, which
    // jsdom cannot evaluate at all — it applies no cascade and no media queries, so the
    // unit suite can only see that a class string is present. Measured here instead.
    const nav = page.locator('nav[aria-label="Settings sections"]');
    const navBox = await nav.boundingBox();
    const detailBox = await page.getByTestId('settings-detail').boundingBox();
    expect(navBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    // Beside, not stacked: the detail starts after the nav ends.
    expect(detailBox!.x).toBeGreaterThanOrEqual(navBox!.x + navBox!.width - 1);
    expect(navBox!.width).toBe(256);

    // The mobile drill-in chevron is suppressed in the sidebar — and it is suppressed by
    // NOT BEING RENDERED, which is why this asserts absence rather than a computed style.
    // It was `md:hidden` first, and that class is inert here: Tailwind's utilities live in
    // `@layer utilities` while a `trn-*` component's own `:host { display: … }` is
    // unlayered, and an unlayered author declaration beats a layered one whatever the
    // specificity. Chromium reported `flex` with the class applied.
    await expect(
      page
        .getByTestId('settings-nav-profile')
        .locator('trn-icon[name="chevron-right"]'),
    ).toHaveCount(0);

    // The active cue is an inset accent bar, and it has to differ from plain hover —
    // which uses the same background token, so background alone would say nothing.
    const shadow = await page
      .getByTestId('settings-nav-profile')
      .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe('none');
  });

  test('desktop: settings content uses the shared grouped hierarchy', async ({
    page,
  }) => {
    await openSection(page, 'appearance');

    const mode = page.getByTestId('appearance-mode-palette');
    const layout = page.getByTestId('appearance-layout');
    await expect(mode).toBeVisible();
    await expect(layout).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: 'Mode and palette' }),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Palette' })).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Conversation density' }),
    ).toBeVisible();

    const pointerOption = page.getByTestId('theme-light');
    await pointerOption.click();
    expect(
      await pointerOption.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      ),
    ).toBe('none');

    const lightRadio = page.getByRole('radio', { name: 'Light' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(lightRadio).toBeFocused();
    const focusPaint = await pointerOption.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focusPaint.style).not.toBe('none');
    expect(focusPaint.width).toBeGreaterThanOrEqual(2);

    const densityRow = page.getByTestId('density-select').locator('..');
    const densityLabel = page.locator('#appearance-density-heading');
    const densityControl = page.getByRole('combobox', {
      name: 'Conversation density',
    });
    const [rowBox, labelBox, controlBox] = await Promise.all([
      densityRow.boundingBox(),
      densityLabel.boundingBox(),
      densityControl.boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    expect(controlBox).not.toBeNull();
    expect(controlBox!.x).toBeGreaterThan(labelBox!.x + labelBox!.width);
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(
      rowBox!.x + rowBox!.width + 1,
    );

    await openSection(page, 'notifications');
    const notificationRow = page.locator('[data-testid^="notif-"]').first();
    const notificationSwitch = notificationRow.getByRole('switch');
    const [notificationBox, switchBox] = await Promise.all([
      notificationRow.boundingBox(),
      notificationSwitch.boundingBox(),
    ]);
    expect(notificationBox).not.toBeNull();
    expect(switchBox).not.toBeNull();
    expect(switchBox!.x).toBeGreaterThan(
      notificationBox!.x + notificationBox!.width / 2,
    );

    const settingsDetail = page.getByTestId('settings-detail');
    await settingsDetail.evaluate((element) => {
      (element as HTMLElement).dir = 'rtl';
    });
    await openSection(page, 'appearance');
    const [rtlLabelBox, rtlControlBox] = await Promise.all([
      densityLabel.boundingBox(),
      densityControl.boundingBox(),
    ]);
    expect(rtlLabelBox).not.toBeNull();
    expect(rtlControlBox).not.toBeNull();
    expect(rtlControlBox!.x + rtlControlBox!.width).toBeLessThanOrEqual(
      rtlLabelBox!.x,
    );
    expect(
      await page
        .getByTestId('settings-detail')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);

    await openSection(page, 'notifications');
    const [rtlNotificationBox, rtlSwitchBox] = await Promise.all([
      notificationRow.boundingBox(),
      notificationSwitch.boundingBox(),
    ]);
    expect(rtlNotificationBox).not.toBeNull();
    expect(rtlSwitchBox).not.toBeNull();
    expect(rtlSwitchBox!.x + rtlSwitchBox!.width).toBeLessThan(
      rtlNotificationBox!.x + rtlNotificationBox!.width / 2,
    );
    await settingsDetail.evaluate((element) => {
      (element as HTMLElement).dir = 'ltr';
    });

    await openSection(page, 'profile');
    await expect(
      page.getByText('Manage the name and avatar people see across Matrix.'),
    ).toBeVisible();
    await openSection(page, 'advanced');
    await expect(
      page.getByText(
        'Inspect, move or reset the preferences stored on this device.',
      ),
    ).toBeVisible();
  });

  test('desktop: close leaves settings without changing the room route', async ({
    page,
  }) => {
    const roomUrl = page.url();
    // Lateral section switches on the two-pane layout stay local to the modal.
    await openSection(page, 'appearance');
    await openSection(page, 'devices');
    await openSection(page, 'gifs');

    await page.getByTestId('close-settings').click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    await expect(page).toHaveURL(roomUrl);
  });

  test('toggles the app theme between dark and light', async ({ page }) => {
    await openSection(page, 'appearance');
    await page.getByTestId('theme-dark').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(true);

    const paletteTrigger = page.getByRole('combobox', { name: 'Palette' });
    await paletteTrigger.evaluate((element) => {
      element.setAttribute('data-testid', 'dark-palette-trigger');
    });
    const selectText = await resolveTokenSrgb(
      page,
      'dark-palette-trigger',
      '--trinity-text-bright',
    );
    await expect
      .poll(
        async () => (await measureContrast(page, 'dark-palette-trigger')).text,
      )
      .toEqual(selectText);
    const selectPaint = await measureContrast(page, 'dark-palette-trigger');
    expect(selectPaint.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

    await paletteTrigger.evaluate((element) => {
      element.setAttribute('data-placeholder', '');
    });
    const placeholderText = await resolveTokenSrgb(
      page,
      'dark-palette-trigger',
      '--muted-foreground',
    );
    await expect
      .poll(
        async () => (await measureContrast(page, 'dark-palette-trigger')).text,
      )
      .toEqual(placeholderText);
    await paletteTrigger.evaluate((element) => {
      element.removeAttribute('data-placeholder');
    });
    await expect
      .poll(
        async () => (await measureContrast(page, 'dark-palette-trigger')).text,
      )
      .toEqual(selectText);

    await openSection(page, 'notifications');
    const switchLabel = page.locator('[data-testid^="notif-"]').first();
    await switchLabel.evaluate((element) => {
      element.setAttribute('data-testid', 'dark-switch-label');
    });
    const switchPaint = await measureContrast(page, 'dark-switch-label');
    expect(switchPaint.text).toEqual(
      await resolveTokenSrgb(
        page,
        'dark-switch-label',
        '--trinity-text-bright',
      ),
    );
    expect(switchPaint.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

    // The account-dock gear used to expose a native `title`, which the browser painted as
    // a light OS tooltip regardless of Trinity's selected theme. Close the dialog and drive
    // that exact control: a role=tooltip proves it now uses the design-system overlay, while
    // computed paint proves the public wrapper resolves its semantic pair in a real cascade.
    await page.getByTestId('close-settings').click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    const settingsButton = page.getByRole('button', {
      name: 'Settings',
      exact: true,
    });
    await expect(settingsButton).not.toHaveAttribute('title');
    await settingsButton.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toHaveText('Settings');
    await tooltip.evaluate((element) => {
      element.setAttribute('data-testid', 'settings-tooltip');
    });
    const paint = await measureContrast(page, 'settings-tooltip');
    const expectedBackground = await resolveTokenSrgb(
      page,
      'settings-tooltip',
      '--trinity-tooltip-surface',
    );
    const expectedForeground = await resolveTokenSrgb(
      page,
      'settings-tooltip',
      '--trinity-tooltip-foreground',
    );
    const arrowPaint = await tooltip.locator('svg').evaluate((element) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('tooltip arrow: no 2d canvas context');
      context.fillStyle = getComputedStyle(element).fill;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a };
    });

    expect(await hasDarkPalette(page)).toBe(true);
    expect(paint.background).toEqual(expectedBackground);
    expect(paint.text).toEqual(expectedForeground);
    expect(
      Math.max(paint.background.r, paint.background.g, paint.background.b),
    ).toBeLessThan(96);
    expect(paint.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(arrowPaint).toEqual({ ...expectedBackground, a: 255 });

    await page.mouse.move(0, 0);
    await settingsButton.click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await openSection(page, 'appearance');
    await page.getByTestId('theme-light').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(false);
  });

  test('compact density tightens the spacing scale itself', async ({
    page,
  }) => {
    await openSection(page, 'appearance');

    const spaceToken = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--trinity-space-5')
          .trim(),
      );
    const densityAttr = () =>
      page.evaluate(() =>
        document.documentElement.getAttribute('data-density'),
      );
    const previewGap = () =>
      page
        .locator('.preview__canvas')
        .first()
        .evaluate((element) => getComputedStyle(element).columnGap);

    // The default leaves no attribute, and the scale is the 4px rhythm's 16px step.
    expect(await densityAttr()).toBeNull();
    expect(await spaceToken()).toBe('16px');
    expect(await previewGap()).toBe('12px');

    const trigger = page.getByTestId('density-select').locator('button');
    await trigger.click();
    await page.getByTestId('density-compact').click();

    // The TOKEN moves, not a component override — which is the whole design: anything
    // reading `--trinity-space-*` follows without knowing the preference exists. Only a
    // real cascade can show this; jsdom resolves no custom properties through a
    // `[data-density]` selector, so the unit spec can only see the attribute.
    await expect.poll(densityAttr).toBe('compact');
    await expect.poll(spaceToken).toBe('12px');
    await expect.poll(previewGap).toBe('8px');
    await expect(page.getByTestId('appearance-preview-state')).toContainText(
      'Compact',
    );

    // Back to cosy → the attribute goes and the scale returns.
    await trigger.click();
    await page.getByTestId('density-cosy').click();
    await expect.poll(densityAttr).toBeNull();
    await expect.poll(spaceToken).toBe('16px');
  });

  test('125% text and Compact keep settings controls inside their pane', async ({
    page,
  }) => {
    await openSection(page, 'appearance');

    await page.getByTestId('text-scale-select').locator('button').click();
    await page.getByTestId('text-scale-larger').click();
    await page.getByTestId('density-select').locator('button').click();
    await page.getByTestId('density-compact').click();

    const geometry = await page.evaluate(() => {
      const detail = document.querySelector<HTMLElement>(
        '[data-testid=settings-detail]',
      );
      const preview = document.querySelector<HTMLElement>(
        '[data-testid=appearance-preview]',
      );
      if (!detail || !preview) throw new Error('settings geometry missing');
      const pane = detail.getBoundingClientRect();
      const sample = preview.getBoundingClientRect();
      const controls = [...detail.querySelectorAll<HTMLElement>('button')].map(
        (control) => control.getBoundingClientRect(),
      );
      return {
        horizontalOverflow: detail.scrollWidth - detail.clientWidth,
        previewInside:
          sample.left >= pane.left - 1 && sample.right <= pane.right + 1,
        controlsInside: controls.every(
          (control) =>
            control.left >= pane.left - 1 && control.right <= pane.right + 1,
        ),
      };
    });

    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(geometry.previewInside).toBe(true);
    expect(geometry.controlsInside).toBe(true);
  });

  // The kit's overlay panels animate open with `animate-in` from `tw-animate-css`, which
  // ships no reduced-motion guard. `hlm-select-content` now carries `motion-safe:`, so the
  // class is not applied at all under `reduce` and the panel resolves NO animation.
  //
  // This is discriminable underneath the blanket `!important` reset in `global.scss`
  // precisely because that blanket sets `animation-duration` and `-iteration-count` and
  // never touches `animation-name`: without `motion-safe:` the panel still resolves the
  // `enter` keyframes here, it just runs them instantly.
  test('a select panel resolves no animation under reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openSection(page, 'appearance');

    const trigger = page.getByTestId('palette-select').locator('button');
    await trigger.click();
    const panel = page.locator('hlm-select-content').first();
    await expect(panel).toBeVisible();

    expect(
      await panel.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('none');
  });

  // The positive control for the test above. Without it, `'none'` also holds if the panel
  // never gets `data-state="open"`, if the `data-open` custom variant is dropped from the
  // theme, or if the animate class is removed outright — none of which is what that test
  // claims to measure.
  test('a select panel does animate when motion is not reduced', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openSection(page, 'appearance');

    const trigger = page.getByTestId('palette-select').locator('button');
    await trigger.click();
    const panel = page.locator('hlm-select-content').first();
    await expect(panel).toBeVisible();

    expect(
      await panel.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('enter');
  });

  test('selects a colour palette from the dropdown', async ({ page }) => {
    await openSection(page, 'appearance');

    // The default palette sets no data-theme attribute.
    expect(await paletteAttr(page)).toBeNull();
    const previewAccent = () =>
      page
        .locator('.preview__avatar')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
    const initialPreviewAccent = await previewAccent();

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
    expect(await previewAccent()).not.toBe(initialPreviewAccent);

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

    // The detail pane is the scroller. It used to be `.settings__detail`; that class went
    // when the page moved to utilities, and a `querySelector` for it returned null — which
    // made `!!pane && …` short-circuit to false and BOTH assertions below pass whatever
    // the pane did. Located structurally now, and thrown on rather than defaulted, so the
    // check cannot go quiet again.
    const detailOverflows = () =>
      page.evaluate(() => {
        const pane = document.querySelector('[data-testid="settings-detail"]');
        if (!pane) {
          throw new Error('settings detail pane not found');
        }
        return pane.scrollHeight > pane.clientHeight + 1;
      });

    expect(await detailOverflows()).toBe(false);
    await page.getByTestId('hs-unstable').locator('summary').click();
    await expect(page.getByTestId('hs-unstable')).toHaveAttribute('open', '');

    expect(await detailOverflows()).toBe(false);
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
    await expect(
      page.getByRole('heading', { name: 'Appearance' }),
    ).toBeFocused();

    // The header back returns to the category list.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(appearance).toBeVisible();
    await expect(page.getByTestId('theme-dark')).toBeHidden();
    await expect(appearance).toBeFocused();
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
    await expect(
      page.getByRole('heading', { name: 'Appearance' }),
    ).toBeFocused();

    // Header back goes UP to the list even though history holds no /settings entry
    // (Location.back() would leave settings; the shell routes up instead).
    await page.getByRole('button', { name: 'Back' }).click();
    await page.waitForURL(/\/settings$/, { timeout: 20_000 });
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
    await expect(page.getByTestId('theme-dark')).toBeHidden();
  });

  test('narrow web: resizing a drilled-in modal wide keeps one dialog', async ({
    page,
  }) => {
    await page.getByTestId('close-settings').click();
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByTestId('open-settings').click();
    const appearance = page.getByTestId('settings-nav-appearance');
    await expect(appearance).toBeVisible({ timeout: 20_000 });
    await appearance.click();
    await expect(page.getByTestId('theme-dark')).toBeVisible();

    // Crossing the responsive boundary changes the modal composition, not its
    // presentation model or the underlying URL.
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(appearance).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(1);
    await page.getByTestId('close-settings').click();
    await expect(page).not.toHaveURL(/\/settings/);
  });

  test('narrow web: modal back restores directory focus', async ({ page }) => {
    await page.getByTestId('close-settings').click();
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByTestId('open-settings').click();
    const appearance = page.getByTestId('settings-nav-appearance');
    await appearance.click();
    await page
      .getByRole('button', { name: 'Back to settings sections' })
      .click();
    await expect(appearance).toBeFocused();

    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    await page.getByTestId('close-settings').click();
    await expect(page).not.toHaveURL(/\/settings/);
  });

  test.describe('Pixel 5 profile', () => {
    test.use({
      viewport: PIXEL_5.viewport,
      userAgent: PIXEL_5.userAgent,
      deviceScaleFactor: PIXEL_5.deviceScaleFactor,
      isMobile: PIXEL_5.isMobile,
      hasTouch: PIXEL_5.hasTouch,
    });

    test('keeps drill-in navigation, touch targets, and width containment', async ({
      page,
    }) => {
      await page.goto('/settings');
      const appearance = page.getByTestId('settings-nav-appearance');
      await expect(appearance).toBeVisible({ timeout: 20_000 });

      const profile = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        touchPoints: navigator.maxTouchPoints,
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      }));
      expect(profile.userAgent).toContain('Android');
      expect(profile.touchPoints).toBeGreaterThan(0);
      expect(profile.overflow).toBeLessThanOrEqual(1);
      const target = await appearance.boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);

      await appearance.click();
      await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
      await expect(
        page.getByRole('heading', { name: 'Appearance' }),
      ).toBeFocused();

      await page.getByTestId('text-scale-select').getByRole('combobox').click();
      await page.getByTestId('text-scale-larger').click();
      await page.getByTestId('density-select').getByRole('combobox').click();
      await page.getByTestId('density-compact').click();

      const appearanceGeometry = () =>
        page.evaluate(() => {
          const detail = document.querySelector<HTMLElement>(
            '[data-testid=settings-detail]',
          );
          if (!detail) throw new Error('settings detail pane missing');
          const pane = detail.getBoundingClientRect();
          const controls = [
            ...detail.querySelectorAll<HTMLElement>(
              '[role=combobox], [data-testid^=theme-]',
            ),
          ]
            .map((element) => element.getBoundingClientRect())
            .filter((box) => box.width > 0 && box.height > 0);
          return {
            documentOverflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
            detailOverflow: detail.scrollWidth - detail.clientWidth,
            controlsInside: controls.every(
              (control) =>
                control.left >= pane.left - 1 &&
                control.right <= pane.right + 1,
            ),
          };
        });

      const pixelGeometry = await appearanceGeometry();
      expect(pixelGeometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(pixelGeometry.detailOverflow).toBeLessThanOrEqual(1);
      expect(pixelGeometry.controlsInside).toBe(true);
      expect(
        (await page.getByRole('combobox', { name: 'Palette' }).boundingBox())
          ?.height ?? 0,
      ).toBeGreaterThanOrEqual(44);

      await page.setViewportSize({ width: 320, height: 568 });
      const narrowGeometry = await appearanceGeometry();
      expect(narrowGeometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(narrowGeometry.detailOverflow).toBeLessThanOrEqual(1);
      expect(narrowGeometry.controlsInside).toBe(true);
      await page.goBack();
      await expect(appearance).toBeFocused();
    });
  });
});
