import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ErrorHandler,
  effect,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ENCRYPTION_DIALOG_COMPONENTS } from '../application-dialog-loaders';
import {
  TrustVerificationService,
  type VerificationView,
} from '@trinity/data-access/trust';
import {
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import { defer, finalize, take } from 'rxjs';

/** Route-independent presentation host for incoming and cross-user verification. */
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
  private readonly dialogComponents = inject(ENCRYPTION_DIALOG_COMPONENTS, {
    optional: true,
  });
  private ref: TrnDialogRef<void> | null = null;
  private presenting = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.dismissModal());
    effect(() => {
      const shouldShow = this.shouldPresent(this.verification.active());
      if (shouldShow && !this.ref) {
        this.present();
      } else if (!shouldShow && this.ref) {
        this.dismissModal();
      }
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
          if (!this.shouldPresent(this.verification.active())) return;
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
