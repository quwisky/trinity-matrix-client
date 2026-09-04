import type { Locator, Page, TestInfo } from '@playwright/test';
import type { AndroidDevice } from 'playwright';
import { login, synapseSession } from '../support/app.mts';
import { openSettingsFromRooms } from '../support/journeys/navigation.mts';
import { expect, test } from './fixtures.mts';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const session = synapseSession();

interface NativeStatusBarInfo {
  readonly height: number;
  readonly overlays: boolean;
  readonly style: 'DARK' | 'LIGHT';
  readonly visible: boolean;
}

async function readNativeStatusBar(page: Page): Promise<NativeStatusBarInfo> {
  return page.evaluate(async () => {
    const statusBar = (
      window as typeof window & {
        Capacitor?: {
          Plugins?: {
            StatusBar?: { getInfo(): Promise<NativeStatusBarInfo> };
          };
        };
      }
    ).Capacitor?.Plugins?.StatusBar;
    if (!statusBar) throw new Error('Capacitor StatusBar plugin is unavailable');
    return statusBar.getInfo();
  });
}

async function choose(
  page: Page,
  touch: (control: Locator) => Promise<void>,
  select: string,
  option: string,
): Promise<void> {
  await touch(page.getByTestId(select).locator('button').first());
  const item = page.getByTestId(option);
  await expect(item).toBeVisible();
  await touch(item);
  await expect(item).toHaveCount(0);
}

async function attachProof(
  page: Page,
  device: AndroidDevice,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const webviewPath = testInfo.outputPath(`${name}-webview.png`);
  const devicePath = testInfo.outputPath(`${name}-device.png`);
  await Promise.all([
    page.screenshot({ path: webviewPath, animations: 'disabled' }),
    device.screenshot({ path: devicePath }),
  ]);
  await Promise.all([
    testInfo.attach(`${name}-webview.png`, {
      path: webviewPath,
      contentType: 'image/png',
    }),
    testInfo.attach(`${name}-device.png`, {
      path: devicePath,
      contentType: 'image/png',
    }),
  ]);
}

test.describe('Android Appearance', () => {
  test.skip(!session.available, 'requires the disposable Synapse homeserver');
  test.use({ viewport: null, hasTouch: true, isMobile: true });

  test('projects Appearance into the installed WebView and native chrome @native-appearance', async ({
    app,
    page,
  }, testInfo) => {
    const touch = (control: Locator) => app.touch(control);
    await login(page, session, app.navigate);
    await openSettingsFromRooms(page, touch);
    await app.touch(page.getByTestId('settings-nav-appearance'));
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    await expect(
      page.getByRole('heading', { name: 'Appearance' }),
    ).toBeFocused();

    expect(
      await page.evaluate(() => ({
        platform: (
          window as typeof window & {
            Capacitor?: { getPlatform(): string };
          }
        ).Capacitor?.getPlatform(),
        coarsePointer: matchMedia('(pointer: coarse)').matches,
      })),
    ).toEqual({ platform: 'android', coarsePointer: true });

    await page.getByTestId('mode-light').click();
    await choose(
      page,
      touch,
      'theme-select',
      'theme-amethyst',
    );
    await expect(
      page.getByTestId('mode-light').locator('input'),
    ).toBeChecked();
    await expect(page.locator('html')).not.toHaveClass(/dark/u);
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      'amethyst',
    );
    await expect(page.getByTestId('appearance-preview-state')).toContainText(
      'light · Amethyst · Cosy',
    );
    await expect.poll(async () => (await readNativeStatusBar(page)).style).toBe(
      'LIGHT',
    );
    const lightStatusBar = await readNativeStatusBar(page);
    expect(lightStatusBar.visible).toBe(true);
    expect(lightStatusBar.height).toBeGreaterThan(0);
    await attachProof(page, app.device, testInfo, 'appearance-light');

    await page.getByTestId('mode-dark').click();
    await choose(
      page,
      touch,
      'theme-select',
      'theme-onyx',
    );
    await choose(
      page,
      touch,
      'density-select',
      'density-compact',
    );
    await choose(
      page,
      touch,
      'text-scale-select',
      'text-scale-larger',
    );

    await expect(page.getByTestId('mode-dark').locator('input')).toBeChecked();
    await expect(page.locator('html')).toHaveClass(/dark/u);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'onyx');
    await expect(page.locator('html')).toHaveAttribute(
      'data-density',
      'compact',
    );
    await expect(page.locator('html')).toHaveCSS('font-size', '20px');
    await expect(page.getByTestId('appearance-preview-state')).toContainText(
      'dark · Onyx · Compact',
    );
    await expect.poll(async () => (await readNativeStatusBar(page)).style).toBe(
      'DARK',
    );
    const darkStatusBar = await readNativeStatusBar(page);

    const geometry = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(
        'header[data-trn-layout="page"]',
      );
      const heading = header?.querySelector<HTMLElement>('h1');
      const controls = [
        document.querySelector<HTMLElement>('[data-testid="mode-dark"]'),
        document.querySelector<HTMLElement>(
          '[data-testid="theme-select"] button',
        ),
        document.querySelector<HTMLElement>(
          '[data-testid="density-select"] button',
        ),
        document.querySelector<HTMLElement>(
          '[data-testid="text-scale-select"] button',
        ),
      ];
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
          ...controls.map(
            (control) => control!.getBoundingClientRect().height,
          ),
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
    ).toBeGreaterThanOrEqual(
      darkStatusBar.height - 1,
    );
    expect(geometry.headingTop).toBeGreaterThanOrEqual(
      geometry.headerPaddingTop - 1,
    );

    await app.touch(page.getByTestId('theme-select').locator('button').first());
    await expect(page.getByTestId('theme-onyx')).toBeVisible();
    await attachProof(page, app.device, testInfo, 'appearance-dark-compact');
    await testInfo.attach('appearance-runtime.json', {
      body: Buffer.from(
        `${JSON.stringify({ lightStatusBar, darkStatusBar, geometry }, null, 2)}\n`,
      ),
      contentType: 'application/json',
    });
  });
});
