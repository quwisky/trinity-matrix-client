import { expect, type Locator, type Page } from '@playwright/test';

interface TouchViewport {
  scale: number;
  applyScale(scale: number): Promise<void>;
}

const inputViewports = new WeakMap<Page, TouchViewport>();

/** Scale through the viewport owner's connection so input cleanup cannot reset it. */
export function setAndroidTouchViewport(
  page: Page,
  viewport: TouchViewport,
): void {
  inputViewports.set(page, viewport);
}

/** Send one native tap, blocking input if layout moves another control under it. */
export async function touchAndroidControl(
  page: Page,
  control: Locator,
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const viewport = inputViewports.get(page);
  const scale = viewport?.scale ?? 1;

  try {
    // Wide emulated layouts must fit onto the physical WebView for native gesture input.
    if (scale < 1) await viewport?.applyScale(scale);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      // aria-disabled actions still accept touch to explain their unavailability.
      // Native disabled controls cannot receive activation at all.
      await expect
        .poll(() => control.evaluate((element) => element.matches(':disabled')))
        .toBe(false);
      const guard = await control.evaluateHandle((element) => {
        const bounds = element.getBoundingClientRect();
        const point = {
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2),
        };
        let intercepted = !element.contains(
          document.elementFromPoint(point.x, point.y),
        );
        const touchFeedback = element.getAttribute('aria-disabled') === 'true';
        let activated = false;
        let inputStarted = false;
        const events = [
          'pointerdown',
          'pointerup',
          'touchstart',
          'touchend',
          'mousedown',
          'mouseup',
          'click',
        ];
        const listener = (event: Event) => {
          if (activated) return;
          // Drawer swipe handling can capture release without moving the finger off this control.
          const capturedRelease =
            event instanceof PointerEvent &&
            event.type === 'pointerup' &&
            event.target instanceof Element &&
            event.target.hasPointerCapture(event.pointerId) &&
            element.contains(
              document.elementFromPoint(event.clientX, event.clientY),
            );
          if (
            !capturedRelease &&
            (!(event.target instanceof Node) || !element.contains(event.target))
          )
            intercepted = true;
          if (intercepted) {
            event.preventDefault();
            event.stopImmediatePropagation();
          } else {
            if (['pointerdown', 'touchstart', 'mousedown'].includes(event.type))
              inputStarted = true;
            if (
              event.type === 'click' ||
              (touchFeedback && event.type === 'touchend')
            )
              activated = true;
          }
        };
        for (const event of events)
          document.addEventListener(event, listener, {
            capture: true,
            passive: false,
          });
        return {
          point,
          ready: !intercepted,
          finish: () => {
            for (const event of events)
              document.removeEventListener(event, listener, true);
            return { intercepted, activated, inputStarted };
          },
        };
      });
      try {
        const { point, ready } = await guard.evaluate(({ point, ready }) => ({
          point,
          ready,
        }));
        if (ready) {
          // Raw start/end command acknowledgement can precede click synthesis in
          // WebView. Chromium owns the complete gesture and its duration here.
          await session.send('Input.synthesizeTapGesture', {
            x: point.x * scale,
            y: point.y * scale,
            gestureSourceType: 'touch',
          });
        }
        const result = await guard.evaluate((guard) => guard.finish());
        if (result.activated) return;
        if (!result.intercepted)
          throw new Error(
            'Android touch completed without activating its target',
          );
        if (result.inputStarted)
          throw new Error(
            'Android touch target moved after input began; refusing to repeat the action',
          );
        // Only blocked input is retried: the capture guard suppressed every event
        // before activation, so a late banner cannot redirect or duplicate a tap.
      } finally {
        await guard.evaluate((guard) => guard.finish()).catch(() => undefined);
        await guard.dispose();
      }
    }
    throw new Error(
      'Android touch target moved or was obstructed during three guarded attempts',
    );
  } finally {
    try {
      if (scale < 1) await viewport?.applyScale(1);
    } finally {
      await session.detach();
    }
  }
}
