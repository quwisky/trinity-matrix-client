import { test, expect, type Page } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { apiLogin } from '../../../support/account.mts';
import {
  freshAccount,
  setUpEncryption,
} from '../../support/encryption-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

// On a phone the status bar's clock and battery sit over the top of the page
// (`viewport-fit=cover`), so the strip behind them must be the colour of the bar directly
// below (#1868). Chromium reports no safe area, so the journey gives the page an iPhone's inset
// over CDP and compares the pixels in that strip with the pixels just below it, column by
// column: the room list has two columns, and mid-slide the room covers part of the list. The
// browser's theme colour (an installed PWA's status bar) must be the strip's colour too.
//
// Needs a homeserver (Docker or native) and self-skips otherwise.
const session = homeserverSession();
const INSET = 54;
const WIDTH = 390;
const COLUMNS = [8, 40, 120, 195, 270, 382];

type Rgb = readonly [number, number, number];
interface Sample {
  readonly column: number;
  readonly status: Rgb;
  readonly below: Rgb;
}

async function sampleTopEdge(
  page: Page,
  animations: 'disabled' | 'allow' = 'disabled',
): Promise<Sample[]> {
  const png = await page.screenshot({
    animations,
    scale: 'css',
    clip: { x: 0, y: 0, width: WIDTH, height: INSET + 4 },
  });
  return page.evaluate(
    async ({ base64, columns, inset }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('status bar pixels: no canvas context');
      context.drawImage(image, 0, 0);
      const at = (x: number, y: number) => {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return [r, g, b] as const;
      };
      return columns.map((column) => ({
        column,
        status: at(column, Math.floor(inset / 2)),
        below: at(column, inset + 2),
      }));
    },
    { base64: png.toString('base64'), columns: COLUMNS, inset: INSET },
  );
}

// Mid-slide the sliding room's shadow falls on the list a few levels lighter at the top than
// 30px down; a status bar painted from another surface is 8 levels or more off.
const near = (left: Rgb, right: Rgb): boolean =>
  left.every((channel, i) => Math.abs(channel - right[i]) <= 4);

const hex = (rgb: Rgb): string =>
  `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

async function expectStatusBarMatchesTopBar(
  page: Page,
  screen: string,
  animations: 'disabled' | 'allow' = 'disabled',
): Promise<void> {
  await expect(async () => {
    const samples = await sampleTopEdge(page, animations);
    expect(
      samples.filter(({ status, below }) => !near(status, below)),
      `${screen}: the status bar differs from the bar below it`,
    ).toEqual([]);
    if (animations === 'allow') return;
    const centre = samples.find(({ column }) => column === WIDTH / 2)!.status;
    const themeColor = await page
      .locator('meta[name="theme-color"]')
      .first()
      .getAttribute('content');
    expect(
      themeColor && near(centre, hexToRgb(themeColor))
        ? hex(centre)
        : themeColor,
      `${screen}: the theme colour differs from the status bar`,
    ).toBe(hex(centre));
  }).toPass({ timeout: 10_000 });
}

function hexToRgb(value: string): Rgb {
  const [r, g, b] = [1, 3, 5].map((start) =>
    Number.parseInt(value.slice(start, start + 2), 16),
  );
  return [r, g, b];
}

/** Hold the room slide halfway, as it starts. */
async function pauseNextPaneSlide(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('[data-shell-root]');
    if (!root) throw new Error('missing the shell root');
    new MutationObserver((_, observer) => {
      if (!root.hasAttribute('data-pane-slide')) return;
      observer.disconnect();
      for (const animation of document.getAnimations()) {
        const duration = Number(animation.effect?.getTiming().duration ?? 0);
        animation.pause();
        animation.currentTime = duration / 2;
      }
    }).observe(root, {
      attributes: true,
      attributeFilter: ['data-pane-slide'],
    });
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`Status bar colour (${colorScheme})`, () => {
    test.skip(!session.available, 'requires a homeserver (Docker or native)');
    test.use({ viewport: { width: WIDTH, height: 844 }, colorScheme });
    test.describe.configure({ timeout: 150_000 });

    test('matches the bar below with a banner, on the room list, mid-slide, in a room and under a sheet', async ({
      page,
      request,
    }) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: INSET, bottom: 34 },
      });
      const hs = session.hs as string;
      const account = await freshAccount(request, hs, 'status-bar');
      const roomName = `Status ${account.user}`;
      await createRoom(
        request,
        hs,
        await apiLogin(request, hs, account.user, account.pass),
        roomName,
      );
      const room = page.locator('.sidebar__scroll .channel', {
        hasText: roomName,
      });
      const back = page.getByTestId('back-to-rooms');

      // A new account is asked to set up encryption: that banner is the top bar.
      await login(page, account.asSession);
      await page.getByTestId('rail-rooms').click();
      await expect(room).toBeVisible({ timeout: 60_000 });
      await expect(
        page.locator('trn-encryption-banner trn-banner'),
      ).toBeVisible();
      await expectStatusBarMatchesTopBar(page, 'room list with a banner');
      await room.click();
      await expect(back).toBeVisible();
      await expectStatusBarMatchesTopBar(page, 'room with a banner');

      // Encryption set up, the browser test host reports its storage: the root's own banner.
      await setUpEncryption(page, account.pass);
      await page.getByTestId('rail-rooms').click();
      await expect(room).toBeVisible({ timeout: 60_000 });
      await expect(
        page.locator('trn-encryption-banner trn-banner'),
      ).toHaveCount(0);
      const summary = page.getByTestId('app-capability-summary');
      if (await summary.isVisible()) {
        await expectStatusBarMatchesTopBar(
          page,
          'room list with a root banner',
        );
        await summary.getByRole('button', { name: 'Dismiss' }).click();
        await expect(summary).toBeHidden();
      }

      // Without a banner, each column's top bar reaches under the status bar.
      await expectStatusBarMatchesTopBar(page, 'room list');

      await pauseNextPaneSlide(page);
      await room.click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.getAnimations().some((a) => a.playState === 'paused'),
          ),
        )
        .toBe(true);
      await expectStatusBarMatchesTopBar(page, 'room slide', 'allow');
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.finish();
      });

      await expect(back).toBeVisible();
      await expectStatusBarMatchesTopBar(page, 'room');

      await back.click();
      await expect(room).toBeVisible();
      await page.getByTestId('open-settings').click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible({ timeout: 20_000 });
      await expectStatusBarMatchesTopBar(page, 'Settings sheet');
    });
  });
}
