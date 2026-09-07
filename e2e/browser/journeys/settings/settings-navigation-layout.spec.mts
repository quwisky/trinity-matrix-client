import { captureScreenshot } from '../../../support/screenshot.mts';
import { expect, test, testResourceId } from '../../../fixtures.mts';
import { isAndroidE2E } from '../../../support/app.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  PIXEL_5,
  SECTIONS,
  configureSettingsSuite,
  openSection,
  session,
  settingsTitleAlignment,
} from '../../support/settings-journey.mts';
import { settingsLayoutMetrics } from '../../support/settings-layout.mts';

test.describe('Settings', () => {
  configureSettingsSuite();

  test('lists and navigates between sections from the submenu', async ({
    page,
  }) => {
    for (const path of SECTIONS) {
      await expect(page.getByTestId(`settings-nav-${path}`)).toBeVisible();
    }
    // Selecting a section swaps the active Settings detail.
    await openSection(page, 'appearance');
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    await openSection(page, 'experimental');
    await expect(page.getByTestId('flag-virtual-timeline')).toBeVisible();
  });

  test('desktop: auto-selects the first section and shows both panes', async ({
    page,
  }) => {
    // The default (wide) viewport auto-selects the first section and renders the
    // submenu and detail together. Web keeps the underlying room URL; installed
    // Capacitor hosts expose the same composition through a routed Settings page.
    if (isAndroidE2E) {
      await expect(page).toHaveURL(/\/settings\/profile$/);
    } else {
      await expect(page).not.toHaveURL(/\/settings/);
    }
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
    // Android WebView reports CSS-pixel geometry as a float after device-scale
    // conversion (for example 255.999992px for this exact 16rem pane).
    expect(navBox!.width).toBeCloseTo(256, 4);
    if (!isAndroidE2E) {
      await expect
        .poll(async () => Math.abs(await settingsTitleAlignment(page)))
        .toBeLessThanOrEqual(1);

      const settingsDialog = page.getByTestId('settings-dialog');
      await settingsDialog.evaluate((element) => {
        element.setAttribute('dir', 'rtl');
      });
      await expect
        .poll(async () => Math.abs(await settingsTitleAlignment(page)))
        .toBeLessThanOrEqual(1);
      await settingsDialog.evaluate((element) => {
        element.setAttribute('dir', 'ltr');
      });
    }

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

    // The public button recipe owns the active cue. Compare it with an idle peer so this
    // proves the selected surface is visibly distinct without pinning a private recipe class.
    const [activeBackground, idleBackground] = await Promise.all([
      page
        .getByTestId('settings-nav-profile')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      page
        .getByTestId('settings-nav-presence')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ]);
    expect(activeBackground).not.toBe(idleBackground);
  });

  test('desktop: Room and Space use the same scaled settings frame', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'the routed Android Settings page has its own host',
    );
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}settingsframe`;
    const roomName = `Frame room ${runId}`;
    const spaceName = `Frame space ${runId}`;
    const accessToken = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: session.user },
          password: session.pass,
        },
      })
      .then((response) => response.json())
      .then((body) => body.access_token as string);
    const headers = { Authorization: `Bearer ${accessToken}` };
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    });
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    });

    const mainFrame = {
      rootTestId: 'settings-dialog',
      directoryTestId: 'settings-dialog-directory',
      detailTestId: 'settings-detail',
    } as const;
    const unscaled = await settingsLayoutMetrics(page, mainFrame);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    const main = await settingsLayoutMetrics(page, mainFrame);
    expect(main.titleFontSize).toBeGreaterThan(unscaled.titleFontSize);
    expect(main.directoryLabelFontSize).toBeGreaterThan(
      unscaled.directoryLabelFontSize,
    );

    const expectSharedFrame = (actual: typeof main): void => {
      expect(actual.headerHeight).toBeCloseTo(main.headerHeight, 4);
      expect(actual.directoryWidth).toBeCloseTo(main.directoryWidth, 4);
      expect(actual.directoryIconWidth).toBeCloseTo(main.directoryIconWidth, 4);
      expect(actual.directoryLabelFontSize).toBeCloseTo(
        main.directoryLabelFontSize,
        4,
      );
      expect(actual.titleFontSize).toBeCloseTo(main.titleFontSize, 4);
      expect(actual.titleLineHeight).toBeCloseTo(main.titleLineHeight, 4);
      expect(actual.detailStartsAfterDirectory).toBe(true);
      expect(actual.directoryOverflowY).toBe('auto');
      expect(actual.detailOverflowY).toBe('auto');
      expect(actual.horizontalOverflow).toBeLessThanOrEqual(1);
    };
    expectSharedFrame(main);
    await test.info().attach('main-settings-desktop-scaled', {
      body: await captureScreenshot(page, () =>
        page.getByTestId('settings-dialog').screenshot(),
      ),
      contentType: 'image/png',
    });

    await closeSettings(page);
    await page.getByTestId('rail-rooms').click();
    const room = page.locator('.channel', { hasText: roomName }).first();
    await room.waitFor({ state: 'visible', timeout: 30_000 });
    await room.click();
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible();
    const roomFrame = await settingsLayoutMetrics(page, {
      rootTestId: 'room-settings',
      directoryTestId: 'room-settings-directory',
      detailTestId: 'room-settings-detail',
    });
    expectSharedFrame(roomFrame);
    await test.info().attach('room-settings-desktop-scaled', {
      body: await captureScreenshot(page, () =>
        page.getByTestId('room-settings').screenshot(),
      ),
      contentType: 'image/png',
    });
    const roomHeader = page
      .getByTestId('room-settings')
      .locator('.settings-layout__header');
    await expect(roomHeader.getByTestId('room-settings-room-name')).toHaveText(
      roomName,
    );
    await expect(roomHeader.getByTestId('room-settings-account')).toContainText(
      session.user as string,
    );
    await page.getByTestId('room-settings-cancel').click();

    const space = page.getByRole('button', { name: spaceName, exact: true });
    await space.waitFor({ state: 'visible', timeout: 30_000 });
    await space.click();
    await page.getByTestId('space-actions-overflow').click();
    await page.getByTestId('open-space-settings').click();
    await expect(page.getByTestId('space-settings')).toBeVisible();
    const spaceFrame = await settingsLayoutMetrics(page, {
      rootTestId: 'space-settings',
      directoryTestId: 'space-settings-directory',
      detailTestId: 'space-settings-detail',
    });
    expectSharedFrame(spaceFrame);
    await test.info().attach('space-settings-desktop-scaled', {
      body: await captureScreenshot(page, () =>
        page.getByTestId('space-settings').screenshot(),
      ),
      contentType: 'image/png',
    });
    const spaceHeader = page
      .getByTestId('space-settings')
      .locator('.settings-layout__header');
    await expect(
      spaceHeader.getByTestId('space-settings-space-name'),
    ).toHaveText(spaceName);
    await expect(
      spaceHeader.getByTestId('space-settings-account'),
    ).toContainText(session.user as string);
  });

  test('desktop: settings content uses the shared grouped hierarchy', async ({
    page,
  }) => {
    await openSection(page, 'appearance');

    const mode = page.getByTestId('appearance-mode-theme');
    const layout = page.getByTestId('appearance-layout');
    await expect(mode).toBeVisible();
    await expect(layout).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: 'Mode and Theme' }),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Conversation density' }),
    ).toBeVisible();

    const pointerOption = page.getByTestId('mode-light');
    await pointerOption.click();
    expect(
      await pointerOption.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      ),
    ).toBe('none');

    const lightRadio = page.getByRole('radio', { name: 'Light' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(lightRadio).toBeFocused();
    const focusPaint = await pointerOption.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outline: style.outlineStyle,
        shadow: style.boxShadow,
      };
    });
    // The canonical radio recipe paints keyboard focus as a shadow on the option label;
    // the native radio remains the focused semantic control.
    expect(focusPaint.outline).toBe('none');
    expect(focusPaint.shadow).not.toBe('none');

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

    // CodeMirror owns this DOM and injects its own base stylesheet at runtime. Trinity's
    // appearance therefore has to enter through EditorView.theme(), not through an unlayered
    // component override. Compare rendered paint to the live semantic tokens and then prove
    // keyboard focus still reaches the editor's supported outer focus treatment.
    const editor = page.getByTestId('advanced-config-editor');
    const editorFrame = page.locator('.cm-editor', { has: editor });
    if (isAndroidE2E) {
      await expect(editor).toHaveCount(0);
      await expect(
        page.getByTestId('advanced-editing-unavailable'),
      ).toBeVisible();
      return;
    }
    await expect(editor).toBeVisible({ timeout: 20_000 });
    const editorPaint = await editorFrame.evaluate((element) => {
      const editorStyle = getComputedStyle(element);
      const resolve = (property: 'color' | 'border-radius', token: string) => {
        const probe = document.createElement('span');
        probe.style.setProperty(property, `var(${token})`);
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).getPropertyValue(property);
        probe.remove();
        return value;
      };
      return {
        background: editorStyle.backgroundColor,
        text: editorStyle.color,
        expectedBackground: resolve('color', '--trinity-chat'),
        expectedText: resolve('color', '--trinity-text'),
        radius: editorStyle.borderRadius,
        expectedRadius: resolve('border-radius', '--trinity-radius-md'),
      };
    });
    expect(editorPaint.background).toBe(editorPaint.expectedBackground);
    expect(editorPaint.text).toBe(editorPaint.expectedText);
    expect(editorPaint.radius).toBe(editorPaint.expectedRadius);

    await editor.focus();
    await expect(editor).toBeFocused();
    await expect
      .poll(() =>
        editorFrame.evaluate(
          (element) => getComputedStyle(element).outlineStyle,
        ),
      )
      .toBe('solid');
  });

  test('desktop: close leaves settings without changing the room route', async ({
    page,
  }) => {
    const roomUrl = page.url();
    // Lateral section switches on the two-pane layout stay local to the modal.
    await openSection(page, 'appearance');
    await openSection(page, 'devices');
    await openSection(page, 'gifs');

    await closeSettings(page);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    if (isAndroidE2E) {
      await expect(page).toHaveURL(
        (url) =>
          url.pathname.startsWith('/rooms') &&
          (url.searchParams.get('account')?.length ?? 0) > 0,
      );
    } else {
      await expect(page).toHaveURL(roomUrl);
    }
  });

  test('mobile: shows the category list, drills into a section, and backs out', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/settings'); // narrow: the index stays on the category list

    const appearance = page.getByTestId('settings-nav-appearance');
    await expect(appearance).toBeVisible({ timeout: 20_000 });
    // The index shows only the list — no section detail (Mode options) yet.
    await expect(page.getByTestId('mode-dark')).toBeHidden();

    // Drilling into a section swaps to its detail; the list collapses (single-pane).
    await appearance.click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    await expect(appearance).toBeHidden();
    await expect(
      page.getByRole('heading', { name: 'Appearance' }),
    ).toBeFocused();

    // The header back returns to the category list.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(appearance).toBeVisible();
    await expect(page.getByTestId('mode-dark')).toBeHidden();
    await expect(appearance).toBeFocused();
  });

  test('mobile: a deep-linked section can still reach the list via back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    // Deep-link straight into a section — no prior /settings entry in history.
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('mode-dark')).toBeVisible({
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
    await expect(page.getByTestId('mode-dark')).toBeHidden();
  });

  test('narrow: resizing a drilled-in surface wide keeps one settings owner', async ({
    page,
  }) => {
    await closeSettings(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await openSettingsFromRooms(page);
    const appearance = page.getByTestId('settings-nav-appearance');
    await expect(appearance).toBeVisible({ timeout: 20_000 });
    await appearance.click();
    await expect(page.getByTestId('mode-dark')).toBeVisible();

    // Crossing the responsive boundary changes the composition, not its host-owned
    // presentation model.
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(appearance).toBeVisible();
    if (isAndroidE2E) {
      await expect(page.locator('trn-settings')).toHaveCount(1);
    } else {
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(
        1,
      );
    }
    await closeSettings(page);
    await expect(page).not.toHaveURL(/\/settings/);
  });

  test('narrow: back restores directory focus', async ({ page }) => {
    await closeSettings(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await openSettingsFromRooms(page);
    const appearance = page.getByTestId('settings-nav-appearance');
    await appearance.click();
    await page
      .getByRole('button', {
        name: isAndroidE2E ? 'Back' : 'Back to sections',
      })
      .click();
    await expect(appearance).toBeFocused();

    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    await closeSettings(page);
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
        devicePixelRatio: window.devicePixelRatio,
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      }));
      expect(profile.userAgent).toContain('Android');
      expect(profile.touchPoints).toBeGreaterThan(0);
      expect(profile.overflow).toBeLessThanOrEqual(1);
      const target = await appearance.boundingBox();
      expect(
        (target?.height ?? 0) * profile.devicePixelRatio,
      ).toBeGreaterThanOrEqual(44 * profile.devicePixelRatio - 0.5);

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
      const themeTarget = await page
        .getByRole('combobox', { name: 'Theme' })
        .boundingBox();
      expect(
        (themeTarget?.height ?? 0) * profile.devicePixelRatio,
      ).toBeGreaterThanOrEqual(44 * profile.devicePixelRatio - 0.5);

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
