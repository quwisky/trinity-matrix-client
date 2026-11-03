/** A height a phone sheet rests at: half the screen, or full height below the title row. */
export type TrnSheetDetent = 'medium' | 'large';

/** The tallest a sheet may be: below the top safe area, the title row and the keyboard. */
export const SHEET_LARGE_HEIGHT =
  'calc(100dvh - env(safe-area-inset-top, 0px) - var(--trinity-title-row-inset, 0px) - var(--trinity-keyboard-shrink, 0px))';

export const SHEET_DETENT_HEIGHT = {
  medium: '50svh',
  large: SHEET_LARGE_HEIGHT,
} as const satisfies Record<TrnSheetDetent, string>;

/** A drag past this fraction of the lowest height closes the sheet. */
export const DISMISS_FRACTION = 0.25;
/** px per ms */
export const FLING_VELOCITY = 0.5;
/** A fling must also travel this far (px), so a twitch never closes the sheet. */
export const FLING_MIN_DISTANCE = 24;

/**
 * Where a sheet resting at `current` goes after a drag of `dy` px (negative is up) released at
 * `velocity` px/ms: a fling moves one detent its way, otherwise the nearer height wins, and
 * below the lowest detent by {@link DISMISS_FRACTION} it closes.
 *
 * shortcut: heights are estimated from the viewport (half and all of it), not measured; measure
 * the sheet if the midpoint feels off on a device with a tall title row.
 */
export function nextDetent(
  current: TrnSheetDetent,
  dy: number,
  velocity: number,
  available: readonly TrnSheetDetent[],
  viewport = window.innerHeight,
): TrnSheetDetent | 'dismiss' {
  const px = { medium: viewport / 2, large: viewport };
  const both = available.includes('medium') && available.includes('large');
  const lowest: TrnSheetDetent = available.includes('medium')
    ? 'medium'
    : 'large';
  if (
    Math.abs(dy) > FLING_MIN_DISTANCE &&
    Math.abs(velocity) > FLING_VELOCITY
  ) {
    if (dy < 0) return both ? 'large' : current;
    return both && current === 'large' ? 'medium' : 'dismiss';
  }
  const height = px[current] - dy;
  if (height < px[lowest] * (1 - DISMISS_FRACTION)) return 'dismiss';
  if (!both) return lowest;
  return height > (px.medium + px.large) / 2 ? 'large' : 'medium';
}
