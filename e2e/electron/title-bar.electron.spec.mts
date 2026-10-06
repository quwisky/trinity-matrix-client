import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ElectronApplication } from 'playwright';
import { expect, test, type Page } from './fixtures.mts';
import { createElectronProfile, launchApp } from './support/launch.mts';

// The frameless title row is a Windows/Linux and macOS shell feature; the CI lanes run linux.
test.skip(process.platform !== 'linux', 'asserts the linux title row');

const HEX = /^#[0-9a-f]{6}$/;

interface OverlayCall {
  color: string;
  symbolColor: string;
  height: number;
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test.describe('frameless title row', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('title-bar-title')).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('hides the native menu bar and shows the title row before sign-in', async () => {
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      ),
    ).toBe(false);
    await expect(page.getByTestId('title-bar-title')).toHaveText('Trinity');
    const region = await page
      .locator('.title-bar--visible')
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue('-webkit-app-region'),
      );
    expect(region).toBe('drag');
  });

  test('starts full-screen layers below the row so their close buttons stay clickable', async () => {
    // The CDK overlay container hosts every dialog, the lightbox and the widget frame.
    const overlayTop = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'cdk-overlay-container';
      probe.append(document.createElement('span'));
      document.body.append(probe);
      const { top, bottom } = probe.getBoundingClientRect();
      probe.remove();
      return { top, bottom, viewport: innerHeight };
    });
    expect(overlayTop.top).toBe(32);
    expect(overlayTop.bottom).toBe(overlayTop.viewport);

    // System status is its own viewport-fixed layer and opens before sign-in. At the
    // minimum window height its card fills the viewport, so its header reaches the top.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 600),
    );
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(600);
    await page.getByTestId('system-status-access').click();
    const dialog = page.getByRole('dialog', { name: 'System status' });
    const close = page.getByTestId('system-status-close');
    await expect(close).toBeVisible();
    expect((await dialog.boundingBox())?.y).toBeGreaterThanOrEqual(32);
    expect((await close.boundingBox())?.y).toBeGreaterThanOrEqual(32);
    const reachable = await close.evaluate((el) => {
      const { left, top, width, height } = el.getBoundingClientRect();
      const hit = document.elementFromPoint(left + width / 2, top + height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(reachable).toBe(true);
    await close.click();
    await expect(close).toHaveCount(0);
  });

  test('pops the application menu from the ☰ button', async () => {
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu) throw new Error('no application menu');
      const calls: unknown[] = [];
      (globalThis as Record<string, unknown>)['__menuPopups'] = calls;
      menu.popup = ((options: unknown) => {
        calls.push(options);
      }) as typeof menu.popup;
    });
    await page.getByTestId('title-bar-menu').click();
    const calls = await app.evaluate(
      () => (globalThis as Record<string, unknown>)['__menuPopups'],
    );
    expect(calls).toHaveLength(1);
    expect(calls).toEqual([
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    ]);
  });

  test('sends #rrggbb overlay colours derived from the theme and re-sends on change', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const calls: unknown[] = [];
      (globalThis as Record<string, unknown>)['__overlays'] = calls;
      const original = win.setTitleBarOverlay.bind(win);
      win.setTitleBarOverlay = (options: unknown) => {
        calls.push(options);
        original(options);
      };
    });
    const overlays = (): Promise<OverlayCall[]> =>
      app.evaluate(
        () => (globalThis as Record<string, unknown>)['__overlays'] as never,
      );
    // The same carriers the Appearance adapter writes: `.dark` and `data-theme`.
    const setAppearance = (dark: boolean, theme: string | null) =>
      page.evaluate(
        ([isDark, name]) => {
          const root = document.documentElement;
          root.classList.toggle('dark', isDark);
          if (name) root.setAttribute('data-theme', name);
          else root.removeAttribute('data-theme');
        },
        [dark, theme] as const,
      );
    const lastAfter = async (count: number): Promise<OverlayCall> => {
      await expect
        .poll(async () => (await overlays()).length)
        .toBeGreaterThan(count);
      return (await overlays()).at(-1) as OverlayCall;
    };

    await setAppearance(false, 'amethyst');
    const light = await lastAfter(0);
    const afterLight = (await overlays()).length;
    await setAppearance(true, 'amethyst');
    const dark = await lastAfter(afterLight);
    const afterDark = (await overlays()).length;
    await setAppearance(true, 'midnight');
    const midnight = await lastAfter(afterDark);

    for (const call of [light, dark, midnight]) {
      expect(call.color).toMatch(HEX);
      expect(call.symbolColor).toMatch(HEX);
      expect(call.height).toBe(32);
    }
    // Surface and symbol follow the mode: a dark surface carries a light symbol.
    expect(luminance(light.color)).toBeGreaterThan(luminance(dark.color));
    expect(luminance(light.symbolColor)).toBeLessThan(
      luminance(dark.symbolColor),
    );
    expect(luminance(dark.color)).toBeLessThan(luminance(dark.symbolColor));
    // A different theme re-sends a different surface, not just a different symbol.
    expect(midnight.color).not.toBe(dark.color);
  });
});

test('draws no title row and keeps the OS menu bar with the system title bar saved', async () => {
  const profile = createElectronProfile();
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, 'window-prefs.json'),
    JSON.stringify({ systemTitleBar: true }),
  );
  const app = await launchApp(profile);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByLabel('Homeserver')).toBeVisible();
    await expect(page.locator('.title-bar--visible')).toHaveCount(0);
    await expect(page.getByTestId('title-bar-title')).toHaveCount(0);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
