import { linkedSignal, signal, type Signal } from '@angular/core';
import { READING_SPEED_PX_PER_S } from '../shared/timeline-scroll-activity';

/** Faster than this the list is flinging: rows only fly past (the study's flings ran 3,000–10,000 px/s). */
export const FLING_SPEED_PX_PER_S = 3_000;

const NONE: ReadonlySet<string> = new Set();

/**
 * Which rows of the window render as blank placeholders during a fling, behind the "Blank
 * rows while scrolling fast" flag (Settings › Experimental).
 *
 * A fling starts once the reader moves the list at {@link FLING_SPEED_PX_PER_S} or more, and
 * ends when it slows to reading speed, settles, jumps, or the flag goes off. While it lasts,
 * a row that enters the window is a placeholder; every row already rendered when it started
 * stays real for as long as it stays in the window, so the rows on screen, the one holding
 * focus and any selection are never swapped out. When the fling ends every row is real again.
 */
export class FlingRows {
  private readonly flinging = signal(false);

  /** Whether the list is flinging. */
  readonly active = this.flinging.asReadonly();

  /** Rows of the window shown as placeholders: none unless flinging. */
  readonly placeholderIds: Signal<ReadonlySet<string>>;

  constructor(
    private readonly enabled: () => boolean,
    windowIds: Signal<readonly string[]>,
  ) {
    this.placeholderIds = linkedSignal<
      { readonly flinging: boolean; readonly ids: readonly string[] },
      ReadonlySet<string>
    >({
      source: () => ({ flinging: this.flinging(), ids: windowIds() }),
      computation: ({ flinging, ids }, previous) => {
        if (!flinging || !previous) return NONE;
        // Real before: rendered last time and not a placeholder then.
        const before = previous.source.ids;
        const real = new Set(before.filter((id) => !previous.value.has(id)));
        const placeholders = new Set(ids.filter((id) => !real.has(id)));
        return placeholders.size ? placeholders : NONE;
      },
    });
  }

  /** The reader moved the list at `speed` px/s: start or end the fling. */
  moved(speed: number): void {
    if (!this.enabled()) {
      this.end();
    } else if (!this.flinging() && speed >= FLING_SPEED_PX_PER_S) {
      this.flinging.set(true);
    } else if (this.flinging() && speed < READING_SPEED_PX_PER_S) {
      this.flinging.set(false);
    }
  }

  /** End the fling, if any; true when one was under way. */
  end(): boolean {
    if (!this.flinging()) return false;
    this.flinging.set(false);
    return true;
  }
}
