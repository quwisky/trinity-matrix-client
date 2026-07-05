import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
} from '@angular/core';
import type { DialogRef } from '@angular/cdk/dialog';
import { VerificationService } from '@trinity/data-access-crypto';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { ENCRYPTION_DIALOG_COMPONENTS } from '@trinity/ui';
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
  // App-provided lazy loader (main.ts) for the verification modal page — reuses
  // the encryption-dialog seam so this feature lib never imports feature-crypto.
  // Optional: absent in ui-in-isolation / tests with no app wiring.
  private readonly dialogComponents = inject(ENCRYPTION_DIALOG_COMPONENTS, {
    optional: true,
  });
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
    const loadPage = this.dialogComponents?.verify;
    if (!loadPage) {
      return; // no app wiring — nothing to present (e.g. ui-only test contexts)
    }
    this.presenting = true;
    try {
      // Lazy-load the verification UI (via the app-provided loader) so
      // feature-crypto stays out of the main bundle until actually needed.
      const DeviceVerificationPage = await loadPage();
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
