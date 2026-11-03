import { expect, test, type Page } from '../../../fixtures.mts';
import { login } from '../../../support/app.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import { session } from '../../support/settings-journey.mts';

// On a phone, a Settings section is a page pushed over the directory: it slides in as a room
// does over its list, has a history entry of its own, and goes back with Back, browser Back,
// or (in the sheet) a swipe from the leading edge. Needs the disposable Synapse homeserver.

const PHONE = { width: 390, height: 844 };
/** The section's URL; the part scrolled to joins it as a fragment. */
const APPEARANCE = /\/settings\/appearance(#[\w-]+)?$/;

/** The current entry's place in this tab's history (Chromium's Navigation API). */
const historyIndex = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as unknown as { navigation: { currentEntry: { index: number } } })
        .navigation.currentEntry.index,
  );

/**
 * Record each section slide as it starts: its direction, the section page's animation then,
 * and that animation's duration.
 */
async function watchSlides(
  page: Page,
): Promise<() => Promise<[string, string, number][]>> {
  await page.evaluate(() => {
    const seen: [string, string, number][] = [];
    Object.assign(window, { settingsSlides: seen });
    new MutationObserver((records) => {
      for (const record of records) {
        const workspace = record.target as HTMLElement;
        const slide = workspace.getAttribute('data-pane-slide');
        if (!slide) continue;
        const run = workspace
          .querySelector('[data-testid="settings-detail"]')
          ?.getAnimations()
          .find((animation) => animation instanceof CSSAnimation) as
          CSSAnimation | undefined;
        seen.push([
          slide,
          run?.animationName ?? '',
          run ? Number(run.effect!.getComputedTiming().duration) : -1,
        ]);
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-pane-slide'],
    });
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { settingsSlides: [string, string, number][] })
          .settingsSlides,
    );
}

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const backToSections = (page: Page) =>
  page.getByRole('button', { name: 'Back to sections' });

async function openPhoneSheet(page: Page): Promise<void> {
  await login(page, session);
  await openSettingsFromRooms(page);
  await expect(page.getByTestId('settings-nav-appearance')).toBeVisible({
    timeout: 20_000,
  });
  // Settle the sheet's own entrance first.
  await page
    .getByTestId('dialog-surface')
    .first()
    .evaluate((surface) =>
      Promise.all(surface.getAnimations().map((a) => a.finished)),
    );
}

/**
 * A REAL touch drag through the browser's input pipeline (see `drawer-swipe.spec.mts`), so
 * the browser decides whether the page gets the moves or a scroll eats them.
 */
async function swipe(
  page: Page,
  from: { x: number; y: number },
  toX: number,
  options: { release?: boolean } = {},
): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  const STEPS = 10;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let step = 1; step <= STEPS; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: Math.round(from.x + ((toX - from.x) * step) / STEPS),
          y: from.y,
          id: 1,
        },
      ],
    });
    // Slow enough that only the distance can commit, never the speed.
    await page.waitForTimeout(30);
  }
  const release = async () => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await cdp.detach();
  };
  if (options.release !== false) await release();
  return release;
}

