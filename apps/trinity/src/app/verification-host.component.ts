import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
} from '@angular/core';
import { ModalController } from '@ionic/angular/standalone';
import { MatrixClientService, VerificationService } from '@trinity/core';

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
  private readonly modalCtrl = inject(ModalController);
  private modal: HTMLIonModalElement | null = null;

  constructor() {
    // Connect once the client is live; `connect()` is idempotent and instance-keyed
    // so it safely no-ops until ready and rewires after a re-login.
    effect(() => {
      if (this.matrix.syncState()) {
        this.verification.connect();
      }
    });

    // Present the modal for an incoming request; dismiss once it's cleared.
    effect(() => {
      const active = this.verification.active();
      const shouldShow = !!active && active.incoming;
      if (shouldShow && !this.modal) {
        void this.present();
      } else if (!shouldShow && this.modal) {
        void this.dismissModal();
      }
    });
  }

  private async present(): Promise<void> {
    if (this.modal) {
      return;
    }
    // Lazy-load the verification UI so feature-crypto stays out of the main
    // bundle until an incoming request actually needs it.
    const { DeviceVerificationPage } = await import('@trinity/feature-crypto');
    const modal = await this.modalCtrl.create({
      component: DeviceVerificationPage,
      componentProps: { asModal: true },
      backdropDismiss: false,
    });
    // The request may have been cleared while the modal was being created.
    if (!this.verification.active()?.incoming) {
      await modal.dismiss();
      return;
    }
    this.modal = modal;
    void modal.onDidDismiss().then(() => (this.modal = null));
    await modal.present();
  }

  private async dismissModal(): Promise<void> {
    const modal = this.modal;
    this.modal = null;
    await modal?.dismiss();
  }
}
