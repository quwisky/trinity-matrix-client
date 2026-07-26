import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const SHOW_TOOLBAR_KEY = 'trinity.composer.show-toolbar';

/**
 * How the message composer is presented.
 *
 * Only the formatting toolbar so far: it costs a row above every composer, which is worth it
 * while you are learning what markdown the client accepts and pure clutter once you are
 * typing `**bold**` from memory. Hiding it is about screen space, so the **keyboard shortcuts
 * keep working** — Ctrl/Cmd+B still bolds with the row hidden, and Shift+Enter still
 * continues a list. Shown by default, so nothing changes until the user opts out.
 *
 * Device-scoped, like the other UI preferences ({@link SystemLineSettingsService}, the
 * theme): non-secret, so it lives in Capacitor `Preferences` rather than secure storage.
 */
@Injectable({ providedIn: 'root' })
export class ComposerSettingsService {
  private readonly _showFormattingToolbar = signal(true);

  /** Whether the formatting toolbar sits above the message input. */
  readonly showFormattingToolbar = this._showFormattingToolbar.asReadonly();

  /** Read the saved preference and apply it. Call once at app startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: SHOW_TOOLBAR_KEY });
      if (value !== null) {
        this._showFormattingToolbar.set(value === 'true');
      }
    } catch {
      // No stored value (or storage unavailable) → keep the default (shown).
    }
  }

  /** Toggle + persist whether the formatting toolbar is shown. */
  setShowFormattingToolbar(on: boolean): void {
    this._showFormattingToolbar.set(on);
    void Preferences.set({
      key: SHOW_TOOLBAR_KEY,
      value: String(on),
    }).catch(() => undefined);
  }
}
