import { expect, test, type Page } from '@playwright/test';
import {
  DESIGN_REFERENCE_VIEWPORTS,
  type DesignViewportName,
} from '../playwright/support/design-viewports.mts';
import {
  AA_NORMAL_TEXT,
  measureContrast,
} from '../playwright/support/contrast.mts';

const THEMES = ['light', 'dark', 'onyx'] as const;
const SCREENS = ['workspace', 'settings'] as const;
const referenceViewports = new Set<string>(DESIGN_REFERENCE_VIEWPORTS);

type PrototypeScreen = (typeof SCREENS)[number];
type PrototypeScene = 'busy' | 'empty' | 'error';
type PrototypeTheme = (typeof THEMES)[number];

const CONTRAST_TARGETS = {
  workspace: ['workspace-title', 'primary-action'],
  settings: ['settings-title', 'settings-palette'],
} as const satisfies Record<PrototypeScreen, readonly string[]>;

async function openPrototype(
  page: Page,
  screen: PrototypeScreen,
  theme: PrototypeTheme = 'dark',
  scene: PrototypeScene = 'busy',
): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(
    `/__design__/index.html?screen=${screen}&theme=${theme}&scene=${scene}`,
  );
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(
    await page.evaluate(() =>
      document.fonts.check('16px "Trinity Prototype Sans"'),
    ),
    'bundled prototype font loaded',
  ).toBe(true);
  await expect(page.locator(`[data-prototype="${screen}"]`)).toBeVisible();
}

test.describe('modern UI prototype structure', () => {
  for (const screen of SCREENS) {
    test(`${screen} keeps one visible workspace and no horizontal document overflow`, async ({
      page,
    }) => {
      await openPrototype(page, screen);

      await expect(page.locator('[data-prototype]:visible')).toHaveCount(1);
      await expect(page.locator('main:visible')).toHaveCount(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(1);

      if (screen === 'workspace') {
        const composer = await page.locator('.composer').boundingBox();
        const viewport = page.viewportSize();
        expect(composer, 'composer has a layout box').not.toBeNull();
        expect(viewport, 'project has a viewport').not.toBeNull();
        expect(
          composer!.y,
          'composer starts inside viewport',
        ).toBeGreaterThanOrEqual(0);
        expect(
          composer!.y + composer!.height,
          'composer ends inside viewport',
        ).toBeLessThanOrEqual(viewport!.height + 1);
      }
    });
  }

  test('workspace exposes landmarks, selected navigation and named actions', async ({
    page,
  }, testInfo) => {
    await openPrototype(page, 'workspace');

    if (testInfo.project.name.startsWith('phone-')) {
      await expect(
        page.getByRole('button', { name: 'Back to rooms' }),
      ).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Space list' }),
      ).toBeHidden();
      await expect(page.getByTestId('workspace-title')).toBeVisible();
    } else {
      await expect(
        page.getByRole('navigation', { name: 'Space list' }),
      ).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Room list' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Product design' }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(
        page.getByRole('link', {
          name: /design-systems-and-accessibility-review/,
        }),
      ).toHaveAttribute('aria-current', 'page');
    }

    const visibleButtons = page.locator('button:visible');
    const buttonCount = await visibleButtons.count();
    for (let index = 0; index < buttonCount; index += 1) {
      await expect(visibleButtons.nth(index)).toHaveAccessibleName(/\S/);
    }
  });

  test('empty and error states carry explicit status semantics', async ({
    page,
  }) => {
    await openPrototype(page, 'workspace', 'dark', 'empty');
    await expect(
      page.getByRole('heading', { name: 'Start this conversation' }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toBeHidden();

    await openPrototype(page, 'workspace', 'dark', 'error');
    await expect(page.getByRole('alert')).toContainText(
      'Messages could not be loaded',
    );
    await expect(
      page.getByRole('heading', { name: 'Timeline unavailable' }),
    ).toBeVisible();
  });

  test('settings has one selected section and labelled controls', async ({
    page,
  }, testInfo) => {
    await openPrototype(page, 'settings');

    if (testInfo.project.name.startsWith('phone-')) {
      await expect(
        page.getByRole('button', { name: 'Back to settings sections' }),
      ).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Settings sections' }),
      ).toBeHidden();
    } else {
      await expect(
        page.getByRole('navigation', { name: 'Settings sections' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: /Appearance/ }),
      ).toHaveAttribute('aria-current', 'page');
    }
    await expect(page.getByRole('combobox', { name: 'Palette' })).toBeVisible();
    await expect(
      page.getByRole('switch', { name: /Show message previews/ }),
    ).toHaveAttribute('aria-checked', 'true');

    for (const theme of THEMES) {
      await openPrototype(page, 'settings', theme);
      await expect(
        page.getByRole('button', {
          name: theme === 'light' ? 'Light' : 'Dark',
        }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page.getByRole('button', { name: 'System' }),
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('combobox', { name: 'Palette' })).toHaveValue(
        theme === 'onyx' ? 'Onyx' : 'Trinity',
      );
    }
  });

  test('phone profiles preserve 44px interactive targets on both screens', async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith('phone-'),
      'phone profiles only',
    );
    for (const screen of SCREENS) {
      await openPrototype(page, screen);

      const controls = page.locator(
        'button:visible, a:visible, input:visible, select:visible, textarea:visible',
      );
      const count = await controls.count();
      for (let index = 0; index < count; index += 1) {
        const box = await controls.nth(index).boundingBox();
        expect(box, `${screen} control ${index} has a box`).not.toBeNull();
        expect(
          box!.width,
          `${screen} control ${index} width`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          box!.height,
          `${screen} control ${index} height`,
        ).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('representative copy and controls meet normal-text contrast in every reference', async ({
    page,
  }) => {
    for (const screen of SCREENS) {
      for (const theme of THEMES) {
        await openPrototype(page, screen, theme);
        for (const target of CONTRAST_TARGETS[screen]) {
          const measured = await measureContrast(page, target);
          expect(
            measured.ratio,
            `${screen} ${theme} ${target} contrast`,
          ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        }
      }
    }
  });
});

for (const screen of SCREENS) {
  for (const theme of THEMES) {
    test(`${screen} ${theme} reference`, async ({ page }, testInfo) => {
      test.skip(
        !referenceViewports.has(testInfo.project.name),
        'reference viewport only',
      );
      await openPrototype(page, screen, theme);

      const rootTheme = await page.locator('html').evaluate((root) => ({
        dark: root.classList.contains('dark'),
        palette: root.getAttribute('data-theme'),
      }));
      expect(rootTheme).toEqual({
        dark: theme !== 'light',
        palette: theme === 'onyx' ? 'onyx' : null,
      });

      await expect(page).toHaveScreenshot(`${screen}-${theme}.png`, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
      });
    });
  }
}

for (const scene of ['empty', 'error'] as const) {
  test(`workspace ${scene} state reference`, async ({ page }, testInfo) => {
    test.skip(
      !referenceViewports.has(testInfo.project.name),
      'reference viewport only',
    );
    await openPrototype(page, 'workspace', 'dark', scene);
    await expect(page).toHaveScreenshot(`workspace-${scene}-dark.png`, {
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
    });
  });
}

test('viewport project is registered in the canonical matrix', async ({}, testInfo) => {
  const viewportName = testInfo.project.name as DesignViewportName;
  expect(viewportName).toMatch(/^(desktop|phone)-/);
});
