import {
  DestroyRef,
  Directive,
  ElementRef,
  InjectionToken,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { Dialog } from '@angular/cdk/dialog';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import {
  DISMISS_FRACTION,
  FLING_MIN_DISTANCE,
  FLING_VELOCITY,
  SHEET_LARGE_HEIGHT,
  SHEET_MEDIUM_HEIGHT,
  nextDetent,
  type SheetDetentHeights,
  type TrnSheetDetent,
} from '../sheet-frame/sheet-detent';

/** Dismisses the surrounding sheet; returns whether it actually closed (a guard may refuse). */
export const TRN_SHEET_DISMISS = new InjectionToken<() => boolean>(
  'TRN_SHEET_DISMISS',
);

/**
 * Builds a {@link TRN_SHEET_DISMISS} function for a ref: it refuses a `disableClose` dialog,
 * calls `close()`, and reports whether the dialog left the CDK stack. A refused `dismissGuard`
 * keeps it there; `close()` splices it out synchronously otherwise (see `closeTopmost()`).
 */
export function sheetDismissFor(
  ref: { readonly disableClose?: boolean; close(): void },
  dialog: Pick<Dialog, 'openDialogs'>,
): () => boolean {
  return () => {
    if (ref.disableClose) return false;
    const before = dialog.openDialogs.length;
    ref.close();
    return dialog.openDialogs.length < before;
  };
}

/** A touch must travel this far (px) before it is judged a pull on the sheet or not. */
const CLAIM_SLOP = 6;
/** A scroll this recent (ms) means the touch landed on a scroller still coasting. */
const MOMENTUM_MS = 120;
/** Controls and surfaces that keep their own drag; the handle bar is covered by its own pointer path. */
const OWN_GESTURE =
  'input, textarea, select, [contenteditable], [role="slider"], canvas, pre, code, [data-trn-sheet-no-drag], [data-trn-sheet-handle]';
/** How each detent rests: `medium` at its content's height up to half the screen. */
const RESTING = {
  medium: {
    height: 'auto',
    max: `min(${SHEET_MEDIUM_HEIGHT}, ${SHEET_LARGE_HEIGHT})`,
  },
  large: { height: SHEET_LARGE_HEIGHT, max: SHEET_LARGE_HEIGHT },
} as const satisfies Record<TrnSheetDetent, { height: string; max: string }>;

interface SheetFollow {
  move(y: number): void;
  end(y: number, t: number, cancelled: boolean): void;
}

/**
 * The sheet surface that follows a drag started on a {@link TrnSheetDragHandle}. A sheet opened
 * with `detents` snaps between them below `md`, its height in `--trn-sheet-height`.
 */
@Directive({
  selector: '[trnSheetDrag]',
  host: {
    '[attr.data-sheet-detent]': 'detent()',
    '[style.--trn-sheet-height]': 'resting()?.height ?? null',
    '[style.--trn-sheet-max-height]': 'resting()?.max ?? null',
  },
})
export class TrnSheetDrag {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly dismiss = inject(TRN_SHEET_DISMISS);
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly detents = this.ref?.detents ?? [];
  private readonly rest = signal<TrnSheetDetent>(
    this.detents.includes(this.ref?.initialDetent ?? 'medium')
      ? (this.ref?.initialDetent ?? 'medium')
      : (this.detents[0] ?? 'medium'),
  );
  private readonly phone = mediaQuerySignal(BELOW_MD_QUERY, inject(DestroyRef));
  /** Content that fits inside `medium` rests at its own height and offers no `large`. */
  private readonly fits = signal(false);
  private readonly offered = computed(() =>
    this.fits() && this.detents.includes('medium')
      ? (['medium'] as const)
      : this.detents,
  );
  private stopDrag: (() => void) | null = null;
  private lastScroll = -Infinity;
  private unsnap: ReturnType<typeof setTimeout> | undefined;
  /** The click that ends a drag on the handle button is not a toggle. */
  private dragged = false;
  private undrag: ReturnType<typeof setTimeout> | undefined;
  /** Whether the content has been measured once, whatever the detent it opened at. */
  private measured = false;

  protected readonly resting = computed(() => {
    const detent = this.detent();
    return detent ? RESTING[detent] : null;
  });

  /** `[trnSheetDrag]="false"` turns the drag off, e.g. for a centred dialog. */
  readonly enabled = input(true, {
    alias: 'trnSheetDrag',
    transform: booleanAttribute,
  });
  /** On unless turned off, and never for a sheet its dialog opened `disableClose`. */
  readonly active = computed(() => this.enabled() && !this.ref?.disableClose);
  /** The height the sheet rests at; null without detents or at `md` and wider. */
  readonly detent: Signal<TrnSheetDetent | null> = computed(() =>
    this.detents.length && this.phone() ? this.rest() : null,
  );
  /** What the handle button does: grow to `large`, shrink to `medium`, or nothing. */
  readonly toggleable: Signal<'expand' | 'collapse' | null> = computed(() => {
    const detent = this.detent();
    if (!detent || !this.active() || this.offered().length < 2) return null;
    return detent === 'medium' ? 'expand' : 'collapse';
  });

  constructor() {
    // Scroll events do not bubble, so a capturing listener sees every scroller in the sheet.
    const scrolled = () => (this.lastScroll = performance.now());
    const start = (e: TouchEvent) => this.beginContent(e);
    this.host.addEventListener('scroll', scrolled, {
      capture: true,
      passive: true,
    });
    this.host.addEventListener('touchstart', start, { passive: true });
    const observer =
      this.detents.length && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => this.measureFit())
        : null;
    observer?.observe(this.host);
    // Crossing `md` mid-drag or mid-snap leaves no inline geometry for the other layout.
    effect(() => {
      this.phone();
      untracked(() => {
        this.release();
        this.keepFocus();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      clearTimeout(this.unsnap);
      clearTimeout(this.undrag);
      this.stopDrag?.();
      this.host.removeEventListener('scroll', scrolled, { capture: true });
      this.host.removeEventListener('touchstart', start);
    });
  }

  /** Rests the sheet at `detent`, if it offers it. */
  setDetent(detent: TrnSheetDetent): void {
    if (!this.offered().includes(detent)) return;
    this.rest.set(detent);
    // Written now as well as by the bindings, so a release springs to it in the same frame
    // and a drag's own cap is replaced.
    if (this.detent()) {
      this.host.style.setProperty('--trn-sheet-height', RESTING[detent].height);
      this.host.style.setProperty(
        '--trn-sheet-max-height',
        RESTING[detent].max,
      );
    }
  }

  /** The handle button: springs to the other detent, unless the press was a drag. */
  toggle(): void {
    const detent = this.detent();
    if (this.dragged || !detent || !this.toggleable()) return;
    this.snap(detent === 'medium' ? 'large' : 'medium');
  }

  /**
   * Springs a `medium` sheet that offers `large`, e.g. for the keyboard; unlike the handle,
   * also when it cannot be dragged (`disableClose`).
   */
  expand(): void {
    if (this.detent() === 'medium' && this.offered().includes('large')) {
      this.snap('large');
    }
  }

  begin(event: PointerEvent): void {
    if (!this.active() || event.button !== 0) return;
    this.stopDrag?.();
    const id = event.pointerId;
    const drag = this.follow(event.clientY, event.timeStamp);
    const move = (e: PointerEvent) =>
      e.pointerId === id && drag.move(e.clientY);
    const up = (e: PointerEvent) =>
      e.pointerId === id && drag.end(e.clientY, e.timeStamp, false);
    const cancel = (e: PointerEvent) =>
      e.pointerId === id && drag.end(e.clientY, e.timeStamp, true);

    // On the handle button, so the click that ends a tap still reaches it.
    const capture =
      (event.target as Element | null)?.closest('[data-trn-sheet-toggle]') ??
      (event.currentTarget as Element | null);
    try {
      capture?.setPointerCapture?.(id);
    } catch {
      // No active pointer to capture (synthetic events); document listeners still track it.
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    this.stopDrag = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      try {
        capture?.releasePointerCapture?.(id);
      } catch {
        // Already released.
      }
      this.stopDrag = null;
    };
  }

  /**
   * Moves the sheet with the finger from `startY`; `end` springs back or dismisses. The handle
   * and the content drag share it, so thresholds, spring and a refused guard behave alike.
   */
  private follow(startY: number, startT: number): SheetFollow {
    const detent = this.detent();
    if (detent) return this.followDetent(detent, startY, startT);
    const height = this.host.getBoundingClientRect().height || 1;
    const offset = (y: number) => Math.max(0, y - startY);
    this.host.style.transition = 'none';
    return {
      move: (y: number) => {
        this.host.style.transform = `translateY(${offset(y)}px)`;
      },
      end: (y: number, t: number, cancelled: boolean) => {
        const dy = offset(y);
        const velocity = dy / Math.max(1, t - startT);
        this.stopDrag?.();
        this.host.style.transition =
          'transform var(--trinity-duration-base) ease-out';
        const far =
          dy / height > DISMISS_FRACTION ||
          (dy > FLING_MIN_DISTANCE && velocity > FLING_VELOCITY);
        if (!cancelled && far && this.dismiss()) return;
        this.host.style.transform = '';
      },
    };
  }

  /**
   * Above the half-height the sheet grows and shrinks with the finger; below it, it slides down
   * as a content-sized sheet does. Release snaps to {@link nextDetent}'s pick.
   */
  private followDetent(
    detent: TrnSheetDetent,
    startY: number,
    startT: number,
  ): SheetFollow {
    const heights = this.grab();
    const available = this.offered();
    const floor = Math.min(heights.start, heights.medium);
    return {
      move: (y: number) => {
        const next = heights.start - (y - startY);
        this.host.style.height = `${Math.max(floor, next)}px`;
        this.host.style.transform =
          next < floor ? `translateY(${floor - next}px)` : '';
      },
      end: (y: number, t: number, cancelled: boolean) => {
        const dy = y - startY;
        const next = nextDetent(
          detent,
          dy,
          dy / Math.max(1, t - startT),
          available,
          heights,
        );
        this.stopDrag?.();
        if (Math.abs(dy) >= CLAIM_SLOP) {
          this.dragged = true;
          clearTimeout(this.undrag);
          this.undrag = setTimeout(() => (this.dragged = false));
        }
        if (cancelled) {
          this.settle(detent, heights);
        } else if (next !== 'dismiss') {
          this.settle(next, heights);
        } else if (!this.dismiss()) {
          // A refused close rests at the lowest height, never where the finger let go.
          this.settle(
            available.includes('medium') ? 'medium' : 'large',
            heights,
          );
        }
      },
    };
  }

  /**
   * Stops a snap where the sheet is, holds it there in px and measures what it can snap to,
   * under the full-height cap the drag may grow to.
   */
  private grab(): SheetDetentHeights {
    // Read before the transition is stopped, so a sheet grabbed mid-settle starts where it is.
    const start = this.host.getBoundingClientRect().height;
    clearTimeout(this.unsnap);
    this.host.style.transition = 'none';
    this.host.style.setProperty('--trn-sheet-max-height', SHEET_LARGE_HEIGHT);
    const content = this.measure('auto');
    const heights = {
      start,
      medium: Math.min(content, this.measure(SHEET_MEDIUM_HEIGHT)),
      large: this.measure(SHEET_LARGE_HEIGHT),
    };
    this.host.style.height = `${start}px`;
    return heights;
  }

  /** The rendered height of `height` on this sheet, inside its own cap. */
  private measure(height: string): number {
    this.host.style.height = height;
    return this.host.getBoundingClientRect().height;
  }

  /** Springs to `detent`'s measured height, then hands the height back to the bindings. */
  private settle(detent: TrnSheetDetent, heights: SheetDetentHeights): void {
    this.setDetent(detent);
    this.host.style.transition =
      'transform var(--trinity-duration-base) ease-out, height var(--trinity-duration-base) ease-out';
    // In px: `medium` rests at `auto`, which does not animate.
    this.host.style.height = `${heights[detent]}px`;
    this.host.style.transform = '';
    // The height transition is the snap's only; a later rotation or keyboard resizes at once.
    // A timer, not an end event: under Reduce Motion no transition runs to end.
    const seconds = parseFloat(getComputedStyle(this.host).transitionDuration);
    clearTimeout(this.unsnap);
    this.unsnap = setTimeout(
      () => {
        this.host.style.transition = '';
        this.host.style.height = '';
      },
      (seconds || 0) * 1000,
    );
  }

  private snap(detent: TrnSheetDetent): void {
    const heights = this.grab();
    this.host.getBoundingClientRect(); // commits the start height, so the snap animates from it
    this.settle(detent, heights);
  }

  /** Drops a drag or snap in flight and its inline geometry. */
  private release(): void {
    this.stopDrag?.();
    clearTimeout(this.unsnap);
    this.host.style.transition = '';
    this.host.style.height = '';
    this.host.style.transform = '';
  }

  /**
   * Content shorter than `medium` offers only `medium`. Re-measured at rest at `medium`; at
   * `large` only once, so a sheet opened there is not taller than its content, while one the
   * person or the keyboard raised does not drop when its content shrinks.
   */
  private measureFit(): void {
    const detent = this.detent();
    if (!detent || this.host.style.height) return;
    if (detent === 'large' && this.measured) return;
    this.measured = true;
    const content = this.measure('auto');
    const fits = content + 1 < this.measure(SHEET_MEDIUM_HEIGHT);
    this.host.style.height = '';
    if (fits && this.toggleable()) this.keepFocus();
    this.fits.set(fits);
    if (fits) this.setDetent('medium');
  }

  /** Moves focus off the handle button before it is removed, onto the labelled dialog. */
  private keepFocus(): void {
    const active = this.host.ownerDocument.activeElement;
    if (
      active?.hasAttribute('data-trn-sheet-toggle') &&
      this.host.contains(active)
    ) {
      this.host.closest<HTMLElement>('[role="dialog"]')?.focus();
    }
  }

  private beginContent(event: TouchEvent): void {
    const touch = event.touches[0];
    if (
      !this.active() ||
      event.touches.length !== 1 ||
      !touch ||
      !this.contentCanDrag(event.target as Element | null)
    ) {
      return;
    }
    // Scrolled content only grows a `medium` sheet; a downward pull on it scrolls the content.
    const atTop = !scrolledDown(event.target as Element, this.host);
    if (!atTop && this.toggleable() !== 'expand') return;
    this.stopDrag?.();
    const { clientX: x0, clientY: y0 } = touch;
    // Decided once, on the first move past the slop: a vertical pull the sheet can follow
    // claims the gesture, anything else is left to native scrolling and the controls inside.
    let drag: SheetFollow | null = null;
    let decided = false;
    let lastY = y0;

    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lastY = t.clientY;
      if (!decided) {
        const dx = t.clientX - x0;
        const dy = t.clientY - y0;
        if (Math.hypot(dx, dy) < CLAIM_SLOP) return;
        decided = true;
        // Up only grows a `medium` sheet that can; at `large` it scrolls the content.
        const grows = this.toggleable() === 'expand';
        if (
          Math.abs(dx) > Math.abs(dy) ||
          (dy < 0 && !grows) ||
          (dy > 0 && !atTop) ||
          !e.cancelable
        ) {
          return stop();
        }
        drag = this.follow(y0, event.timeStamp);
      }
      e.preventDefault();
      drag?.move(t.clientY);
    };
    const end = (e: TouchEvent) => {
      const claimed = drag;
      stop();
      claimed?.end(lastY, e.timeStamp, e.type === 'touchcancel');
    };
    const options = { passive: false } as const;
    const stop = () => {
      this.host.removeEventListener('touchmove', move);
      this.host.removeEventListener('touchend', end);
      this.host.removeEventListener('touchcancel', end);
      this.stopDrag = null;
    };
    this.host.addEventListener('touchmove', move, options);
    this.host.addEventListener('touchend', end);
    this.host.addEventListener('touchcancel', end);
    this.stopDrag = stop;
  }

  /** Content may pull the sheet unless it is coasting or something inside owns the gesture. */
  private contentCanDrag(target: Element | null): boolean {
    if (!target || target.closest(OWN_GESTURE)) return false;
    if (performance.now() - this.lastScroll < MOMENTUM_MS) return false;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return false;
    for (let el: Element | null = target; el;) {
      const style = getComputedStyle(el);
      if (
        /^(none|pan-x)$/.test(style.touchAction) ||
        (el.scrollWidth > el.clientWidth && /auto|scroll/.test(style.overflowX))
      ) {
        return false;
      }
      el = el === this.host ? null : el.parentElement;
    }
    return true;
  }
}

/** Whether `target` or a scroller around it, up to `host`, is scrolled away from its top. */
function scrolledDown(target: Element, host: Element): boolean {
  for (
    let el: Element | null = target;
    el;
    el = el === host ? null : el.parentElement
  ) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

/** The part of a sheet (grab handle, header) that starts a drag. */
@Directive({
  selector: '[trnSheetDragHandle]',
  host: {
    '(pointerdown)': 'start($event)',
    'data-trn-sheet-handle': '',
    '[style.touch-action]': 'sheet?.active() ? "none" : null',
    '[style.user-select]': 'sheet?.active() ? "none" : null',
  },
})
export class TrnSheetDragHandle {
  protected readonly sheet = inject(TrnSheetDrag, { optional: true });

  protected start(event: PointerEvent): void {
    // A header control (the close X) keeps its own press; capturing would retarget its click.
    // The handle button is the exception: it toggles on a click and drags on a press.
    const control = (event.target as Element | null)?.closest(
      'button, a, input',
    );
    if (control && !control.hasAttribute('data-trn-sheet-toggle')) return;
    this.sheet?.begin(event);
  }
}
