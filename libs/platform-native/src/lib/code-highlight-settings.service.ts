import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  DEFAULT_MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINES,
  setMaxHighlightLines,
} from '@trinity/util/matrix';

const MAX_HIGHLIGHT_LINES_KEY = 'trinity.code-highlight-lines';

/**
 * Whether `lines` is a limit this setting accepts (`0` = no limit).
 *
 * Deliberately the same range `setMaxHighlightLines` itself enforces, taken from the same
 * constant rather than restated: a guard here that was looser than the sanitizer's would
 * accept a value from a pasted config that then silently did nothing.
 */
export function isMaxHighlightLines(lines: number): boolean {
  return Number.isInteger(lines) && lines >= 0 && lines <= MAX_HIGHLIGHT_LINES;
}

/**
 * How much code Trinity will syntax-highlight in one message.
 *
 * Its own service rather than another axis on {@link ThemeService}, because it is not one:
 * every preference there is reflected on `<html>` and changes nothing but CSS, while this
 * one changes the *markup* the sanitizer produces. It is the only preference that does, and
 * paying for it means invalidating the memo that markup is cached in — which is what
 * `setMaxHighlightLines` in `@trinity/util/matrix` does, and why {@link apply} exists at all.
 * Clearing the memo is half the job; the timeline drops its own view cache in response to
 * this signal.
 *
 * Device-scoped like the other UI preferences: non-secret, so Capacitor `Preferences` rather
 * than secure storage.
 */
@Injectable({ providedIn: 'root' })
export class CodeHighlightSettingsService {
  private readonly _maxHighlightLines = signal(DEFAULT_MAX_HIGHLIGHT_LINES);

  /** Lines of code in one message Trinity will colour; `0` means no limit. */
  readonly maxHighlightLines = this._maxHighlightLines.asReadonly();

  /** Read the saved limit and apply it. Call once at app startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: MAX_HIGHLIGHT_LINES_KEY });
      // `Number('')` and `Number(' ')` are both 0 — which is the value that means "no
      // limit at all". An empty entry has to be rejected before it is parsed, or storage
      // that came back blank silently turns the ceiling off.
      const stored =
        value === null || value.trim() === '' ? Number.NaN : Number(value);
      if (isMaxHighlightLines(stored)) {
        this._maxHighlightLines.set(stored);
      }
    } catch {
      // No stored limit (or storage unavailable) → keep the default.
    }
    this.apply();
  }

  /** Change + persist how much code is coloured, applying it immediately. */
  setMaxHighlightLines(lines: number): void {
    if (!isMaxHighlightLines(lines)) {
      return;
    }
    this._maxHighlightLines.set(lines);
    this.apply();
    void Preferences.set({
      key: MAX_HIGHLIGHT_LINES_KEY,
      value: String(lines),
    }).catch(() => undefined);
  }

  /**
   * Push the limit into the sanitizer.
   *
   * A push rather than a read, because `@trinity/util/matrix` is `[type:util]` and may not
   * depend on this lib — the same registration seam `setCodeHighlighter` uses.
   */
  private apply(): void {
    setMaxHighlightLines(this._maxHighlightLines());
  }
}
