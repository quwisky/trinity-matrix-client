import {
  DestroyRef,
  Directive,
  ElementRef,
  InjectionToken,
  booleanAttribute,
  inject,
  input,
} from '@angular/core';
import type { Dialog } from '@angular/cdk/dialog';

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

/** The sheet surface that follows a drag started on a {@link TrnSheetDragHandle}. */
@Directive({ selector: '[trnSheetDrag]' })
export class TrnSheetDrag {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly dismiss = inject(TRN_SHEET_DISMISS);
  private stopDrag: (() => void) | null = null;

  /** `[trnSheetDrag]="false"` turns the drag off, e.g. for a centred dialog. */
  readonly enabled = input(true, {
    alias: 'trnSheetDrag',
    transform: booleanAttribute,
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopDrag?.());
  }

  begin(event: PointerEvent): void {
    if (!this.enabled() || event.button !== 0) return;
    this.stopDrag?.();
    const startY = event.clientY;
    const startT = event.timeStamp;
    const height = this.host.getBoundingClientRect().height || 1;
    const offset = (e: PointerEvent) => Math.max(0, e.clientY - startY);
    this.host.style.transition = 'none';

    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      this.host.style.transform = `translateY(${offset(e)}px)`;
    };
    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== event.pointerId) return;
      const dy = offset(e);
      const velocity = dy / Math.max(1, e.timeStamp - startT);
      this.stopDrag?.();
      this.host.style.transition = 'transform 200ms ease-out';
      const far = dy / height > DISMISS_FRACTION || velocity > FLING_VELOCITY;
      if (!cancelled && far && this.dismiss()) return;
      this.host.style.transform = '';
    };
    const up = (e: PointerEvent) => finish(e, false);
    const cancel = (e: PointerEvent) => finish(e, true);

    const capture = event.currentTarget as Element | null;
    try {
      capture?.setPointerCapture?.(event.pointerId);
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
        capture?.releasePointerCapture?.(event.pointerId);
      } catch {
        // Already released.
      }
      this.stopDrag = null;
    };
  }
}

/** The part of a sheet (grab handle, header) that starts a drag. */
@Directive({
  selector: '[trnSheetDragHandle]',
  host: {
    '(pointerdown)': 'start($event)',
    '[style.touch-action]': 'sheet?.enabled() ? "none" : null',
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
