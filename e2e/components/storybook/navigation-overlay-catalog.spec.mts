import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  measureLocatorContrast,
} from '../../browser/support/contrast.mts';
import { formatAxeResults, runAxe } from './catalog-accessibility.mts';
import { renderedColour } from './recipe-appearance.mts';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  STORYBOOK_THEME_PREVIEWS,
  expectStorybookThemeRoot,
  storybookThemeGlobals,
} from './theme-preview.mts';

const NAVIGATION_CATALOG =
  '/iframe.html?id=components-navigation-and-layout-recipe-matrix--complete-catalog&viewMode=story';
const OVERLAY_CATALOG =
  '/iframe.html?id=components-overlay-recipes--complete-catalog&viewMode=story';
const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

async function expectAxeClean(
  page: Page,
  excludedSelectors: readonly string[] = [],
): Promise<void> {
  const scan = await runAxe(page, excludedSelectors);
  expect(formatAxeResults(scan.violations)).toEqual([]);
  expect(formatAxeResults(scan.incomplete)).toEqual([]);
}

async function expectReadable(locator: Locator): Promise<void> {
  expect((await measureLocatorContrast(locator)).ratio).toBeGreaterThanOrEqual(
    AA_NORMAL_TEXT,
  );
}

async function expectModalAxeClean(page: Page): Promise<void> {
  // CDK intentionally hides the background root and uses aria-hidden focus
  // sentinels to trap focus. Scan the live portal content around those nodes.
  await expectAxeClean(page, ['#storybook-root', '.cdk-focus-trap-anchor']);
}

