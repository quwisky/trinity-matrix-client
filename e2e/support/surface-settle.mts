import type { Locator } from '@playwright/test';

/**
 * Wait until the overlay holding `target` (its dialog, or the target itself outside one) has
 * finished its entrance animations: the sheet's slide-up and the dialog's scale-in.
 *
 * Playwright's stability check can pass while a sheet is still sliding under load, so a
 * press lands where Close or Cancel was a frame ago and hits the sheet body instead. The
 * controls work during the entrance (a DOM click there closes the dialog); only a pointer
 * aimed at a moving box misses. Infinite animations, such as a spinner, are ignored.
 */
export async function settleSurface(
  target: Locator,
  timeout = 30_000,
): Promise<void> {
  await target.evaluate(
    (element) => {
      const surface =
        element.closest('[role="dialog"], [role="alertdialog"]') ?? element;
      return Promise.all(
        surface
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().endTime !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    },
    undefined,
    { timeout },
  );
}
