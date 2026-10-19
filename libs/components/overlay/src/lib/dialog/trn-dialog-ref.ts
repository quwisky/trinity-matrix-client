import type { Observable } from 'rxjs';

/**
 * The two members of the vendor's ref this wraps, named structurally rather than imported.
 *
 * CDK's `DialogRef<R, C>` satisfies it for any component type `C`. This file then names no
 * vendor at all, so the seam a library swap has to reach is two methods wide.
 */
export interface ClosableRef<R> {
  readonly closed: Observable<R | undefined>;
  /** CDK's `DialogRef` carries it; `close()` itself ignores it, so callers that swipe must not. */
  readonly disableClose?: boolean;
  close(result?: R): void;
}

let nextTitleId = 0;

/** A document-unique id for a dialog's title heading. */
export function dialogTitleId(): string {
  return `trn-dialog-title-${nextTitleId++}`;
}

/**
 * How an open dialog is presented, decided once by {@link TrnDialogService.open}.
 *
 * `'sheet'` is a bottom sheet (phones, or an explicit `'bottom'` placement), `'popover'` an
 * anchored panel; the dialog shell reads it to pick its surface layout.
 */
export type TrnDialogPresentation =
  'dialog' | 'sheet' | 'fullscreen' | 'popover';

/**
 * The handle a dialog component uses to close itself, and the handle
 * {@link TrnDialogService.open} returns to whoever opened it.
 *
 * Trinity's own type rather than a re-exported CDK `DialogRef`, so `@angular/cdk` stays out of
 * feature signatures and the dialog library can be swapped without editing them.
 * `vendor-surface.spec.ts` asserts the barrel leaks nothing.
 *
 * Deliberately two methods wide: exposing more of CDK's `DialogRef` (`overlayRef`, `config`,
 * `componentInstance`, ...) would re-create the leak, since the next library will not have the
 * same members. Anything new should arrive as a named method on {@link TrnDialogService}, with
 * Trinity's semantics.
 *
 * A thin, stateless delegate. The dialog service provides the same wrapper to the component and
 * opener so either owner can use its vendor-neutral `isTopmost()` query.
 */
export class TrnDialogRef<R = unknown> {
  /**
   * Emits the value the dialog closed with — `undefined` when it was dismissed without
   * one — then completes.
   */
  readonly closed: Observable<R | undefined>;

  /**
   * Fixed at open. Crossing the `md` breakpoint later (rotating a phone, resizing a window)
   * keeps it, so an open dialog never jumps between a card and a sheet.
   */
  readonly presentation: TrnDialogPresentation;

  /**
   * The id the dialog shell gives its `h2`. The opener points the dialog container's
   * `aria-labelledby` at it, so the one dialog role is named by the visible title.
   */
  readonly titleId: string;

  /**
   * How far below the viewport top a top-anchored dialog opens; null when it is centred. The
   * shell shortens the card's height cap by this much, so its end stays on screen.
   */
  readonly blockStart: string | null;

  constructor(
    private readonly cdkRef: ClosableRef<R>,
    presentation: TrnDialogPresentation = 'dialog',
    titleId = dialogTitleId(),
    blockStart: string | null = null,
  ) {
    this.closed = cdkRef.closed;
    this.presentation = presentation;
    this.titleId = titleId;
    this.blockStart = blockStart;
  }

  /** Opened non-dismissible: no gesture may close it, only the flow itself. */
  get disableClose(): boolean {
    return this.cdkRef.disableClose ?? false;
  }

  /**
   * Close the dialog, optionally with a result for the opener.
   *
   * Without a result this is a dismissal: the opener's `dismissGuard` runs and may refuse,
   * exactly as for a backdrop click or Escape.
   *
   * Note this is the component closing ITSELF, which is always allowed: `disableClose`
   * governs dismissal the user did not ask for — a backdrop tap, Escape, the Android back
   * button — not the flow deciding it is finished. See `TrnDialogService.closeTopmost()`.
   */
  close(result?: R): void {
    this.cdkRef.close(result);
  }
}