for (const preview of STORYBOOK_THEME_PREVIEWS) {
  test(`${preview.theme.id} ${preview.mode.id} Navigation and Layout catalog is complete and accessible`, async ({
    page,
  }) => {
    await page.goto(
      `${NAVIGATION_CATALOG}&globals=${storybookThemeGlobals(preview)}`,
    );
    await expect(
      page.getByTestId('complete-navigation-layout-catalog'),
    ).toBeVisible();
    await expectStorybookThemeRoot(page, preview);
    await expectAxeClean(page);

    for (const variant of ['neutral', 'accent'] as const) {
      for (const presentation of ['pill', 'line'] as const) {
        const tabs = page.getByTestId(
          `catalog-tabs-${variant}-${presentation}`,
        );
        await expect(tabs.locator('hlm-tabs-list')).toHaveAttribute(
          'data-trn-variant',
          variant,
        );
        await expect(tabs.locator('hlm-tabs-list')).toHaveAttribute(
          'data-trn-presentation',
          presentation,
        );
        const selected = tabs.getByRole('tab', { name: 'Overview' });
        const inactive = tabs.getByRole('tab', { name: 'Members' });
        await expect(selected).toHaveAttribute('aria-selected', 'true');
        await expect(inactive).toBeEnabled();
        expect(await renderedColour(inactive, 'color')).toEqual(
          await renderedColour(inactive, '--trinity-text-muted'),
        );
        await expectReadable(selected);
        await expectReadable(inactive);
      }
    }

    const manual = page.getByTestId('catalog-tabs-manual-vertical');
    await expect(manual).toHaveAttribute('data-orientation', 'vertical');
    const manualTabs = manual.getByRole('tab');
    await expect(manualTabs.nth(2)).toBeDisabled();
    await manualTabs.nth(0).focus();
    await manualTabs.nth(0).press('ArrowDown');
    await expect(manualTabs.nth(1)).toBeFocused();
    await expect(manualTabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await manualTabs.nth(1).press('Enter');
    await expect(manualTabs.nth(1)).toHaveAttribute('aria-selected', 'true');

    for (const variant of ['neutral', 'muted'] as const) {
      for (const size of ['sm', 'md'] as const) {
        const card = page.getByTestId(`catalog-card-${variant}-${size}`);
        await expect(card).toHaveAttribute('data-variant', variant);
        await expect(card).toHaveAttribute('data-size', size);
      }
    }
    for (const variant of ['neutral', 'accent'] as const) {
      for (const layout of ['page', 'toolbar'] as const) {
        const header = page
          .getByTestId(`catalog-header-${variant}-${layout}`)
          .locator('header');
        await expect(header).toHaveAttribute('data-trn-variant', variant);
        await expect(header).toHaveAttribute('data-trn-layout', layout);
      }
      await expect(
        page.getByTestId(`catalog-separator-${variant}-horizontal-decorative`),
      ).toHaveAttribute('role', 'none');
      const verticalSeparator = page.getByTestId(
        `catalog-separator-${variant}-vertical-announced`,
      );
      await expect(verticalSeparator).toHaveAttribute('role', 'separator');
      await expect(verticalSeparator).toHaveAttribute(
        'data-orientation',
        'vertical',
      );
      await expect(verticalSeparator).toBeVisible();
      const separatorBox = await verticalSeparator.boundingBox();
      expect(separatorBox?.width ?? 0).toBeGreaterThan(0);
      expect(separatorBox?.height ?? 0).toBeGreaterThan(0);
    }

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  });

  test(`${preview.theme.id} ${preview.mode.id} Overlay surfaces and portal stay accessible`, async ({
    page,
  }) => {
    await page.goto(
      `${OVERLAY_CATALOG}&globals=${storybookThemeGlobals(preview)}`,
    );
    await expect(page.getByTestId('complete-overlay-catalog')).toBeVisible();
    await expectStorybookThemeRoot(page, preview);
    await expectAxeClean(page);

    for (const variant of ['neutral', 'accent'] as const) {
      const surface = page.getByTestId(`catalog-overlay-variant-${variant}`);
      await expect(surface).toHaveAttribute('data-trn-variant', variant);
      await expectReadable(surface);
    }
    for (const size of ['sm', 'md', 'lg', 'xl', '2xl'] as const) {
      await expect(
        page.getByTestId(`catalog-overlay-size-${size}`),
      ).toHaveAttribute('data-trn-size', size);
    }
    for (const layout of [
      'dialog',
      'sheet',
      'popover',
      'panel',
      'workspace',
      'fullscreen',
    ] as const) {
      await expect(
        page.getByTestId(`catalog-overlay-layout-${layout}`),
      ).toHaveAttribute('data-trn-layout', layout);
    }
    await expect
      .poll(() =>
        page
          .getByTestId('catalog-overlay-layout-dialog')
          .evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .not.toBe('none');

    const portal = page.getByTestId('portal-overlay-surface');
    await expect(portal).toBeVisible();
    expect(
      await portal.evaluate(
        (element) =>
          element.closest('.cdk-overlay-container')?.parentElement ===
          document.body,
      ),
    ).toBe(true);
  });

  test(`${preview.theme.id} ${preview.mode.id} Overlay interaction states stay accessible`, async ({
    page,
  }) => {
    const catalogUrl = `${OVERLAY_CATALOG}&globals=${storybookThemeGlobals(preview)}`;
    await page.goto(catalogUrl);

    const dropdownTrigger = page.getByTestId('dropdown-trigger');
    await dropdownTrigger.focus();
    await dropdownTrigger.press('Enter');
    await expect(page.getByTestId('dropdown-neutral')).toBeFocused();
    await expect(page.getByTestId('dropdown-danger')).toHaveAttribute(
      'data-trn-variant',
      'danger',
    );
    await expectReadable(page.getByTestId('dropdown-danger'));
    await expect(page.getByTestId('dropdown-disabled')).toBeDisabled();
    await expect(
      page.getByTestId('dropdown-selected-checkbox'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('dropdown-locked-checkbox')).toBeDisabled();
    const controlledMenu = page.getByRole('menu', { name: 'Overlay actions' });
    expect(await dropdownTrigger.getAttribute('aria-controls')).toBe(
      await controlledMenu.getAttribute('id'),
    );
    // axe cannot resolve aria-controls across an aria-haspopup popup, so the
    // relationship is verified above and only that trigger is omitted here.
    await expectAxeClean(page, ['[data-testid="dropdown-trigger"]']);
    await page.keyboard.press('Escape');
    await expect(dropdownTrigger).toBeFocused();

    const dialogTrigger = page.getByTestId('dialog-canonical-center');
    await dialogTrigger.click();
    await expect(page.locator('.cdk-overlay-dark-backdrop')).toBeVisible();
    await expect(page.getByTestId('story-dialog-close')).toBeFocused();
    await expectModalAxeClean(page);
    await page.keyboard.press('Escape');
    await expect(dialogTrigger).toBeFocused();

    await page.getByTestId('alert-prompt').click();
    const prompt = page.getByRole('textbox', { name: 'Room name' });
    await expect(prompt).toHaveValue('');
    await expect(prompt).toHaveAttribute('maxlength', '64');
    await page.getByTestId('alert-confirm').click();
    await expect(prompt).toHaveAttribute('aria-invalid', 'true');
    const promptError = page.getByTestId('alert-prompt-error');
    await expect(promptError).toHaveText('Room name is required.');
    await expectReadable(promptError);
    await expectModalAxeClean(page);
    await prompt.fill('Trinity');
    await expect(prompt).not.toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('alert-prompt')).toBeFocused();

    await page.getByTestId('alert-canonical').click();
    await expect(page.getByTestId('alert-confirm')).toHaveAttribute(
      'data-trn-variant',
      'danger',
    );
    await expectReadable(page.getByTestId('alert-confirm'));
    await page.keyboard.press('Escape');

    await page.getByTestId('sheet-canonical').click();
    await expect(page.getByTestId('sheet-danger')).toHaveAttribute(
      'data-trn-variant',
      'danger',
    );
    await expect(page.getByTestId('sheet-disabled')).toBeDisabled();
    await expect(page.getByTestId('sheet-react-👍')).toBeVisible();
    await expectModalAxeClean(page);
    await page.getByRole('button', { name: 'Cancel' }).click();

    for (const [variant, message] of [
      ['neutral', 'Canonical neutral'],
      ['success', 'Canonical success'],
      ['warning', 'Canonical warning'],
      ['danger', 'Canonical danger'],
    ] as const) {
      await page.goto(catalogUrl);
      await page.getByTestId(`toast-${variant}`).click();
      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: message });
      await expect(toast).toHaveAttribute('data-visible', 'true');
      await expect(toast).toHaveCSS('opacity', '1');
      await expect(toast.locator('..')).toHaveAttribute('role', 'status');
      await expect(toast.locator('..')).toHaveAttribute('aria-live', 'polite');
      await expectReadable(toast.locator('[data-title]'));
      await expectAxeClean(page);
    }

    await page.goto(catalogUrl);
    await page.getByTestId('toast-action').click();
    const actionToast = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Canonical action' });
    const undo = page.getByRole('button', { name: 'Undo' });
    await expect(actionToast).toHaveAttribute('data-visible', 'true');
    await expect(actionToast).toHaveCSS('opacity', '1');
    await expect(actionToast.locator('..')).toHaveAttribute('role', 'status');
    await expectReadable(actionToast.locator('[data-title]'));
    await expectReadable(undo);
    await expectAxeClean(page);
  });
}

