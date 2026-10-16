import type { Locator } from '@playwright/test';

/**
 * Wait until the overlay holding `target` (its dialog, or the target itself outside one) has
 * finished its entrance animations: the sheet's slide-up and the dialog's scale-in.
 *
 * Playwright's stability check can pass while a sheet is still sliding under load, so a
 * press lands where Close or Cancel was a frame ago and hits the sheet body instead. The
 * controls work during the entrance (a DOM click there closes the dialog); only a pointer
 * aimed at a moving box misses. Infinite animations, such as a spinner, are ignored.
 *
 * Bounded inside the page: `Locator.evaluate`'s own timeout only covers finding the element,
 * so an animation that never finishes fails here after `timeout` with its name.
 */
export async function settleSurface(
  target: Locator,
  timeout = 10_000,
): Promise<void> {
  await target.evaluate(
    (element, limit) => {
      const surface =
        element.closest('[role="dialog"], [role="alertdialog"]') ?? element;
      const running = surface
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        );
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const names = running
            .filter((animation) => animation.playState !== 'finished')
            .map(
              (animation) =>
                (animation as CSSAnimation).animationName ??
                animation.id ??
                'transition',
            );
          reject(
            new Error(
              `The surface was still animating after ${limit}ms: ${names.join(', ')}`,
            ),
          );
        }, limit);
        void Promise.all(
          running.map((animation) => animation.finished.catch(() => undefined)),
        ).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    timeout,
    { timeout },
  );
}
