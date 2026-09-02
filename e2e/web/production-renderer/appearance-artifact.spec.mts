import { expect, test, type TestInfo } from '@playwright/test';
import { THEME_CATALOG } from '@trinity/theme-foundation';
import { seedPreference } from '../../support/app.mts';

const APPEARANCE_PROJECTS = new Set([
  'appearance-desktop',
  'appearance-mobile',
]);

async function attachScreenshot(
  page: import('@playwright/test').Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test('renders every shipped Theme and fixed Mode on the production artifact', async ({
  page,
}, testInfo) => {
  test.skip(
    !APPEARANCE_PROJECTS.has(testInfo.project.name),
    'runs once on the representative desktop and mobile projects',
  );

  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in to Trinity' }),
  ).toBeVisible({ timeout: 30_000 });
  const appIcon = page.locator('img.login-card__mark');
  await expect(appIcon).toHaveAttribute('src', 'assets/icon/icon-plated.svg');
  await expect
    .poll(() =>
      appIcon.evaluate(
        (element) =>
          (element as HTMLImageElement).complete &&
          (element as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);

  const appearanceTriplets = new Set<string>();
  for (const combination of THEME_CATALOG.preview.combinations) {
    const theme = THEME_CATALOG.themes.find(
      ({ id }) => id === combination.theme,
    );
    if (!theme) throw new Error(`Unknown Theme: ${combination.theme}`);

    await seedPreference(page, 'trinity.appearance.theme', combination.theme);
    await seedPreference(page, 'trinity.appearance.mode', combination.mode);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: 'Sign in to Trinity' }),
    ).toBeVisible({ timeout: 30_000 });

    const root = page.locator('html');
    if (combination.mode === 'dark') {
      await expect(root).toHaveClass(/\bdark\b/);
    } else {
      await expect(root).not.toHaveClass(/\bdark\b/);
    }
    if (theme.dataTheme) {
      await expect(root).toHaveAttribute('data-theme', theme.dataTheme);
    } else {
      await expect(root).not.toHaveAttribute('data-theme');
    }

    const evidence = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const card = document.querySelector<HTMLElement>('.login-card');
      if (!card) throw new Error('production login card is missing');
      const box = card.getBoundingClientRect();
      return {
        appearanceTokens: [
          rootStyle.getPropertyValue('--trinity-surface-workspace').trim(),
          rootStyle.getPropertyValue('--trinity-accent').trim(),
          rootStyle.getPropertyValue('--trinity-text').trim(),
        ],
        card: {
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          top: box.top,
        },
        horizontalOverflow:
          document.documentElement.scrollWidth - window.innerWidth,
        viewport: { height: innerHeight, width: innerWidth },
      };
    });
    expect(evidence.appearanceTokens.every((value) => value !== '')).toBe(true);
    appearanceTriplets.add(evidence.appearanceTokens.join('|'));
    expect(evidence.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(evidence.card.left).toBeGreaterThanOrEqual(-1);
    expect(evidence.card.top).toBeGreaterThanOrEqual(-1);
    expect(evidence.card.right).toBeLessThanOrEqual(
      evidence.viewport.width + 1,
    );
    expect(evidence.card.bottom).toBeLessThanOrEqual(
      evidence.viewport.height + 1,
    );

    await attachScreenshot(
      page,
      testInfo,
      `application-${testInfo.project.name}-${combination.theme}-${combination.mode}.png`,
    );
  }

  expect(appearanceTriplets.size).toBe(
    THEME_CATALOG.preview.combinations.length,
  );
});
