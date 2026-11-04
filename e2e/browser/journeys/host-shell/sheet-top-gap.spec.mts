import type { TestInfo } from '@playwright/test';
import { expect, test, type Locator, type Page } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';

// A phone sheet stops below the status bar, so its top holds only the handle and one
// title-and-close row before the first content, as a native iOS sheet does.
const session = homeserverSession();

interface SheetTop {
  readonly sheetTop: number;
  readonly closeTop: number;
  readonly closeBottom: number;
  readonly closeHeight: number;
  readonly contentTop: number;
  /** How far the shell body scrolls on its own, past the panes that should scroll instead. */
  readonly bodyOverflow: number;
  /** The panes' bottom edge, measured from the top of the 34 px home indicator. */
  readonly layoutPastInset: number;
}

/** Settled geometry of a sheet's top, measured from its top edge. */
async function sheetTop(
  dialog: Locator,
  closeName: string,
  content: Locator,
): Promise<SheetTop> {
  const surface = dialog.locator('[data-trn-layout="sheet"]').first();
  await expect(surface).toBeVisible({ timeout: 15_000 });
  await surface.evaluate((element) =>
    Promise.all(element.getAnimations().map((a) => a.finished)),
  );
  await expect(dialog.getByTestId('sheet-handle')).toBeVisible();
  const [sheet, close, first] = await Promise.all(
    [surface, dialog.getByRole('button', { name: closeName }), content].map(
      async (locator) => (await locator.boundingBox())!,
    ),
  );
  const fit = await surface.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('.dialog-shell__body')!;
    const layout = element.querySelector<HTMLElement>('.settings-layout')!;
    const inset = parseFloat(getComputedStyle(element).paddingBottom);
    return {
      bodyOverflow: body.scrollHeight - body.clientHeight,
      layoutPastInset: Math.round(
        layout.getBoundingClientRect().bottom -
          (element.getBoundingClientRect().bottom - inset),
      ),
    };
  });
  return {
    ...fit,
    sheetTop: Math.round(sheet.y),
    closeTop: Math.round(close.y - sheet.y),
    closeBottom: Math.round(close.y + close.height - sheet.y),
    closeHeight: Math.round(close.height),
    contentTop: Math.round(first.y - sheet.y),
  };
}

/** The panes fill the body and end above the home indicator, so nothing scrolls twice. */
function expectFits(top: SheetTop): void {
  expect(top.bodyOverflow).toBeLessThanOrEqual(1);
  expect(top.layoutPastInset).toBeLessThanOrEqual(1);
}

function expectCompactTop(top: SheetTop): void {
  // Below the 47 px status bar, which the sheet then must not pad for again.
  expect(top.sheetTop).toBeGreaterThanOrEqual(47);
  expect(top.closeHeight).toBeGreaterThanOrEqual(44);
  expect(top.closeTop).toBeLessThanOrEqual(24);
  expect(top.contentTop - top.closeBottom).toBeLessThanOrEqual(24);
  expect(top.contentTop).toBeLessThanOrEqual(84);
  expectFits(top);
}

/** At 250% the header grows, but the close stays on screen and the content starts below it. */
function expectLargeTextTop(top: SheetTop): void {
  expect(top.sheetTop).toBeGreaterThanOrEqual(47);
  expect(top.closeHeight).toBeGreaterThanOrEqual(44);
  expect(top.contentTop).toBeGreaterThanOrEqual(top.closeBottom);
  expectFits(top);
}

async function largestText(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '250%';
  });
}

async function dark(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}

async function attach(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function openStatus(page: Page, large = false): Promise<Locator> {
  await page.goto('/login');
  await dark(page);
  if (large) await largestText(page);
  await page
    .getByRole('button', { name: 'System status', exact: true })
    .first()
    .click();
  return page.getByRole('dialog', { name: 'System status' });
}

async function openSettings(page: Page, large = false): Promise<Locator> {
  await login(page, session);
  await dark(page);
  if (large) await largestText(page);
  await page.getByTestId('open-settings').click();
  return page.getByRole('dialog', { name: 'Settings' });
}

/** System status's first row: the login page's warning opens it on its Overview page. */
const statusFirstRow = (dialog: Locator) =>
  dialog
    .locator(
      '.settings-layout__topbar:visible, .settings-layout__nav-item:visible',
    )
    .first();

test.describe('Sheet top', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test.describe('on a 390 px phone with a 47 px status bar', () => {
    test.use({
      ...DESIGN_VIEWPORTS['phone-pixel-5'],
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
    });

    test.beforeEach(async ({ page }) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 47, bottom: 34 },
      });
    });

    for (const large of [false, true]) {
      const at = large ? ' at 250% text' : '';
      const check = large ? expectLargeTextTop : expectCompactTop;

      test(`System status starts its first row under the handle and close row${at}`, async ({
        page,
      }, testInfo) => {
        const dialog = await openStatus(page, large);
        const top = await sheetTop(
          dialog,
          'Close System status',
          statusFirstRow(dialog),
        );
        await attach(
          page,
          testInfo,
          `system-status-390-dark${large ? '-250' : ''}`,
        );
        check(top);
      });

      test(`Settings starts its search under the handle and close row${at}`, async ({
        page,
      }, testInfo) => {
        const dialog = await openSettings(page, large);
        const top = await sheetTop(
          dialog,
          'Close settings',
          dialog.locator('trn-settings-directory-search input').first(),
        );
        await attach(page, testInfo, `settings-390-dark${large ? '-250' : ''}`);
        check(top);
      });
    }
  });

  test.describe('on a 1280 px desktop', () => {
    test.use({
      ...DESIGN_VIEWPORTS['desktop-standard'],
      viewport: { width: 1280, height: 800 },
    });

    // A centred dialog keeps its header inset; only a sheet tightens it.
    for (const [name, open] of [
      ['System status', openStatus],
      ['Settings', openSettings],
    ] as const) {
      test(`${name} keeps its dialog header`, async ({ page }, testInfo) => {
        const dialog = await open(page, false);
        const surface = dialog.getByTestId('dialog-surface');
        await expect(surface).toHaveAttribute('data-trn-layout', 'dialog');
        await expect(surface.locator('.dialog-shell__header')).toHaveCSS(
          'padding-top',
          '16px',
        );
        await surface.evaluate((element) =>
          Promise.all(element.getAnimations().map((a) => a.finished)),
        );
        await attach(
          page,
          testInfo,
          `${name.toLowerCase().replace(' ', '-')}-1280-dark`,
        );
      });
    }
  });
});
