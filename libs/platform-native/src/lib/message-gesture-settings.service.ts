import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const MESSAGE_SWIPE_KEY = 'trinity.message-swipe';

/**
 * Which way a message row is dragged to act on it.
 *
 * Three values, and `off` is a first-class one rather than the absence of a choice. The
 * direction has to be a setting because neither direction is free on a phone: the shell's
 * drawer opens on a right-edge drag, and iOS and Android own both screen edges with
 * recognisers `touch-action` cannot arbitrate. Someone whose grip keeps triggering the
 * gesture needs a way out that is not "stop using the app one-handed", and no default fixes
 * that for them.
 */
export const TRINITY_SWIPE_ACTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
] as const;

/** The id of a registered swipe direction. */
export type SwipeAction = (typeof TRINITY_SWIPE_ACTIONS)[number]['id'];

/**
 * A new install does not swipe.
 *
 * Deliberate, and not timidity: shipping a gesture on by default over a scrolling timeline
 * changes how the app answers a drag people already make for other reasons, and the conflicts
 * it has to dodge are with platform recognisers no test can install. The first evidence has to
 * come from a real phone. Flipping this afterwards is one line.
 */
export const DEFAULT_SWIPE_ACTION: SwipeAction = 'off';

/**
 * True when `value` is a registered swipe direction.
 *
 * Accepts `undefined` as well as `null` so a caller can narrow the value it actually holds:
 * `hlm-select`'s `valueChange` is `string | null | undefined`, and narrowing a massaged
 * expression (`isSwipeAction(value ?? null)`) leaves the original binding un-narrowed — which
 * type-checks under vitest and fails only in the Angular build. Same reasoning, and the same
 * signature, as `isTimeFormat` in `@trinity/util/matrix`.
 */
export function isSwipeAction(
  value: string | null | undefined,
): value is SwipeAction {
  return TRINITY_SWIPE_ACTIONS.some((option) => option.id === value);
}

/**
 * How a message row responds to a sideways drag.
 *
 * A dedicated service rather than an Appearance axis, because this is an input-model
 * preference. Every Appearance axis projects through its owning interface; a gesture direction has
 * no DOM footprint at all — it is read by one component's pointer handling and by nothing
 * else. Putting it there would have meant an `applyX()` with nothing to apply.
 *
 * Device-scoped, like the other UI preferences ({@link ComposerSettingsService}, Theme):
 * non-secret, so it lives in Capacitor `Preferences` rather than secure storage. It is also
 * genuinely per-device — the hand holding a phone is not the hand on a tablet.
 */
@Injectable({ providedIn: 'root' })
export class MessageGestureSettingsService {
  private readonly _messageSwipe = signal<SwipeAction>(DEFAULT_SWIPE_ACTION);

  /** Which way a message row is dragged to edit or reply to it. */
  readonly messageSwipe = this._messageSwipe.asReadonly();

  /** The registered directions, for the settings picker. */
  readonly swipeActions = TRINITY_SWIPE_ACTIONS;

  /** Read the saved preference. Call once at app startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: MESSAGE_SWIPE_KEY });
      if (isSwipeAction(value)) {
        this._messageSwipe.set(value);
      }
    } catch {
      // No stored value (or storage unavailable) → keep the default (off).
    }
  }

  /** Change + persist which way a message row is dragged. */
  setMessageSwipe(action: SwipeAction): void {
    this._messageSwipe.set(action);
    void Preferences.set({ key: MESSAGE_SWIPE_KEY, value: action }).catch(
      () => undefined,
    );
  }
}
