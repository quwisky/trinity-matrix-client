import {
  devices,
  expect,
  test,
  testResourceId,
  type Page,
} from '../../../fixtures.mts';
import { login, type HomeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  hasDarkMode,
  configureSettingsSuite,
  openSection,
  themeAttr,
  session,
  settingsTitleAlignment,
} from '../../support/settings-journey.mts';
import {
  AA_NORMAL_TEXT,
  measureContrast,
  resolveTokenSrgb,
} from '../../support/contrast.mts';

test.describe('Settings', () => {
  configureSettingsSuite();

  test('toggles the app theme between dark and light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openSection(page, 'appearance');
    await page.getByTestId('mode-dark').click();
    await expect.poll(() => hasDarkMode(page)).toBe(true);

    // A fixed committed Mode must remain authoritative when the OS changes underneath it.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => hasDarkMode(page)).toBe(true);

    const themeTrigger = page.getByRole('combobox', { name: 'Theme' });
    await themeTrigger.evaluate((element) => {
      element.setAttribute('data-testid', 'dark-theme-trigger');
    });
    const selectText = await resolveTokenSrgb(
      page,
      'dark-theme-trigger',
      '--trinity-text-bright',
    );
    await expect
      .poll(
        async () => (await measureContrast(page, 'dark-theme-trigger')).text,
      )
      .toEqual(selectText);
    const selectPaint = await measureContrast(page, 'dark-theme-trigger');
    expect(selectPaint.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

    await themeTrigger.evaluate((element) => {
      element.setAttribute('data-placeholder', '');
    });
    const placeholderText = await resolveTokenSrgb(
      page,
      'dark-theme-trigger',
      '--muted-foreground',
    );
    await expect
      .poll(
        async () => (await measureContrast(page, 'dark-theme-trigger')).text,
      )
      .toEqual(placeholderText);
    await themeTrigger.evaluate((element) => {
      element.removeAttribute('data-placeholder');
    });
    await expect
      .poll(
        async () => (await measureContrast(page, 'dark-theme-trigger')).text,
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
    await closeSettings(page);
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

    expect(await hasDarkMode(page)).toBe(true);
    expect(paint.background).toEqual(expectedBackground);
    expect(paint.text).toEqual(expectedForeground);
    expect(
      Math.max(paint.background.r, paint.background.g, paint.background.b),
    ).toBeLessThan(96);
    expect(paint.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(arrowPaint).toEqual({ ...expectedBackground, a: 255 });

    await page.mouse.move(0, 0);
    await openSettingsFromRooms(page);
    await openSection(page, 'appearance');
    await page.getByTestId('mode-light').click();
    await expect.poll(() => hasDarkMode(page)).toBe(false);
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
    await expect
      .poll(async () => Math.abs(await settingsTitleAlignment(page)))
      .toBeLessThanOrEqual(1);

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

    const trigger = page.getByTestId('theme-select').locator('button');
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

    const trigger = page.getByTestId('theme-select').locator('button');
    await trigger.click();
    const panel = page.locator('hlm-select-content').first();
    await expect(panel).toBeVisible();

    expect(
      await panel.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('enter');
  });

  test('selects a Theme from the dropdown', async ({ page }) => {
    await openSection(page, 'appearance');

    // The default Theme sets no data-theme attribute.
    expect(await themeAttr(page)).toBeNull();
    const previewAccent = () =>
      page
        .locator('.preview__avatar')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
    const initialPreviewAccent = await previewAccent();

    const trigger = page.getByTestId('theme-select').locator('button');
    const amethyst = page.getByTestId('theme-amethyst');

    // Closed to start: the options live in the popover overlay, absent until opened.
    // (A missing *hlmSelectPortal renders them inline and the dropdown can never close.)
    await expect(amethyst).toHaveCount(0);

    // Open → the options appear; pick Amethyst → <html data-theme> reflects it AND the
    // overlay closes again. jsdom can't drive this overlay; the unit spec covers the rest.
    await trigger.click();
    await expect(amethyst).toBeVisible();
    await amethyst.click();
    await expect.poll(() => themeAttr(page)).toBe('amethyst');
    await expect(amethyst).toHaveCount(0); // closed after selecting
    // #168: and the closed trigger reads the label, not the stored id `amethyst`.
    await expect(trigger).toHaveText('Amethyst');
    expect(await previewAccent()).not.toBe(initialPreviewAccent);

    // Back to the default Theme → the attribute is removed again.
    await trigger.click();
    await page.getByTestId('theme-trinity').click();
    await expect.poll(() => themeAttr(page)).toBeNull();
    await expect(amethyst).toHaveCount(0);
    await expect(trigger).toHaveText('Graphite');
  });
});

// Density is a rendered conversation mode, so measure a real text row in a real room.
// The coarse-pointer floor is checked on a touch device because `(pointer: coarse)` only
// matches there.
test.describe('Conversation density', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  const DENSITIES = ['cosy', 'compact', 'spacious'] as const;

  async function openConversation(
    page: Page,
    request: Parameters<typeof registerUser>[0],
  ): Promise<void> {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}den`;
    const user = `den-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Density ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const { room_id: roomId } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}`,
      { headers, data: { msgtype: 'm.text', body: `density ${runId}` } },
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await channel.waitFor({ state: 'visible', timeout: 30_000 });
    await channel.click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('.msg .msg__text').first()).toBeVisible({
      timeout: 20_000,
    });
  }

  const setDensity = (page: Page, density: (typeof DENSITIES)[number]) =>
    page.locator('html').evaluate((html, value) => {
      if (value === 'cosy') html.removeAttribute('data-density');
      else html.setAttribute('data-density', value);
    }, density);

  test('spacious rows are taller than cosy, which are taller than compact', async ({
    page,
    request,
  }) => {
    await openConversation(page, request);
    const row = page.locator('.msg', { has: page.locator('.msg__text') });
    const heights: Record<string, number> = {};
    for (const density of DENSITIES) {
      await setDensity(page, density);
      await expect
        .poll(async () => (await row.first().boundingBox())?.height ?? 0)
        .toBeGreaterThan(0);
      heights[density] = (await row.first().boundingBox())?.height ?? 0;
    }
    expect(heights['compact']).toBeLessThan(heights['cosy']);
    expect(heights['cosy']).toBeLessThan(heights['spacious']);
  });

  test('compact room rows are shorter and drop the preview until Spacious', async ({
    page,
    request,
  }) => {
    await openConversation(page, request);
    const row = page.locator('.channel').first();
    const preview = row.locator('.channel__preview');
    const rowHeight = async () => (await row.boundingBox())?.height ?? 0;
    await expect(preview).toBeVisible();
    const richHeight = await rowHeight();

    await openSettingsFromRooms(page);
    await openSection(page, 'appearance');
    await page.getByTestId('room-list-select').locator('button').click();
    await page.getByTestId('room-list-compact').click();

    await expect(page.locator('html')).toHaveAttribute(
      'data-room-list',
      'compact',
    );
    await expect(preview).toBeHidden();
    await expect.poll(rowHeight).toBeLessThan(richHeight);

    await page.getByTestId('density-select').locator('button').click();
    await page.getByTestId('density-spacious').click();
    await expect(preview).toBeVisible();
  });

  test.describe('on a touch device', () => {
    test.use({
      viewport: devices['Pixel 5'].viewport,
      userAgent: devices['Pixel 5'].userAgent,
      deviceScaleFactor: devices['Pixel 5'].deviceScaleFactor,
      isMobile: devices['Pixel 5'].isMobile,
      hasTouch: devices['Pixel 5'].hasTouch,
    });

    test('keeps every composer button at least 44px tall in compact and spacious', async ({
      page,
      request,
    }) => {
      await openConversation(page, request);
      for (const density of ['compact', 'spacious'] as const) {
        await setDensity(page, density);
        const heights = await page
          .locator('trn-message-composer .composer button:visible')
          .evaluateAll((buttons) =>
            buttons.map((b) => b.getBoundingClientRect().height),
          );
        expect(heights.length).toBeGreaterThan(0);
        for (const height of heights) {
          expect(height).toBeGreaterThanOrEqual(44);
        }
      }
    });
  });
});
