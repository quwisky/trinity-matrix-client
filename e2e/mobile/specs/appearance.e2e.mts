import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import { registerUser, uniqueId } from '../support/matrix.mts';
import { mobilePlatform } from '../support/platform.mts';
import { native, resetApp, webview } from '../support/session.mts';

interface NativeStatusBarInfo {
  readonly height: number;
  readonly overlays: boolean;
  readonly style: 'DARK' | 'LIGHT';
  readonly visible: boolean;
}

/** The Capacitor StatusBar plugin's native state, read through the real bridge. */
async function readNativeStatusBar(): Promise<NativeStatusBarInfo> {
  const result = await browser.execute(async (): Promise<unknown> => {
    const statusBar = (
      window as typeof window & {
        Capacitor?: {
          Plugins?: {
            StatusBar?: { getInfo(): Promise<unknown> };
          };
        };
      }
    ).Capacitor?.Plugins?.StatusBar;
    if (!statusBar) {
      return { error: 'Capacitor StatusBar plugin is unavailable' };
    }
    try {
      return await statusBar.getInfo();
    } catch (e: unknown) {
      return { error: String(e) };
    }
  });
  const info = result as NativeStatusBarInfo & { error?: string };
  if (info.error) throw new Error(info.error);
  return info;
}

/**
 * The status bar style that gives its clock and icons more contrast on what the screen shows
 * under them, read from a native screenshot: the app paints that strip where the WebView reaches
 * under the status bar, and the host's window shows there where it pads the WebView instead.
 */
async function styleForStatusStrip(): Promise<NativeStatusBarInfo['style']> {
  await native();
  const screenshot = await browser.takeScreenshot();
  await webview();
  const strip = await browser.execute(async (base64: string) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('status strip: no canvas context');
    context.drawImage(image, 0, 0);
    // The top rows, clear of the clock, the icons and a camera cutout.
    return [0.15, 0.85].map((x) =>
      Array.from(
        context.getImageData(Math.round(image.width * x), 2, 1, 1).data,
      ),
    );
  }, screenshot);
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l = Math.max(...strip.map(luminance));
  // `DARK` is light content, for a dark strip.
  return 1.05 / (l + 0.05) > (l + 0.05) / 0.05 ? 'DARK' : 'LIGHT';
}

async function choose(select: string, option: string): Promise<void> {
  await $(`[data-testid="${select}"] button`).click();
  const item = $(`[data-testid="${option}"]`);
  await expect(item).toBeDisplayed();
  await item.click();
  await expect(item).not.toExist();
}

