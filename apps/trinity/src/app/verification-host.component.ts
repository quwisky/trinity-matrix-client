import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
} from '@angular/core';
import type { DialogRef } from '@angular/cdk/dialog';
import { MatrixClientService, VerificationService } from '@trinity/core';
import { TrnDialogService } from '@trinity/helm/overlay';

/**
 * App-level, route-independent host for device verification. Incoming requests can
 * arrive on any route, so this owns `VerificationService.connect()` (once the
 * client is live) and presents the verification UI in a modal when *another*
 * device asks to verify. Self-initiated verification uses the `/encryption/verify`
 * route instead, so we only pop the modal for incoming requests. Renders nothing.
 */
@Component({
  selector: 'trn-verification-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class VerificationHostComponent {
  private readonly matrix = inject(MatrixClientService);
  private readonly verification = inject(VerificationService);
  private readonly dialog = inject(TrnDialogService);
  private ref: DialogRef<void, unknown> | null = null;
  /** Synchronous in-flight guard: `ref` is only set after the lazy import, so
   * without this a second effect run during the import opens a second modal. */
  private presenting = false;

  constructor() {
    // Connect once the client is live; `connect()` is idempotent and instance-keyed
    // so it safely no-ops until ready and rewires after a re-login.
    effect(() => {
      if (this.matrix.syncState()) {
        this.verification.connect();
      }
    });

    // Present the dialog for an incoming request; dismiss once it's cleared.
    effect(() => {
      const active = this.verification.active();
      const shouldShow = !!active && active.incoming;
      if (shouldShow && !this.ref) {
        void this.present();
      } else if (!shouldShow && this.ref) {
        this.dismissModal();
      }
    });
  }

  private async present(): Promise<void> {
    if (this.ref || this.presenting) {
      return;
    }
    this.presenting = true;
    try {
      // Lazy-load the verification UI so feature-crypto stays out of the main
      // bundle until an incoming request actually needs it.
      const { DeviceVerificationPage } =
        await import('@trinity/feature-crypto');
      // The request may have been cleared while the chunk was loading.
      if (!this.verification.active()?.incoming) {
        return;
      }
      // disableClose: the page owns teardown so a backdrop/escape tap can't leave
      // an in-flight verification dangling.
      const ref = this.dialog.open<void, unknown>(DeviceVerificationPage, {
        inputs: { asModal: true },
        disableClose: true,
      });
      this.ref = ref;
      ref.closed.subscribe(() => (this.ref = null));
    } finally {
      this.presenting = false;
    }
  }

  private dismissModal(): void {
    const ref = this.ref;
    this.ref = null;
    ref?.close();
  }
}