test('anchored overlays cover every side and alignment without clipping', async ({
  page,
}) => {
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    for (const align of ['start', 'center', 'end'] as const) {
      await page.goto(
        `${story('components-anchored-overlay--position-catalog')}&args=side:${side};align:${align}`,
      );
      const anchor = page.getByRole('button', { name: 'Position anchor' });
      const surface = page.getByTestId('anchored-surface');
      await expect(surface).toBeVisible();
      const [anchorBox, surfaceBox, viewport] = await Promise.all([
        anchor.boundingBox(),
        surface.boundingBox(),
        Promise.resolve(page.viewportSize()),
      ]);
      expect(anchorBox).not.toBeNull();
      expect(surfaceBox).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(surfaceBox!.x).toBeGreaterThanOrEqual(0);
      expect(surfaceBox!.y).toBeGreaterThanOrEqual(0);
      expect(surfaceBox!.x + surfaceBox!.width).toBeLessThanOrEqual(
        viewport!.width,
      );
      expect(surfaceBox!.y + surfaceBox!.height).toBeLessThanOrEqual(
        viewport!.height,
      );
    }
  }
});

test('the clipped control demonstrates the failure while the portal escapes it', async ({
  page,
}) => {
  await page.goto(story('components-anchored-overlay--clipped'));
  const clippedContainer = page.locator('.h-40.w-96.overflow-hidden');
  const clippedSurface = page.getByTestId('anchored-surface');
  const [containerBox, surfaceBox] = await Promise.all([
    clippedContainer.boundingBox(),
    clippedSurface.boundingBox(),
  ]);
  expect(containerBox).not.toBeNull();
  expect(surfaceBox).not.toBeNull();
  expect(surfaceBox!.y).toBeLessThan(containerBox!.y);

  await page.goto(story('components-anchored-overlay--position-catalog'));
  const portal = page.getByTestId('anchored-surface');
  await expect(portal).toBeVisible();
  expect(
    await portal.evaluate((element) =>
      Boolean(element.closest('.cdk-overlay-container')),
    ),
  ).toBe(true);
});

test('anchored overlays honor both outside-press policies and model results', async ({
  page,
}) => {
  await page.goto(
    story('components-anchored-overlay--outside-press-policy-catalog'),
  );
  await expect(page.getByTestId('dismissible-model-state')).toHaveText('open');
  await expect(page.getByTestId('persistent-model-state')).toHaveText('open');
  await expect(page.getByTestId('anchored-surface')).toHaveCount(2);

  await page.getByTestId('outside-press-target').click();

  await expect(page.getByTestId('dismissible-model-state')).toHaveText(
    'closed',
  );
  await expect(page.getByTestId('persistent-model-state')).toHaveText('open');
  await expect(page.getByTestId('anchored-surface')).toHaveCount(1);
});

test('every dialog placement renders its matching surface layout', async ({
  page,
}) => {
  await page.goto(
    `${OVERLAY_CATALOG}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW)}`,
  );
  for (const [triggerId, layout] of [
    ['dialog-canonical-center', 'dialog'],
    ['dialog-canonical-end', 'panel'],
    ['dialog-canonical-bottom', 'sheet'],
    ['dialog-canonical-fullscreen', 'fullscreen'],
    ['dialog-canonical-workspace', 'workspace'],
    ['dialog-canonical-anchor', 'popover'],
  ] as const) {
    const trigger = page.getByTestId(triggerId);
    await trigger.click();
    const surface = page.getByTestId('story-dialog-surface');
    await expect(surface).toHaveAttribute('data-trn-layout', layout);
    await page.getByTestId('story-dialog-close').click();
    await expect(trigger).toBeFocused();
  }
});