describe('mobile Appearance', () => {
  beforeEach(resetApp);

  it('projects Appearance into the installed WebView and native chrome @native-appearance', async () => {
    const user = uniqueId('android-appearance');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await waitForRooms();

    await $('[data-testid="open-settings"]').click();
    // On a phone Settings opens as a bottom sheet over Rooms, so the URL stays put.
    await expect($('[role="dialog"][aria-label="Settings"]')).toBeDisplayed({
      wait: 20_000,
    });
    expect(new URL(await browser.getUrl()).pathname).not.toMatch(
      /^\/settings/u,
    );
    await expect($('nav[aria-label="Settings sections"]')).toBeDisplayed({
      wait: 20_000,
    });
    // The sheet is still sliding in: wait for the row to hold still before tapping it.
    await tap('[data-testid="settings-nav-appearance"]');
    const heading = $('[data-testid="settings-detail"] h1');
    await expect(heading).toHaveText('Appearance');
    await expect(heading).toBeFocused();

    expect(
      await browser.execute(() => ({
        platform: (
          window as typeof window & {
            Capacitor?: { getPlatform(): string };
          }
        ).Capacitor?.getPlatform(),
        coarsePointer: matchMedia('(pointer: coarse)').matches,
      })),
    ).toEqual({ platform: mobilePlatform(), coarsePointer: true });

    await $('[data-testid="mode-light"]').click();
    await choose('theme-select', 'theme-amethyst');
    await expect($('[data-testid="mode-light"] input')).toBeChecked();
    await expect($('html')).not.toHaveElementClass('dark', {
      containing: true,
    });
    await expect($('html')).toHaveAttribute('data-theme', 'amethyst');
    // The status bar's content follows what is under it, not the Mode: here that is the
    // Settings sheet's scrim, or the host's window where the WebView is padded below the bar.
    let lightStrip: NativeStatusBarInfo['style'] | undefined;
    await browser.waitUntil(
      async () =>
        (await readNativeStatusBar()).style ===
        (lightStrip = await styleForStatusStrip()),
      {
        timeout: 10_000,
        timeoutMsg: `native status bar style never matched the strip (${lightStrip})`,
      },
    );
    const lightStatusBar = await readNativeStatusBar();
    expect(lightStatusBar.visible).toBe(true);
    expect(lightStatusBar.height).toBeGreaterThan(0);

    await $('[data-testid="mode-dark"]').click();
    await choose('theme-select', 'theme-midnight');
    await choose('density-select', 'density-compact');
    await choose('text-scale-select', 'text-scale-larger');

    await expect($('[data-testid="mode-dark"] input')).toBeChecked();
    await expect($('html')).toHaveElementClass('dark', { containing: true });
    await expect($('html')).toHaveAttribute('data-theme', 'midnight');
    await expect($('html')).toHaveAttribute('data-density', 'compact');
    expect(await $('html').getCSSProperty('font-size')).toMatchObject({
      value: '20px',
    });
    let darkStrip: NativeStatusBarInfo['style'] | undefined;
    await browser.waitUntil(
      async () =>
        (await readNativeStatusBar()).style ===
        (darkStrip = await styleForStatusStrip()),
      {
        timeout: 10_000,
        timeoutMsg: `native status bar style never matched the strip (${darkStrip})`,
      },
    );
    const darkStatusBar = await readNativeStatusBar();

    const geometry = await browser.execute(() => {
      const column = document.querySelector<HTMLElement>(
        '[data-testid="settings-detail"] .settings-layout__column',
      );
      const heading = column?.querySelector<HTMLElement>('h1');
      const controls = [
        '[data-testid="mode-dark"]',
        '[data-testid="theme-select"] button',
        '[data-testid="density-select"] button',
        '[data-testid="text-scale-select"] button',
      ].map((selector) => document.querySelector<HTMLElement>(selector));
      if (!column || !heading || controls.some((control) => !control)) {
        throw new Error('Appearance geometry is incomplete');
      }
      // The heading scrolls with the column, and the steps above changed controls further
      // down, so measure it from the top of the page.
      for (let el: HTMLElement | null = heading; el; el = el.parentElement) {
        el.scrollTop = 0;
      }
      const sheet = column.closest<HTMLElement>('[role="dialog"]');
      if (!sheet) throw new Error('Appearance is not in a sheet');
      return {
        sheetTop: sheet.getBoundingClientRect().top,
        headingTop: heading.getBoundingClientRect().top,
        hostAppliedVerticalInset: Math.max(
          0,
          window.screen.height - window.innerHeight,
        ),
        minimumTarget: Math.min(
          ...controls.map((control) => control!.getBoundingClientRect().height),
        ),
        horizontalOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(geometry.minimumTarget).toBeGreaterThanOrEqual(44);
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    // The sheet carries no safe-area padding of its own: it must sit below the status bar.
    expect(
      geometry.hostAppliedVerticalInset + geometry.sheetTop,
    ).toBeGreaterThanOrEqual(darkStatusBar.height - 1);
    expect(geometry.headingTop).toBeGreaterThanOrEqual(geometry.sheetTop - 1);

    await $('[data-testid="theme-select"] button').click();
    await expect($('[data-testid="theme-midnight"]')).toBeDisplayed();
  });
});
