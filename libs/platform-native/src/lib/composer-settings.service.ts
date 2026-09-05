import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  combinePreferenceInitialization,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
  type PreferenceInitializationRead,
} from './preference-initialization';

const SHOW_TOOLBAR_KEY = 'trinity.composer.show-toolbar';
const FORMAT_ON_SELECTION_KEY = 'trinity.composer.format-on-selection';

/** The formatting toolbar is pinned open unless the user unpins it. */
export const DEFAULT_SHOW_FORMATTING_TOOLBAR = true;

/** With the toolbar unpinned, selecting text still raises it. */
export const DEFAULT_FORMAT_ON_SELECTION = true;

/**
 * How the message composer is presented.
 *
 * Two preferences, and they are separate on purpose.
 *
 * `showFormattingToolbar` has always meant "there is a row of formatting buttons above the
 * input", and it still does — it is the PIN. What is new is that the bar can also appear on
 * demand, when there is a selection to format, and that is `formatOnSelection`.
 *
 * Folding the two together would have changed what the existing preference means for the
 * people who had turned it off. They chose *never*, and a contextual bar appearing on every
 * selection is not what they asked for; the migration in {@link init} is what keeps that
 * promise. Hiding the bar is about screen space either way, so the **keyboard shortcuts keep
 * working** in every combination — Ctrl/Cmd+B still bolds with no bar in sight.
 *
 * Device-scoped, like the other UI preferences ({@link SystemLineSettingsService}, the
 * theme): non-secret, so they live in Capacitor `Preferences` rather than secure storage.
 */
@Injectable({ providedIn: 'root' })
export class ComposerSettingsService {
  private readonly _showFormattingToolbar = signal(
    DEFAULT_SHOW_FORMATTING_TOOLBAR,
  );
  private readonly _formatOnSelection = signal(DEFAULT_FORMAT_ON_SELECTION);

  /** Whether the formatting bar is pinned above the message input. */
  readonly showFormattingToolbar = this._showFormattingToolbar.asReadonly();

  /** Whether selecting text raises the formatting bar while it is unpinned. */
  readonly formatOnSelection = this._formatOnSelection.asReadonly();

  /**
   * Read both saved preferences and apply them. Call once at app startup.
   *
   * The second one carries a migration, and it runs exactly once per install. Someone who had
   * already turned the toolbar OFF chose to never see it; defaulting the new preference to
   * `true` for them would answer that by showing it on every selection instead. So an absent
   * `format-on-selection` inherits a stored `show-toolbar: false`, and is written back — after
   * which the two are independent and either can be changed without the other moving.
   *
   * An absent `show-toolbar` means the user never expressed a view, so both stay at their
   * defaults and the bar behaves as it always has.
   */
  async init(): Promise<PreferenceInitializationOutcome> {
    const [pin, selection] = await Promise.all([
      this.readBoolean(SHOW_TOOLBAR_KEY),
      this.readBoolean(FORMAT_ON_SELECTION_KEY),
    ]);
    const storedPin = pin.value;
    if (storedPin !== null) {
      this._showFormattingToolbar.set(storedPin);
    }
    if (selection.value !== null) {
      this._formatOnSelection.set(selection.value);
    } else if (storedPin === false && selection.outcome.kind === 'ready') {
      this.setFormatOnSelection(false);
    }
    return combinePreferenceInitialization([pin.outcome, selection.outcome]);
  }

  private async readBoolean(
    key: string,
  ): Promise<PreferenceInitializationRead<boolean | null>> {
    try {
      const { value } = await Preferences.get({ key });
      // Parsed once and reused, so the migration below asks the same question the signal did.
      // Comparing the raw string against `'false'` there instead would let a value that is
      // neither `'true'` nor `'false'` unpin the bar (it is not `'true'`) while skipping the
      // inheritance (it is not `'false'`) — the one combination this is meant to prevent.
      if (value === null) {
        return { value: null, outcome: preferenceInitializationReady };
      }
      if (value === 'true' || value === 'false') {
        return {
          value: value === 'true',
          outcome: preferenceInitializationReady,
        };
      }
      return {
        value: null,
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    } catch {
      return {
        value: null,
        outcome: preferenceInitializationDefaulted('storage-unavailable'),
      };
    }
  }

  /** Pin or unpin the formatting bar, and persist it. */
  setShowFormattingToolbar(on: boolean): void {
    this._showFormattingToolbar.set(on);
    this.persist(SHOW_TOOLBAR_KEY, on);
  }

  /** Whether selecting text raises the bar while it is unpinned; persisted. */
  setFormatOnSelection(on: boolean): void {
    this._formatOnSelection.set(on);
    this.persist(FORMAT_ON_SELECTION_KEY, on);
  }

  private persist(key: string, on: boolean): void {
    void Preferences.set({ key, value: String(on) }).catch(() => undefined);
  }
}
