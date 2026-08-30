import type { Observable } from 'rxjs';

/**
 * The two members of the vendor's ref this wraps, named structurally rather than imported.
 *
 * CDK's `DialogRef<R, C>` satisfies it for any component type `C`, which is what lets
 * `open()` hand one straight in; more to the point, this file then names no vendor at all,
 * so the seam a swap has to reach is two methods wide and stated here.
 */
interface ClosableRef<R> {
  readonly closed: Observable<R | undefined>;
  close(result?: R): void;
}

/**
 * The handle a modal'd component uses to close itself, and the handle {@link TrnDialogService.open}
 * returns to whoever opened it.
 *
 * Trinity's own type rather than a re-exported CDK `DialogRef`, which is what this
 * replaced. The barrel used to hand out the vendor class — one deliberate, documented
 * export — and that single line put `@angular/cdk` in the type signature of 24 feature
 * components. It made the boundary's own premise false: swapping the dialog library
 * would have meant editing every one of them, which is the cost the wrapper exists to
 * remove. `vendor-surface.spec.ts` now asserts the barrel leaks nothing at all.
 *
 * Deliberately two methods wide. CDK's `DialogRef` carries `overlayRef`, `config`,
 * `componentInstance`, `keydownEvents`, `updatePosition` and more; exposing them would
 * re-create the leak in a different shape, since the next library will not have the same
 * ones. Everything the app actually used is here — 51 `close()` calls and one `closed`
 * subscription — and anything genuinely new should arrive as a named method on
 * {@link TrnDialogService}, where it can be given Trinity's semantics.
 *
 * A thin, stateless delegate: two instances wrapping the same CDK ref close identically. The
 * service does retain the specific handle returned by `open()` for its vendor-neutral
 * `isTopmost()` query, so callers of that query pass the returned handle rather than an injected
 * sibling wrapper.
 */
export class TrnDialogRef<R = unknown> {
  /**
   * Emits the value the dialog closed with — `undefined` when it was dismissed without
   * one — then completes.
   */
  readonly closed: Observable<R | undefined>;

  constructor(private readonly cdkRef: ClosableRef<R>) {
    this.closed = cdkRef.closed;
  }

  /**
   * Close the dialog, optionally with a result for the opener.
   *
   * Note this is the component closing ITSELF, which is always allowed: `disableClose`
   * governs dismissal the user did not ask for — a backdrop tap, Escape, the Android back
   * button — not the flow deciding it is finished. See `TrnDialogService.closeTopmost()`.
   */
  close(result?: R): void {
    this.cdkRef.close(result);
  }
}
