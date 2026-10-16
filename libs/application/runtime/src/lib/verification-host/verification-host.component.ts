import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ErrorHandler,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ENCRYPTION_DIALOG_COMPONENTS } from '../application-dialog-loaders';
import { AppLockDialogGate } from '../composition/app-lock-dialog.gate';
import {
  TrustVerificationService,
  type VerificationView,
} from '@trinity/data-access/trust';
import {
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import { defer, finalize, take } from 'rxjs';

/**
 * Route-independent presentation host for incoming and cross-user verification. A request
 * that arrives while App lock covers the app waits for unlock; one that is cancelled or
 * times out while it waits is dropped unseen.
 */
@Component({
  selector: 'trn-verification-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class VerificationHostComponent {
  private readonly verification = inject(TrustVerificationService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly errors = inject(ErrorHandler);
  private readonly gate = inject(AppLockDialogGate);
  private readonly dialogComponents = inject(ENCRYPTION_DIALOG_COMPONENTS, {
    optional: true,
  });
  private ref: TrnDialogRef<void> | null = null;
  private presenting = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.dismissModal());
    effect(() => {
      const active = this.verification.active();
      const clear = this.gate.clear();
      const shouldShow = this.shouldPresent(active);
      untracked(() => {
        if (!shouldShow) {
          if (this.ref) this.dismissModal();
          return;
        }
        if (this.ref || this.presenting) return;
        // Nobody saw it, and there is nothing left to answer: let it go.
        if (active && ended(active)) {
          this.verification.dismiss();
          return;
        }
        if (clear) this.present();
      });
    });
  }

  private shouldPresent(active: VerificationView | null): boolean {
    return !!active && (active.incoming || !active.isSelfVerification);
  }

  private present(): void {
    if (this.ref || this.presenting) return;
    const loadPage = this.dialogComponents?.verify;
    if (!loadPage) return;
    this.presenting = true;
    defer(loadPage)
      .pipe(
        take(1),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => (this.presenting = false)),
      )
      .subscribe({
        next: (DeviceVerificationPage) => {
          const active = this.verification.active();
          if (!active || !this.shouldPresent(active)) return;
          if (ended(active)) {
            this.verification.dismiss();
            return;
          }
          // Locked while the page loaded: the effect opens it once the gate clears.
          if (!this.gate.clear()) return;
          const ref = this.dialog.open<void, unknown>(DeviceVerificationPage, {
            inputs: { asModal: true },
            disableClose: true,
          });
          this.ref = ref;
          ref.closed
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              if (this.ref === ref) this.ref = null;
            });
        },
        error: (error: unknown) => this.errors.handleError(error),
      });
  }

  private dismissModal(): void {
    const ref = this.ref;
    this.ref = null;
    ref?.close();
  }
}

/** The request was cancelled, timed out or finished elsewhere. */
function ended(active: VerificationView): boolean {
  return active.stage === 'cancelled' || active.stage === 'done';
}
