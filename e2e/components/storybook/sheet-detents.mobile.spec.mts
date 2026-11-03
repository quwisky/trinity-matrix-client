import { expect, test, type Locator, type Page } from '@playwright/test';
import { cdpSwipe, sheetAtRest } from '../../support/touch-platform.mts';
import { overlayRecipeStory } from './overlay-recipe-story-url.mts';

// A phone sheet opened with detents rests at half height, grows to full height from its
// content, its handle button or a focused field, and only a drag brings it back down.
// The story opens it with the default initial focus.

async function openSheet(
  page: Page,
  which: 'long' | 'short',
): Promise<Locator> {
  await page.goto(overlayRecipeStory('sheet-detents'));
  await page.getByTestId(`sheet-detents-${which}`).tap();
  const sheet = page.locator('[data-trn-layout="sheet"]');
  await expect(sheet).toBeVisible();
  await sheetAtRest(sheet);
  return sheet;
}

/** Waits out a snap: the sheet holds the same height for a few frames. */
async function settledHeight(sheet: Locator): Promise<number> {
  return sheet.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        let last = -1;
        let still = 0;
        const frame = () => {
          const height = Math.round(element.getBoundingClientRect().height);
          still = height === last ? still + 1 : 0;
          last = height;
          if (still >= 5) resolve(height);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/**
 * Scrolls `scroller` to its top and resolves once it has had no scroll event for longer
 * than the drag's momentum guard (120ms), so the next touch is not read as a coasting list.
 */
async function scrollToTopAndSettle(scroller: Locator): Promise<void> {
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const scrolled = () => {
          clearTimeout(quiet);
          quiet = setTimeout(() => {
            element.removeEventListener('scroll', scrolled);
            resolve();
          }, 200);
        };
        element.addEventListener('scroll', scrolled);
        element.scrollTop = 0;
        scrolled();
      }),
  );
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
}

async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const body = (sheet: Locator) => sheet.locator('.dialog-shell__body');
const row = (sheet: Locator) => sheet.getByTestId('sheet-detents-row').nth(2);

test('content drags a half-height sheet up to full height and back', async ({
  page,
}) => {
  const sheet = await openSheet(page, 'long');
  const viewport = page.viewportSize()!;
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'medium');
  expect(await settledHeight(sheet)).toBeCloseTo(viewport.height / 2, -1);

  let from = await centre(row(sheet));
  await cdpSwipe(page, from, { x: from.x, y: from.y - 250 });
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');
  expect(await settledHeight(sheet)).toBeGreaterThan(viewport.height * 0.8);
  expect(await body(sheet).evaluate((el) => el.scrollTop)).toBe(0);

  // At full height the content scrolls instead.
  from = await centre(row(sheet));
  await cdpSwipe(page, from, { x: from.x, y: from.y - 200 });
  await expect
    .poll(() => body(sheet).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');

  // Back at its top, a downward drag lowers it to half height, not closed.
  await scrollToTopAndSettle(body(sheet));
  from = await centre(row(sheet));
  await cdpSwipe(page, from, { x: from.x, y: from.y + 250 });
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'medium');
  await expect(sheet).toBeVisible();
});

test('a mostly horizontal drag changes no detent, where a vertical one would', async ({
  page,
}) => {
  const sheet = await openSheet(page, 'long');
  let from = await centre(row(sheet));
  await cdpSwipe(page, from, { x: from.x - 150, y: from.y - 100 });
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'medium');

  // The same drag turned vertical claims the sheet, so the one above was refused for its angle.
  await scrollToTopAndSettle(body(sheet));
  from = await centre(row(sheet));
  await cdpSwipe(page, from, { x: from.x - 100, y: from.y - 250 });
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');
});

test('opens with focus on the sheet content, never on the handle button', async ({
  page,
}) => {
  for (const which of ['long', 'short'] as const) {
    const sheet = await openSheet(page, which);
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();
  }
});

test('the handle is a 44px button that expands and collapses from the keyboard', async ({
  page,
}) => {
  const sheet = await openSheet(page, 'long');
  const expand = sheet.getByRole('button', { name: 'Expand' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');

  // The invisible target reaches 44px down from the top edge, and the close X still wins.
  const pill = (await sheet.getByTestId('sheet-handle').boundingBox())!;
  const top = (await sheet.boundingBox())!.y;
  const hit = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('[data-trn-sheet-toggle]') !==
      null,
    { x: pill.x + pill.width / 2, y: top + 42 },
  );
  expect(hit).toBe(true);
  const close = await centre(sheet.getByRole('button', { name: 'Close' }));
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('button')?.ariaLabel ?? null,
      close,
    ),
  ).toBe('Close');

  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');
  const collapse = sheet.getByRole('button', { name: 'Collapse' });
  await expect(collapse).toBeFocused();
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'medium');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('a focused field raises the sheet to full height, and blur keeps it there', async ({
  page,
}) => {
  const sheet = await openSheet(page, 'long');
  await sheet.getByTestId('sheet-detents-search').focus();
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');
  await sheet.getByTestId('sheet-detents-search').blur();
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');
});

test('content shorter than half height shows at its own height with no full height', async ({
  page,
}) => {
  const sheet = await openSheet(page, 'short');
  const viewport = page.viewportSize()!;
  const height = await settledHeight(sheet);
  expect(height).toBeLessThan(viewport.height / 2 - 20);
  await expect(sheet.getByRole('button', { name: 'Expand' })).toHaveCount(0);

  const from = await centre(sheet.getByTestId('sheet-handle'));
  await cdpSwipe(page, from, { x: from.x, y: from.y - 300 });
  expect(await settledHeight(sheet)).toBeCloseTo(height, -1);
});

test('a resize to wide mid-drag drops the drag and its inline geometry', async ({
  page,
}) => {
  const sheet = await openSheet(page, 'long');
  const from = await centre(row(sheet));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 1 }],
  });
  for (let step = 1; step <= 5; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x, y: from.y - step * 30, id: 1 }],
    });
  }
  await expect.poll(() => sheet.evaluate((el) => el.style.height)).not.toBe('');

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(sheet).not.toHaveAttribute('data-sheet-detent');
  const inline = () =>
    sheet.evaluate((el) => ({
      height: el.style.height,
      transform: el.style.transform,
      transition: el.style.transition,
    }));
  expect(await inline()).toEqual({ height: '', transform: '', transition: '' });

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
  expect(await inline()).toEqual({ height: '', transform: '', transition: '' });
  await expect(sheet).toBeVisible();
});
