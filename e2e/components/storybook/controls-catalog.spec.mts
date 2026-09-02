import { expect, test, type Locator } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  measureContrast,
  resolveTokenSrgb,
} from '../../browser/support/contrast.mts';
import {
  DISABLED_READABILITY,
  disabledContrast,
  disabledPairContrast,
  expectContrast,
  formatAxeResults,
  runAxe,
} from './catalog-accessibility.mts';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  STORYBOOK_THEME_PREVIEWS,
  expectStorybookThemeRoot,
  storybookThemeGlobals,
} from './theme-preview.mts';
import { renderedColour } from './recipe-appearance.mts';

const CATALOG_STORY =
  '/iframe.html?id=components-control-recipe-matrix--complete-catalog&viewMode=story';

async function expectFocusRing(control: Locator): Promise<void> {
  await control.focus();
  await expect(control).toBeFocused();
  await expect
    .poll(() =>
      control.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe('none');
}

for (const preview of STORYBOOK_THEME_PREVIEWS) {
  test(`${preview.theme.id} ${preview.mode.id} Controls catalog is complete and accessible`, async ({
    page,
  }) => {
    await page.goto(
      `${CATALOG_STORY}&globals=${storybookThemeGlobals(preview)}`,
    );
    const catalog = page.getByTestId('complete-controls-catalog');
    await expect(catalog).toBeVisible();
    await expectStorybookThemeRoot(page, preview);
    await expect(page.getByRole('alert')).toHaveText(
      /No camera was found on this device/u,
    );

    // Axe cannot resolve tokenized contrast on the aria-hidden checkbox glyphs, and its
    // caption rule cannot infer that the muted QR camera preview contains no audio. Both
    // are checked explicitly below; the rest of the story remains inside the Axe scan.
    const scan = await runAxe(page, [
      'trn-checkbox > span[aria-hidden="true"]',
      'trn-qr-scanner video',
    ]);
    expect(formatAxeResults(scan.violations)).toEqual([]);
    expect(formatAxeResults(scan.incomplete)).toEqual([]);

    for (const testId of [
      'catalog-button-primary-solid',
      'catalog-button-secondary-solid',
      'catalog-button-danger-solid',
      'catalog-button-primary-outline',
      'catalog-button-secondary-ghost',
      'catalog-button-danger-link',
    ]) {
      expect(
        (await measureContrast(page, testId)).ratio,
        testId,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }

    const canvas = page.locator('body');
    for (const testId of [
      'catalog-checkbox-neutral-sm',
      'catalog-checkbox-neutral-md',
    ]) {
      await expectContrast(
        page.getByTestId(testId).locator(':scope > span'),
        'borderColor',
        canvas,
        'backgroundColor',
        3,
      );
    }
    for (const testId of [
      'catalog-checkbox-accent-sm',
      'catalog-checkbox-accent-md',
      'catalog-checkbox-indeterminate',
    ]) {
      await expectContrast(
        page.getByTestId(testId).locator(':scope > span'),
        'backgroundColor',
        canvas,
        'backgroundColor',
        3,
      );
    }
    await expectContrast(
      page.getByTestId('catalog-checkbox-rest').locator(':scope > span'),
      'borderColor',
      canvas,
      'backgroundColor',
      3,
    );
    await expectContrast(
      page.getByTestId('catalog-switch-accent-md').locator(':scope > span'),
      'backgroundColor',
      canvas,
      'backgroundColor',
      3,
    );
    const radioIndicator = page
      .getByTestId('catalog-radio-list-neutral-sm')
      .locator('label')
      .first()
      .locator('span[aria-hidden="true"]');
    for (const [control, property] of [
      [radioIndicator, 'borderColor'],
      [page.getByTestId('catalog-input-md'), 'borderColor'],
      [page.getByTestId('catalog-textarea-md'), 'borderColor'],
      [
        page.getByTestId('catalog-select-md').getByRole('combobox'),
        'borderColor',
      ],
      [
        page.getByTestId('catalog-switch-rest').locator(':scope > span'),
        'backgroundColor',
      ],
      [page.getByTestId('catalog-toggle-neutral-outline-md'), 'borderColor'],
      [
        page
          .getByTestId('catalog-radio-segmented-neutral-sm')
          .getByRole('radiogroup'),
        'borderColor',
      ],
    ] as const) {
      await expectContrast(control, property, canvas, 'backgroundColor', 3);
    }

    const focusButton = page.getByTestId('catalog-button-primary-outline');
    const focusInput = page.getByTestId('catalog-input-md');
    const focusToggle = page.getByTestId('catalog-toggle-rest');
    for (const control of [focusButton, focusInput, focusToggle]) {
      await expectFocusRing(control);
      await expectContrast(
        control,
        '--trinity-focus-ring',
        canvas,
        'backgroundColor',
        3,
      );
    }

    for (const testId of [
      'catalog-button-loading',
      'catalog-button-disabled',
      'catalog-toggle-disabled',
      'catalog-input-disabled',
    ]) {
      expect(
        await disabledContrast(page, testId, canvas),
        testId,
      ).toBeGreaterThanOrEqual(DISABLED_READABILITY);
    }
    const disabledCheckbox = page
      .getByTestId('catalog-checkbox-disabled')
      .locator(':scope > span');
    expect(
      await disabledContrast(page, disabledCheckbox, canvas),
      'disabled checkbox',
    ).toBeGreaterThanOrEqual(DISABLED_READABILITY);
    const disabledSwitchTrack = page
      .getByTestId('catalog-switch-disabled')
      .locator(':scope > span');
    expect(
      await disabledPairContrast(
        disabledSwitchTrack.locator(':scope > span'),
        'backgroundColor',
        disabledSwitchTrack,
        'backgroundColor',
        disabledSwitchTrack,
        canvas,
      ),
      'disabled switch',
    ).toBeGreaterThanOrEqual(DISABLED_READABILITY);
    const disabledRadioOption = page
      .getByTestId('catalog-radio-disabled')
      .locator('label')
      .first();
    expect(
      await disabledPairContrast(
        disabledRadioOption.locator('span[aria-hidden="true"] > span'),
        'backgroundColor',
        canvas,
        'backgroundColor',
        disabledRadioOption,
        canvas,
      ),
      'disabled radio',
    ).toBeGreaterThanOrEqual(DISABLED_READABILITY);
    expect(
      await disabledContrast(
        page,
        page.getByTestId('catalog-select-disabled').getByRole('combobox'),
        canvas,
      ),
      'disabled select',
    ).toBeGreaterThanOrEqual(DISABLED_READABILITY);
    expect(
      await disabledContrast(page, 'catalog-textarea-disabled', canvas),
      'disabled textarea',
    ).toBeGreaterThanOrEqual(DISABLED_READABILITY);

    await expect(page.getByTestId('catalog-button-loading')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByTestId('catalog-button-loading')).toBeDisabled();
    await expect(page.getByTestId('catalog-button-disabled')).toBeDisabled();
    await expect(page.getByTestId('catalog-button-readonly')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(
      page.getByTestId('catalog-button-readonly'),
    ).toHaveAccessibleName(
      'Archive this room with a deliberately long translated label',
    );

    await expect(
      page.getByTestId('catalog-checkbox-indeterminate').getByRole('checkbox'),
    ).toHaveAttribute('aria-checked', 'mixed');
    await expect(
      page.getByTestId('catalog-checkbox-invalid').getByRole('checkbox'),
    ).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByTestId('catalog-checkbox-disabled').getByRole('checkbox'),
    ).toBeDisabled();
    await expect(
      page.getByTestId('catalog-switch-disabled').getByRole('switch'),
    ).toBeDisabled();
    await expect(
      page.getByTestId('catalog-radio-disabled').getByRole('radio').first(),
    ).toBeDisabled();

    const toggle = page.getByTestId('catalog-toggle-rest');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const readOnlyToggle = page.getByTestId('catalog-toggle-readonly');
    await expect(readOnlyToggle).toHaveAttribute('aria-disabled', 'true');
    await readOnlyToggle.click({ force: true });
    await expect(readOnlyToggle).toHaveAttribute('aria-pressed', 'true');

    const toolbar = page.getByTestId('catalog-toggle-group-separated');
    const toolbarButtons = toolbar.getByRole('button');
    expect(
      await toolbarButtons.evaluateAll(
        (items) =>
          items.filter((item) => (item as HTMLButtonElement).tabIndex === 0)
            .length,
      ),
    ).toBe(1);
    await toolbarButtons.first().focus();
    await toolbarButtons.first().press('ArrowRight');
    await expect(toolbarButtons.nth(2)).toBeFocused();

    const select = page.getByTestId('catalog-select-md').getByRole('combobox');
    await select.click();
    await expect(
      page.getByRole('option', { name: /Comfortable with/u }),
    ).toBeVisible();
    await select.press('Escape');
    await expect(select).toBeFocused();
    await expect(
      page.getByTestId('catalog-select-disabled').getByRole('combobox'),
    ).toBeDisabled();

    await expect(page.getByTestId('catalog-input-readonly')).toHaveAttribute(
      'readonly',
      '',
    );
    await expect(page.getByTestId('catalog-input-disabled')).toBeDisabled();
    await expect(page.getByTestId('catalog-textarea-invalid')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByTestId('catalog-textarea-disabled')).toBeDisabled();

    await expect(page.getByTestId('catalog-emoji-md')).toHaveAttribute(
      'data-size',
      'md',
    );
    const cameraPreview = page
      .getByTestId('catalog-qr-scanner')
      .locator('video');
    await expect(cameraPreview).toHaveAttribute('muted', '');
    await expect(cameraPreview).toHaveAccessibleName(
      'Camera preview for scanning a QR code',
    );

    const hoverButton = page.getByTestId('catalog-button-secondary-ghost');
    await hoverButton.hover();
    const hoverSurface = await resolveTokenSrgb(
      page,
      'catalog-button-secondary-ghost',
      '--secondary',
    );
    await expect
      .poll(
        async () =>
          (await measureContrast(page, 'catalog-button-secondary-ghost'))
            .background,
      )
      .toEqual(hoverSurface);
    await page.mouse.down();
    await expect
      .poll(() =>
        hoverButton.evaluate((element) => getComputedStyle(element).translate),
      )
      .not.toBe('none');
    await page.mouse.up();

    const pressedToggle = page.getByTestId('catalog-toggle-neutral-plain-sm');
    await pressedToggle.hover();
    await expect
      .poll(() => renderedColour(pressedToggle, 'backgroundColor'))
      .toEqual(
        await renderedColour(pressedToggle, '--trinity-state-hover-surface'),
      );
    await page.mouse.down();
    await expect
      .poll(() => renderedColour(pressedToggle, 'backgroundColor'))
      .toEqual(
        await renderedColour(pressedToggle, '--trinity-state-pressed-surface'),
      );
    await page.mouse.up();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  });
}

for (const [state, storyId, message] of [
  ['starting', 'qr-scanner-starting', 'Opening the camera…'],
  ['scanning', 'qr-scanner-scanning', 'Point the camera at the QR code.'],
] as const) {
  for (const preview of STORYBOOK_THEME_PREVIEWS) {
    test(`QR scanner ${state} state remains accessible in ${preview.theme.id} ${preview.mode.id}`, async ({
      page,
    }) => {
      await page.goto(
        `/iframe.html?id=components-control-recipe-matrix--${storyId}&viewMode=story&globals=${storybookThemeGlobals(preview)}`,
      );
      await expectStorybookThemeRoot(page, preview);
      await expect(page.getByRole('status')).toHaveText(message);
      const previewVideo = page
        .getByTestId('catalog-qr-state')
        .locator('video');
      await expect(previewVideo).toHaveAttribute('muted', '');
      await expect(previewVideo).toHaveAccessibleName(
        'Camera preview for scanning a QR code',
      );
      const scan = await runAxe(page, ['trn-qr-scanner video']);
      expect(formatAxeResults(scan.violations)).toEqual([]);
      expect(formatAxeResults(scan.incomplete)).toEqual([]);
    });
  }
}

test('Controls catalog retains compact density', async ({ page }) => {
  await page.goto(
    `${CATALOG_STORY}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW, 'compact')}`,
  );
  await expect(page.getByTestId('complete-controls-catalog')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  const medium = await page.getByTestId('catalog-input-md').boundingBox();
  const large = await page.getByTestId('catalog-input-lg').boundingBox();
  expect(medium).not.toBeNull();
  expect(large).not.toBeNull();
  expect(medium!.height).toBeLessThan(large!.height);
});

for (const [size, storyId] of [
  ['sm', 'emoji-picker-small'],
  ['md', 'emoji-picker-medium'],
  ['lg', 'emoji-picker-large'],
] as const) {
  for (const preview of STORYBOOK_THEME_PREVIEWS) {
    test(`${size} emoji picker keeps its ordinal recipe in ${preview.theme.id} ${preview.mode.id}`, async ({
      page,
    }) => {
      await page.goto(
        `/iframe.html?id=components-control-recipe-matrix--${storyId}&viewMode=story&globals=${storybookThemeGlobals(preview)}`,
      );
      await expect(page.getByTestId('catalog-emoji-size')).toHaveAttribute(
        'data-size',
        size,
      );
      await expectStorybookThemeRoot(page, preview);
      const scan = await runAxe(page);
      expect(formatAxeResults(scan.violations)).toEqual([]);
      expect(formatAxeResults(scan.incomplete)).toEqual([]);
    });
  }
}
