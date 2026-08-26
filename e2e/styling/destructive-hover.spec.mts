import {
  devices,
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

const { defaultBrowserType: _defaultBrowserType, ...PIXEL_5 } =
  devices['Pixel 5'];

interface Probe {
  readonly target: Locator;
  readonly tintReference: Locator;
}

interface ProbeStyle {
  readonly background: string;
  readonly outline: string;
}

const styleOf = (locator: Locator): Promise<ProbeStyle> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      outline: style.outlineColor,
    };
  });

/** Add the smallest possible consumer of the generated destructive hover utility. */
async function installProbe(page: Page): Promise<Probe> {
  await page.goto('/login');
  await page.locator('body').waitFor();

  await page.evaluate(() => {
    const witness = document.createElement('style');
    witness.textContent = `
      #destructive-hover-probe {
        outline: 2px solid rgb(4 5 6);
      }
      #destructive-hover-probe:hover {
        outline-color: rgb(1 2 3);
      }
    `;
    document.head.append(witness);

    const target = document.createElement('div');
    target.id = 'destructive-hover-probe';
    target.className = 'hover:bg-destructive/20';
    target.tabIndex = 0;
    target.textContent = 'Destructive hover probe';
    Object.assign(target.style, {
      position: 'fixed',
      inset: '16px auto auto 16px',
      width: '180px',
      height: '48px',
      zIndex: '9999',
    });

    const tintReference = document.createElement('div');
    tintReference.id = 'destructive-tint-reference';
    tintReference.style.backgroundColor = 'var(--trinity-danger-tint-20)';

    document.body.append(target, tintReference);
  });

  return {
    target: page.locator('#destructive-hover-probe'),
    tintReference: page.locator('#destructive-tint-reference'),
  };
}

test.describe('destructive hover on a touch device', () => {
  // A real mobile descriptor is what makes Chromium report hover:none and pointer:coarse.
  test.use(PIXEL_5);

  test('does not paint a sticky hover tint after a tap', async ({ page }) => {
    expect(
      await page.evaluate(() => ({
        noHover: matchMedia('(hover: none)').matches,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
      })),
    ).toEqual({ noHover: true, coarsePointer: true });

    const { target } = await installProbe(page);
    const before = await styleOf(target);
    await target.tap();

    // Mobile Chromium retains the computed :hover style after a tap, even though
    // `element.matches(':hover')` reports false. This independent witness proves the sticky
    // state really activated before the destructive background is asserted absent.
    await expect
      .poll(() => styleOf(target))
      .toMatchObject({
        outline: 'rgb(1, 2, 3)',
        background: before.background,
      });
  });
});

test.describe('destructive hover on a hover-capable device', () => {
  test('still resolves to the opaque tint token', async ({ page }) => {
    expect(
      await page.evaluate(() => matchMedia('(hover: hover)').matches),
    ).toBe(true);

    const { target, tintReference } = await installProbe(page);
    await target.hover();

    // Compare two computed backgrounds in the same browser. The token itself is authored as
    // color-mix(), whose raw custom-property string is not comparable with a resolved colour.
    await expect
      .poll(async () => (await styleOf(target)).background)
      .toBe((await styleOf(tintReference)).background);
  });
});
