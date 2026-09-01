import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  STORYBOOK_THEME_PREVIEWS,
  expectStorybookThemeRoot,
  storybookThemeGlobals,
} from './theme-preview.mts';

const STORY = '/iframe.html?id=components-icon-motion';

const innerIcon = (button: Locator): Locator => button.locator('ng-icon');

const transformOf = async (icon: Locator): Promise<string> =>
  icon.evaluate((element) => getComputedStyle(element).transform);

const transitionDurationOf = async (icon: Locator): Promise<string> =>
  icon.evaluate((element) => getComputedStyle(element).transitionDuration);

const colorOfToken = async (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);

const matrixOf = async (icon: Locator) =>
  icon.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return {
      a: matrix.a,
      b: matrix.b,
      c: matrix.c,
      d: matrix.d,
      e: matrix.e,
      f: matrix.f,
    };
  });

const layoutOf = async (locator: Locator) =>
  locator.evaluate((element) => {
    const html = element as HTMLElement;
    return {
      height: html.offsetHeight,
      left: html.offsetLeft,
      top: html.offsetTop,
      width: html.offsetWidth,
    };
  });

async function openStory(page: Page, story: string): Promise<void> {
  await page.goto(`${STORY}--${story}&viewMode=story`);
  await expect(page.getByTestId('motion-button')).toBeVisible();
  await expect(page.getByTestId('motion-button').locator('svg')).toBeVisible();
}

