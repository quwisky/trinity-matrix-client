import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
} from '@angular/core';
import {
  VerificationService,
  type VerificationView,
} from '@trinity/data-access/crypto';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ENCRYPTION_DIALOG_COMPONENTS } from '@trinity/ui';
import { DialogRef, TrnDialogService } from '@trinity/helm/overlay';

/**
 * App-level, route-independent host for device verification. Incoming requests can
 * arrive on any route, so this owns `VerificationService.connect()` (once the
 * client is live) and presents the verification UI in a modal for any verification
 * except an outgoing *self*-verification — which the `/encryption/verify` route drives
 * itself. So the modal pops for incoming requests (self or cross-user) and for an
 * outgoing cross-user verification started from the member panel. Renders nothing.
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

    // Present the dialog for any verification the route doesn't own; dismiss when cleared.
    effect(() => {
      const shouldShow = this.shouldPresent(this.verification.active());
      if (shouldShow && !this.ref) {
        void this.present();
      } else if (!shouldShow && this.ref) {
        this.dismissModal();
      }
    });
  }

  /**
   * Whether the host should present `active` in a modal: any incoming request, or an
   * outgoing *cross-user* verification. An outgoing self-verification is excluded — the
   * `/encryption/verify` route drives that one, so the host must not double up.
   */
  private shouldPresent(active: VerificationView | null): boolean {
    return !!active && (active.incoming || !active.isSelfVerification);
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
      if (!this.shouldPresent(this.verification.active())) {
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
