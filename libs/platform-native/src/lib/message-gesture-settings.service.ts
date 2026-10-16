import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
} from './preference-initialization';

const MESSAGE_SWIPE_KEY = 'trinity.message-swipe';

/**
 * Which way a message row is dragged to act on it; `off` is a real choice.
 *
 * Neither direction is free on a phone: the shell's drawer opens on a right-edge drag, and
 * iOS and Android own both screen edges with recognisers `touch-action` cannot arbitrate.
 */
export const TRINITY_SWIPE_ACTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
] as const;

/** The id of a registered swipe direction. */
export type SwipeAction = (typeof TRINITY_SWIPE_ACTIONS)[number]['id'];

/**
 * A new install does not swipe: a default-on gesture over a scrolling timeline changes how
 * the app answers drags people already make, and its conflicts are with platform
 * recognisers no test can install.
 */
export const DEFAULT_SWIPE_ACTION: SwipeAction = 'off';

/**
 * True when `value` is a registered swipe direction.
 *
 * Accepts `undefined` as well as `null` so a caller narrows the value it holds: narrowing
 * `value ?? null` leaves the original binding un-narrowed, which type-checks under vitest
 * and fails only in the Angular build.
 */
export function isSwipeAction(
  value: string | null | undefined,
): value is SwipeAction {
  return TRINITY_SWIPE_ACTIONS.some((option) => option.id === value);
}

/**
 * How a message row responds to a sideways drag. Not an Appearance axis: it has no DOM
 * footprint to project. Per-device and non-secret, so it lives in Capacitor `Preferences`.
 */
@Injectable({ providedIn: 'root' })
export class MessageGestureSettingsService {
  private readonly _messageSwipe = signal<SwipeAction>(DEFAULT_SWIPE_ACTION);

  /** Which way a message row is dragged to edit or reply to it. */
  readonly messageSwipe = this._messageSwipe.asReadonly();

  /** The registered directions, for the settings picker. */
  readonly swipeActions = TRINITY_SWIPE_ACTIONS;

  /** Read the saved preference. Call once at app startup. */
  async init(): Promise<PreferenceInitializationOutcome> {
    try {
      const { value } = await Preferences.get({ key: MESSAGE_SWIPE_KEY });
      if (isSwipeAction(value)) {
        this._messageSwipe.set(value);
      }
      return value === null || isSwipeAction(value)
        ? preferenceInitializationReady
        : preferenceInitializationDefaulted('invalid-stored-value');
    } catch {
      return preferenceInitializationDefaulted('storage-unavailable');
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