test.describe('icon motion', () => {
  test('hover and press transform only the glyph without moving layout', async ({
    page,
  }) => {
    await openStory(page, 'nudge-up-right');
    const button = page.getByRole('button', { name: 'Send' });
    const icon = innerIcon(button);
    const neighbour = page.getByTestId('motion-neighbour');
    const buttonLayout = await layoutOf(button);
    const buttonRect = await button.boundingBox();
    const neighbourLayout = await layoutOf(neighbour);
    const targetTranslation = await icon.evaluate(
      (element) =>
        Number.parseFloat(getComputedStyle(element).fontSize) * 0.125,
    );
    const expectedPressed = await colorOfToken(
      page,
      '--trinity-state-pressed-surface',
    );

    await button.hover();
    await expect
      .poll(async () => Math.round((await matrixOf(icon)).e * 1_000))
      .toBe(Math.round(targetTranslation * 1_000));

    await page.mouse.down();
    await expect(button).toHaveCSS('background-color', expectedPressed);
    await expect.poll(() => transitionDurationOf(icon)).toBe('0.09s');
    await expect
      .poll(async () => Math.round((await matrixOf(icon)).a * 100))
      .toBe(90);

    expect(await layoutOf(button)).toEqual(buttonLayout);
    expect(await button.boundingBox()).toEqual(buttonRect);
    expect(await layoutOf(neighbour)).toEqual(neighbourLayout);
    await page.mouse.up();
  });

  test('public icon buttons share pointer and hover treatment', async ({
    page,
  }) => {
    await openStory(page, 'pop');
    const button = page.getByRole('button', { name: 'Search' });
    const rest = await button.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      cursor: getComputedStyle(element).cursor,
    }));

    expect(rest.cursor).toBe('pointer');
    await button.hover();
    await expect
      .poll(() =>
        button.evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(rest.background);
  });

  test('keyboard focus-visible triggers the same semantic gesture', async ({
    page,
  }) => {
    await openStory(page, 'nudge-left');
    const button = page.getByRole('button', { name: 'Back' });
    const icon = innerIcon(button);
    const rest = await transformOf(icon);

    await page.keyboard.press('Tab');

    await expect(button).toBeFocused();
    await expect.poll(() => transformOf(icon)).not.toBe(rest);
  });

  test('icon links receive the same focus gesture and button treatment', async ({
    page,
  }) => {
    await page.goto(`${STORY}--treatments&viewMode=story`);
    const link = page.getByRole('link', { name: 'Linked action' });
    const icon = innerIcon(link);
    const rest = await transformOf(icon);

    expect(
      await link.evaluate((element) => getComputedStyle(element).cursor),
    ).toBe('pointer');
    await link.focus();
    await expect.poll(() => transformOf(icon)).not.toBe(rest);
  });

  test('sizes and contextual tones retain one interaction contract', async ({
    page,
  }) => {
    await page.goto(`${STORY}--treatments&viewMode=story`);
    const enabledNames = [
      'Small action',
      'Destructive action',
      'Floating action',
    ];
    const enabled = enabledNames.map((name) =>
      page.getByRole('button', { name }),
    );
    const restBackgrounds = await Promise.all(
      enabled.map((button) =>
        button.evaluate((element) => getComputedStyle(element).backgroundColor),
      ),
    );
    const radii = await Promise.all(
      enabled.map((button) =>
        button.evaluate((element) => getComputedStyle(element).borderRadius),
      ),
    );
    const expectedHover = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--trinity-state-hover-surface)';
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });

    expect(new Set(radii).size).toBe(1);
    expect(new Set(restBackgrounds).size).toBeGreaterThan(1);
    for (const button of enabled) {
      expect(
        await button.evaluate((element) => getComputedStyle(element).cursor),
      ).toBe('pointer');
      await button.hover();
      await expect(button).toHaveCSS('background-color', expectedHover);
    }

    const disabled = page.getByRole('button', { name: 'Unavailable action' });
    expect(
      await disabled.evaluate((element) => getComputedStyle(element).cursor),
    ).toBe('default');

    const purposeBuilt = page.getByRole('button', {
      name: 'Purpose-built action',
    });
    expect(
      await purposeBuilt.evaluate(
        (element) => getComputedStyle(element).borderRadius,
      ),
    ).not.toBe(radii[0]);
    expect(
      await purposeBuilt.evaluate(
        (element) => getComputedStyle(element).cursor,
      ),
    ).toBe('pointer');
    await purposeBuilt.hover();
    await expect(purposeBuilt).toHaveCSS('background-color', expectedHover);
  });

  test('disabled controls remain still under the pointer', async ({ page }) => {
    await openStory(page, 'disabled');
    const button = page.getByRole('button', { name: 'Send unavailable' });
    const icon = innerIcon(button);
    const rest = await transformOf(icon);
    const expectedPressed = await colorOfToken(
      page,
      '--trinity-state-pressed-surface',
    );

    await button.hover();
    await page.mouse.down();

    expect(await transformOf(icon)).toBe(rest);
    expect(
      await button.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).not.toBe(expectedPressed);
    await page.mouse.up();
  });

  test('each gesture preserves its semantic direction and magnitude', async ({
    page,
  }) => {
    await page.goto(`${STORY}--all-variants&viewMode=story`);
    const expected = {
      Back: { angle: 0, scale: 1, x: -0.125, y: 0 },
      'Move up': { angle: 0, scale: 1, x: 0, y: -0.125 },
      'Move down': { angle: 0, scale: 1, x: 0, y: 0.125 },
      Send: { angle: 0, scale: 1, x: 0.125, y: -0.125 },
      Search: { angle: 0, scale: 1.1, x: 0, y: 0 },
      Settings: { angle: 30, scale: 1, x: 0, y: 0 },
    };

    for (const [name, target] of Object.entries(expected)) {
      const button = page.getByRole('button', { name });
      const icon = innerIcon(button);
      await button.hover();
      await expect
        .poll(() =>
          icon.evaluate((element) => {
            const style = getComputedStyle(element);
            const matrix = new DOMMatrix(style.transform);
            const em = Number.parseFloat(style.fontSize);
            const rounded = (value: number) =>
              Math.round(value * 1_000) / 1_000;
            return {
              angle: rounded((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI),
              scale: rounded(Math.hypot(matrix.a, matrix.b)),
              x: rounded(matrix.e / em),
              y: rounded(matrix.f / em),
            };
          }),
        )
        .toEqual(target);
    }
  });

  test('reduced motion keeps the glyph static across focus and press', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStory(page, 'rotate');
    const button = page.getByRole('button', { name: 'Settings' });
    const icon = innerIcon(button);
    const buttonRect = await button.boundingBox();

    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    expect(await transformOf(icon)).toBe('none');

    await button.hover();
    await page.mouse.down();
    expect(await transformOf(icon)).toBe('none');
    expect(await button.boundingBox()).toEqual(buttonRect);
    expect(
      await button.evaluate((element) => getComputedStyle(element).translate),
    ).toBe('none');
    expect(
      Number.parseFloat(await transitionDurationOf(icon)),
    ).toBeLessThanOrEqual(0.00001);
    await page.mouse.up();
  });

  for (const preview of STORYBOOK_THEME_PREVIEWS) {
    const { theme, mode } = preview;
    test(`${theme.id} ${mode.id} renders every supported variant`, async ({
      page,
    }) => {
      await page.goto(
        `${STORY}--all-variants&viewMode=story&globals=${storybookThemeGlobals(preview)}`,
      );

      await expectStorybookThemeRoot(page, preview);

      await expect(page.getByRole('button')).toHaveCount(6);
      for (const name of [
        'Back',
        'Move up',
        'Move down',
        'Send',
        'Search',
        'Settings',
      ]) {
        const button = page.getByRole('button', { name });
        const icon = innerIcon(button);
        await expect(button).toBeVisible();
        await expect(icon.locator('svg')).toBeVisible();
        const rest = await transformOf(icon);

        await button.hover();

        await expect.poll(() => transformOf(icon)).not.toBe(rest);
      }
    });
  }
});
