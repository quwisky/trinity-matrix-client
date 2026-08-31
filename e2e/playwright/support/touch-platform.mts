import type { Locator, Page } from '@playwright/test';

export interface TouchPoint {
  x: number;
  y: number;
}

export interface TouchPlatform {
  tap(page: Page, target: Locator): Promise<void>;
  swipe(page: Page, from: TouchPoint, to: TouchPoint): Promise<void>;
}

/** Press and release a target past Trinity's 500ms long-press threshold. */
export async function touchLongPress(
  page: Page,
  target: Locator,
): Promise<void> {
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
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}