test.describe('Settings sections on a phone', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );
  test.use({ viewport: PHONE });

  test('the sheet gives a section a history entry that Back and browser Back pop', async ({
    page,
  }) => {
    await openPhoneSheet(page);
    const roomUrl = page.url();
    const base = await historyIndex(page);

    await page.getByTestId('settings-nav-appearance').click();
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    expect(await historyIndex(page)).toBe(base + 1);

    // The in-app Back pops the section's entry and keeps the sheet.
    await backToSections(page).click();
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
    await expect(page.getByTestId('mode-dark')).toBeHidden();
    await expect(sheet(page)).toBeVisible();
    expect(await historyIndex(page)).toBe(base);

    // Browser Back from a section steps to the list, never past the room underneath.
    await page.getByTestId('settings-nav-profile').click();
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    expect(await historyIndex(page)).toBe(base + 1);
    await page.evaluate(() => history.back());
    await expect(page.getByTestId('settings-nav-profile')).toBeVisible();
    await expect(page.getByTestId('settings-nav-profile')).toBeFocused();
    await expect(sheet(page)).toBeVisible();
    await expect.poll(() => historyIndex(page)).toBe(base);
    await expect(page).toHaveURL(roomUrl);
  });

  test('closing the sheet with × takes its section entries off history', async ({
    page,
  }) => {
    await openPhoneSheet(page);
    const roomUrl = page.url();
    const base = await historyIndex(page);

    await page.getByTestId('settings-nav-appearance').click();
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    expect(await historyIndex(page)).toBe(base + 1);

    await closeSettings(page);
    await expect.poll(() => historyIndex(page)).toBe(base);
    await expect(page).toHaveURL(roomUrl);
    // Nothing of the sheet is left to step back through.
    await expect(page.locator('trn-rooms')).toBeVisible();
  });

  test('a section slides in over the sheet directory and out again', async ({
    page,
  }) => {
    await openPhoneSheet(page);
    const slides = await watchSlides(page);

    await page.getByTestId('settings-nav-appearance').click();
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    await expect(page.locator('[data-pane-slide]')).toHaveCount(0);
    await backToSections(page).click();
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
    await expect(page.locator('[data-pane-slide]')).toHaveCount(0);
    // The page leaving keeps its section until it has slid off.
    await expect(page.getByTestId('mode-dark')).toBeHidden();

    const recorded = await slides();
    expect(recorded.map(([slide, name]) => [slide, name])).toEqual([
      ['open', 'pane-over-in'],
      ['close', 'pane-over-out'],
    ]);
    for (const [, , duration] of recorded) {
      expect(duration).toBeGreaterThan(100);
    }
  });

  test('Reduce Motion keeps the steps and drops the travel', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPhoneSheet(page);
    const slides = await watchSlides(page);
    const base = await historyIndex(page);

    await page.getByTestId('settings-nav-appearance').click();
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    await backToSections(page).click();
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible();
    expect(await historyIndex(page)).toBe(base);

    const recorded = await slides();
    expect(recorded.map(([slide]) => slide)).toEqual(['open', 'close']);
    for (const [, , duration] of recorded) {
      expect(duration).toBeLessThan(1);
    }
  });

  test('the routed page slides a section in and out, but not on a history step or a resize', async ({
    page,
  }) => {
    await login(page, session);
    await page.goto('/settings');
    const appearance = page.getByTestId('settings-nav-appearance');
    await expect(appearance).toBeVisible({ timeout: 20_000 });
    const slides = await watchSlides(page);

    await appearance.click();
    await page.waitForURL(APPEARANCE);
    await backToSections(page).click();
    await page.waitForURL(/\/settings$/);
    await expect(appearance).toBeVisible();
    await expect(appearance).toBeFocused();
    expect((await slides()).map(([slide, name]) => [slide, name])).toEqual([
      ['open', 'pane-over-in'],
      ['close', 'pane-over-out'],
    ]);

    // A history step: the platform's swipe draws its own motion.
    await page.goForward();
    await page.waitForURL(APPEARANCE);
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    await page.goBack();
    await page.waitForURL(/\/settings$/);
    await expect(appearance).toBeVisible();
    expect(await slides()).toHaveLength(2);

    // Crossing md either way starts none.
    await appearance.click();
    await page.waitForURL(APPEARANCE);
    await expect(page.locator('[data-pane-slide]')).toHaveCount(0);
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.setViewportSize(PHONE);
    await expect(page.getByTestId('mode-dark')).toBeVisible();
    expect(
      await page.evaluate(async () => {
        const frame = () => new Promise((done) => requestAnimationFrame(done));
        await frame();
        await frame();
        return document.querySelector('[data-pane-slide]') === null;
      }),
    ).toBe(true);
    expect(await slides()).toHaveLength(3);
  });

  test.describe('with touch', () => {
    test.use({ hasTouch: true });

    test('an edge swipe goes back one section, and springs back short of the threshold', async ({
      page,
    }) => {
      await openPhoneSheet(page);
      const base = await historyIndex(page);
      await page.getByTestId('settings-nav-profile').click();
      const field = page.getByTestId('display-name-input');
      await expect(field).toBeVisible();
      await expect(page.locator('[data-pane-slide]')).toHaveCount(0);

      const workspace = page.getByTestId('settings-workspace');
      const box = (await workspace.boundingBox())!;
      const detail = page.getByTestId('settings-detail');
      const edge = { x: Math.round(box.x + 8), y: Math.round(box.y + 200) };

      // Mid-drag the section follows the finger over the directory.
      const release = await swipe(page, edge, edge.x + 120, {
        release: false,
      });
      await expect(workspace).toHaveAttribute('data-pane-swipe', '');
      const following = await detail.evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
      );
      expect(following).toBeGreaterThan(100);
      await release();

      // Short of the threshold, it springs back and stays.
      await expect(workspace).not.toHaveAttribute('data-pane-swipe');
      await expect(field).toBeVisible();
      expect(
        await detail.evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
        ),
      ).toBe(0);
      expect(await historyIndex(page)).toBe(base + 1);

      // Past it, the section goes back, and only one step.
      await swipe(page, edge, Math.round(box.x + box.width * 0.75));
      await expect(page.getByTestId('settings-nav-profile')).toBeVisible();
      await expect(field).toBeHidden();
      await expect(sheet(page)).toBeVisible();
      await expect.poll(() => historyIndex(page)).toBe(base);
    });
  });
});
