import { browser, expect } from '@wdio/globals';
import { login, waitForRooms } from '../support/app.mts';
import { registerUser, uniqueId } from '../support/matrix.mts';
import { resetApp } from '../support/session.mts';

interface NativeStatusBarInfo {
  readonly height: number;
  readonly overlays: boolean;
  readonly style: 'DARK' | 'LIGHT';
  readonly visible: boolean;
}

/** The Capacitor StatusBar plugin's native state, read through the real bridge. */
async function readNativeStatusBar(): Promise<NativeStatusBarInfo> {
  const result = await browser.executeAsync(
    (done: (value: unknown) => void) => {
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
        done({ error: 'Capacitor StatusBar plugin is unavailable' });
        return;
      }
      statusBar
        .getInfo()
        .then(done, (e: unknown) => done({ error: String(e) }));
    },
  );
  const info = result as NativeStatusBarInfo & { error?: string };
  if (info.error) throw new Error(info.error);
  return info;
}

async function choose(select: string, option: string): Promise<void> {
  await $(`[data-testid="${select}"] button`).click();
  const item = $(`[data-testid="${option}"]`);
  await expect(item).toBeDisplayed();
  await item.click();
  await expect(item).not.toExist();
}

describe('Android Appearance', () => {
  beforeEach(resetApp);

  it('projects Appearance into the installed WebView and native chrome @native-appearance', async () => {
    const user = uniqueId('android-appearance');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await waitForRooms();

    await $('[data-testid="open-settings"]').click();
    await browser.waitUntil(
      async () =>
        new URL(await browser.getUrl()).pathname.startsWith('/settings'),
      { timeout: 20_000, timeoutMsg: 'never reached /settings' },
    );
    await expect($('nav[aria-label="Settings sections"]')).toBeDisplayed({
      wait: 20_000,
    });
    await $('[data-testid="settings-nav-appearance"]').click();
    await browser.waitUntil(
      async () =>
        /\/settings\/appearance$/u.test(
          new URL(await browser.getUrl()).pathname,
        ),
      { timeout: 20_000, timeoutMsg: 'never reached /settings/appearance' },
    );
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
    ).toEqual({ platform: 'android', coarsePointer: true });

    await $('[data-testid="mode-light"]').click();
    await choose('theme-select', 'theme-amethyst');
    await expect($('[data-testid="mode-light"] input')).toBeChecked();
    await expect($('html')).not.toHaveElementClass('dark', {
      containing: true,
    });
    await expect($('html')).toHaveAttribute('data-theme', 'amethyst');
    await expect(
      $('[data-testid="appearance-preview-state"]'),
    ).toHaveElementProperty(
      'textContent',
      expect.stringContaining('light · Amethyst · Cosy'),
    );
    await browser.waitUntil(
      async () => (await readNativeStatusBar()).style === 'LIGHT',
      { timeout: 10_000, timeoutMsg: 'native status bar style never LIGHT' },
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
    await expect(
      $('[data-testid="appearance-preview-state"]'),
    ).toHaveElementProperty(
      'textContent',
      expect.stringContaining('dark · Midnight · Compact'),
    );
    await browser.waitUntil(
      async () => (await readNativeStatusBar()).style === 'DARK',
      { timeout: 10_000, timeoutMsg: 'native status bar style never DARK' },
    );
    const darkStatusBar = await readNativeStatusBar();

    const geometry = await browser.execute(() => {
      const header = document.querySelector<HTMLElement>(
        'header[data-trn-layout="page"]',
      );
      const heading = header?.querySelector<HTMLElement>('h1');
      const controls = [
        '[data-testid="mode-dark"]',
        '[data-testid="theme-select"] button',
        '[data-testid="density-select"] button',
        '[data-testid="text-scale-select"] button',
      ].map((selector) => document.querySelector<HTMLElement>(selector));
      if (!header || !heading || controls.some((control) => !control)) {
        throw new Error('Android Appearance geometry is incomplete');
      }
      const headerStyle = getComputedStyle(header);
      return {
        headerPaddingTop: Number.parseFloat(headerStyle.paddingTop),
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
    expect(
      geometry.hostAppliedVerticalInset + geometry.headerPaddingTop,
    ).toBeGreaterThanOrEqual(darkStatusBar.height - 1);
    expect(geometry.headingTop).toBeGreaterThanOrEqual(
      geometry.headerPaddingTop - 1,
    );

    await $('[data-testid="theme-select"] button').click();
    await expect($('[data-testid="theme-midnight"]')).toBeDisplayed();
  });
});
