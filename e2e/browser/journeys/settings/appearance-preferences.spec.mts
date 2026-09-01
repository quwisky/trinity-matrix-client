import { expect, test } from '../../../fixtures.mts';
import { isAndroidE2E } from '../../../support/app.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  hasDarkPalette,
  configureSettingsSuite,
  openSection,
  paletteAttr,
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
    await page.getByTestId('theme-dark').click();
    await expect.poll(() => hasDarkPalette(page)).toBe(true);

    // ThemeService is still the startup owner until #387. Its earlier media listener must
    // not overwrite the successfully committed descriptor when the OS changes underneath a
    // fixed Mode during this migration slice.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => hasDarkPalette(page)).toBe(true);

    const paletteTrigger = page.getByRole('combobox', { name: 'Theme' });
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

    expect(await hasDarkPalette(page)).toBe(true);
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
    if (isAndroidE2E) {
      const routedTitleInsideDetail = await page.evaluate(() => {
        const detail = document.querySelector<HTMLElement>(
          '[data-testid=settings-detail]',
        );
        const title = document.querySelector<HTMLElement>(
          '#appearance-heading',
        );
        if (!detail || !title) throw new Error('routed settings title missing');
        const pane = detail.getBoundingClientRect();
        const heading = title.getBoundingClientRect();
        return heading.left >= pane.left - 1 && heading.right <= pane.right + 1;
      });
      expect(routedTitleInsideDetail).toBe(true);
    } else {
      await expect
        .poll(async () => Math.abs(await settingsTitleAlignment(page)))
        .toBeLessThanOrEqual(1);
    }
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
});
