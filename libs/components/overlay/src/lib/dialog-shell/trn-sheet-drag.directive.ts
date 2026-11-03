import {
  DestroyRef,
  Directive,
  ElementRef,
  InjectionToken,
  booleanAttribute,
  computed,
  inject,
  input,
} from '@angular/core';
import type { Dialog } from '@angular/cdk/dialog';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';

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

const DISMISS_FRACTION = 0.25;
/** px per ms */
const FLING_VELOCITY = 0.5;
/** A fling must also travel this far (px), so a twitch never closes the sheet. */
const FLING_MIN_DISTANCE = 24;

/** A touch must travel this far (px) before it is judged a pull on the sheet or not. */
const CLAIM_SLOP = 6;
/** A scroll this recent (ms) means the touch landed on a scroller still coasting. */
const MOMENTUM_MS = 120;
/** Controls and surfaces that keep their own drag; the handle bar is covered by its own pointer path. */
const OWN_GESTURE =
  'input, textarea, select, [contenteditable], [role="slider"], canvas, pre, code, [data-trn-sheet-no-drag], [data-trn-sheet-handle]';

interface SheetFollow {
  move(y: number): void;
  end(y: number, t: number, cancelled: boolean): void;
}

/** The sheet surface that follows a drag started on a {@link TrnSheetDragHandle}. */
@Directive({ selector: '[trnSheetDrag]' })
export class TrnSheetDrag {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly dismiss = inject(TRN_SHEET_DISMISS);
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private stopDrag: (() => void) | null = null;
  private lastScroll = -Infinity;

  /** `[trnSheetDrag]="false"` turns the drag off, e.g. for a centred dialog. */
  readonly enabled = input(true, {
    alias: 'trnSheetDrag',
    transform: booleanAttribute,
  });
  /** On unless turned off, and never for a sheet its dialog opened `disableClose`. */
  readonly active = computed(() => this.enabled() && !this.ref?.disableClose);

  constructor() {
    // Scroll events do not bubble, so a capturing listener sees every scroller in the sheet.
    const scrolled = () => (this.lastScroll = performance.now());
    const start = (e: TouchEvent) => this.beginContent(e);
    this.host.addEventListener('scroll', scrolled, {
      capture: true,
      passive: true,
    });
    this.host.addEventListener('touchstart', start, { passive: true });
    inject(DestroyRef).onDestroy(() => {
      this.stopDrag?.();
      this.host.removeEventListener('scroll', scrolled, { capture: true });
      this.host.removeEventListener('touchstart', start);
    });
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

    const capture = event.currentTarget as Element | null;
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
        this.host.style.transition = 'transform 200ms ease-out';
        const far =
          dy / height > DISMISS_FRACTION ||
          (dy > FLING_MIN_DISTANCE && velocity > FLING_VELOCITY);
        if (!cancelled && far && this.dismiss()) return;
        this.host.style.transform = '';
      },
    };
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
    this.stopDrag?.();
    const { clientX: x0, clientY: y0 } = touch;
    // Decided once, on the first move past the slop: a downward pull claims the gesture,
    // anything else leaves it to native scrolling and the controls inside the sheet.
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
        if (dy <= 0 || Math.abs(dx) > dy || !e.cancelable) return stop();
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

  /** Only content resting at its top, with nothing inside that owns the gesture, may pull the sheet. */
  private contentCanDrag(target: Element | null): boolean {
    if (!target || target.closest(OWN_GESTURE)) return false;
    if (performance.now() - this.lastScroll < MOMENTUM_MS) return false;
    if (!window.getSelection()?.isCollapsed) return false;
    for (let el: Element | null = target; el && el !== this.host;) {
      const style = getComputedStyle(el);
      if (
        el.scrollTop > 0 ||
        /^(none|pan-x)/.test(style.touchAction) ||
        (el.scrollWidth > el.clientWidth && /auto|scroll/.test(style.overflowX))
      ) {
        return false;
      }
      el = el.parentElement;
    }
    return true;
  }
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
    if ((event.target as Element | null)?.closest('button, a, input')) return;
    this.sheet?.begin(event);
  }
}
