import type { Locator, Page } from '@playwright/test';
import type { TouchPoint } from './platform-contracts.mts';
export type { TouchPlatform, TouchPoint } from './platform-contracts.mts';

/** Press and release a target past Trinity's 500ms long-press threshold. */
export async function touchLongPress(
  page: Page,
  target: Locator,
): Promise<void> {
  // A scroll during the 700ms hold cancels the long-press, and a timeline that has just
  // opened is still settling at its bottom. Press only once the row has held its place.
  await waitUntilStill(target);
  const box = await target.boundingBox();
  if (!box) throw new Error('no box for long-press target');
  const point = {
    isPrimary: true,
    pointerType: 'touch',
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  };
  await target.dispatchEvent('pointerdown', point);
  await page.waitForTimeout(700);
  await target.dispatchEvent('pointerup', point);
}

export async function cdpSwipe(
  page: Page,
  from: TouchPoint,
  to: TouchPoint,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const steps = 10;
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...from, id: 1 }],
    });
    // Give Chromium a renderer frame for every point. Under parallel load it can otherwise
    // coalesce the whole path into touch-axis arbitration without delivering pointer moves.
    await nextAnimationFrame(page);
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: Math.round(from.x + ((to.x - from.x) * step) / steps),
            y: Math.round(from.y + ((to.y - from.y) * step) / steps),
            id: 1,
          },
        ],
      });
      await nextAnimationFrame(page);
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

async function nextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Resolve once `target` has kept the same box for {@link STILL_FRAMES} animation frames in a
 * row, so a gesture that needs it to hold still is not cancelled by a scroll in progress.
 * Bounded inside the page (`Locator.evaluate`'s timeout only covers finding the element):
 * a target that never holds still fails after `timeout`.
 */
export async function waitUntilStill(
  target: Locator,
  timeout = 10_000,
): Promise<void> {
  await target.evaluate(
    (element, { frames, limit }) =>
      new Promise<void>((resolve, reject) => {
        let last = '';
        let still = 0;
        let frameId = 0;
        // A timer, not a frame count: frames stop in a hidden page, and this must still end.
        const timer = setTimeout(() => {
          cancelAnimationFrame(frameId);
          reject(
            new Error(
              `The target kept moving for ${limit}ms (last box ${last})`,
            ),
          );
        }, limit);
        const frame = (): void => {
          const { top, left, width, height } = element.getBoundingClientRect();
          const box = `${top},${left},${width},${height}`;
          still = box === last ? still + 1 : 0;
          last = box;
          if (still >= frames) {
            clearTimeout(timer);
            resolve();
          } else {
            frameId = requestAnimationFrame(frame);
          }
        };
        frameId = requestAnimationFrame(frame);
      }),
    { frames: STILL_FRAMES, limit: timeout },
    { timeout },
  );
}

/** About 150ms at 60Hz: longer than a frame or two of smooth-scroll easing. */
const STILL_FRAMES = 10;
