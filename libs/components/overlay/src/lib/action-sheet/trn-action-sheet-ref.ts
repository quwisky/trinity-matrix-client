import type { Observable } from 'rxjs';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';

/**
 * Handle for one action-sheet invocation.
 *
 * The surface belongs here rather than on the generic dialog ref: action sheets are the
 * only overlay whose physical edge participates in feature layout. Keeping that capability
 * specific prevents feature code from depending on CDK pane internals or guessing which
 * global overlay is the one it opened.
 */
export class TrnActionSheetRef {
  readonly closed: Observable<void | undefined>;

  constructor(
    private readonly dialogRef: TrnDialogRef<void>,
    private readonly resolveSurface: () => HTMLElement | null,
  ) {
    this.closed = dialogRef.closed;
  }

  /** The concrete box for this invocation, once Angular has rendered it. */
  get surface(): HTMLElement | null {
    return this.resolveSurface();
  }

  close(): void {
    this.dialogRef.close();
  }
}
