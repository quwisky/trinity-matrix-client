import type { Page } from '@playwright/test';

export interface TouchPoint {
  x: number;
  y: number;
}

export interface TouchPlatform {
  swipe(page: Page, from: TouchPoint, to: TouchPoint): Promise<void>;
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
