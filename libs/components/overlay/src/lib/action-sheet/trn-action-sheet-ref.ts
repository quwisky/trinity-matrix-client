import { Subject, type Observable } from 'rxjs';
import type {
  TrnDialogPresentation,
  TrnDialogRef,
} from '../dialog/trn-dialog-ref';

/**
 * Handle for one action-sheet invocation.
 *
 * The surface belongs here rather than on the generic dialog ref: action sheets are the
 * only overlay whose physical edge participates in feature layout. Keeping that capability
 * specific prevents feature code from depending on CDK pane internals or guessing which
 * global overlay is the one it opened.
 *
 * The handle exists before its list does: the list's code loads on first use, so the opener
 * can close an invocation that has not appeared yet, and it then never appears.
 */
export class TrnActionSheetRef {
  private readonly closedSubject = new Subject<void>();
  private dialogRef: TrnDialogRef<void> | null = null;
  private resolveSurface: () => HTMLElement | null = () => null;
  private ended = false;

  /** Emits once and completes when the list closes, or is closed before it appeared. */
  readonly closed: Observable<void | undefined> =
    this.closedSubject.asObservable();

  constructor(
    /** A `'sheet'`, or a `'popover'` menu beside its button; fixed at open. */
    readonly presentation: TrnDialogPresentation,
  ) {}

  /** The concrete box for this invocation, once Angular has rendered it. */
  get surface(): HTMLElement | null {
    return this.resolveSurface();
  }

  /** @internal Whether this invocation ended, so a list that arrives late is not shown. */
  get isClosed(): boolean {
    return this.ended;
  }

  /** @internal Binds the handle to the list that opened for it. */
  attach(
    dialogRef: TrnDialogRef<void>,
    resolveSurface: () => HTMLElement | null,
  ): void {
    this.dialogRef = dialogRef;
    this.resolveSurface = resolveSurface;
    dialogRef.closed.subscribe({ complete: () => this.finish() });
  }

  close(): void {
    if (this.dialogRef) this.dialogRef.close();
    else this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.closedSubject.next();
    this.closedSubject.complete();
  }
}
