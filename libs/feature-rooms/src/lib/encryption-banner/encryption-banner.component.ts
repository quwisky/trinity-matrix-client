import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { lockClosed } from 'ionicons/icons';
import { CryptoService } from '@trinity/core';

/**
 * Non-blocking prompt shown in the rooms shell when this device's encryption
 * isn't ready. Reads {@link CryptoService.status} and links to the right flow:
 * setup (first device) or unlock (a later device). Renders nothing when crypto is
 * `ready` or still `unknown`. Lives in feature-rooms (not feature-crypto) because
 * the module boundary forbids feature→feature dependencies; it depends only on
 * `@trinity/core`.
 */
@Component({
  selector: 'trn-encryption-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['encryption-banner.component.scss'],
  imports: [IonButton, IonIcon],
  template: `
    @if (visible()) {
      <div class="banner">
        <ion-icon class="banner__icon" name="lock-closed" aria-hidden="true" />
        <!-- Live region scoped to the message so the action button isn't read
             as part of the polite announcement. -->
        <span class="banner__text" role="status">{{ message() }}</span>
        <ion-button
          class="banner__action"
          size="small"
          fill="solid"
          (click)="act()"
        >
          {{ cta() }}
        </ion-button>
      </div>
    }
  `,
})
export class EncryptionBannerComponent {
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);

  readonly status = this.crypto.status;

  /** Only prompt for the two actionable states. */
  readonly visible = computed(() => {
    const status = this.status();
    return status === 'needs-setup' || status === 'needs-recovery';
  });

  readonly message = computed(() =>
    this.status() === 'needs-recovery'
      ? 'Verify this device to read your encrypted messages.'
      : 'Set up encryption to secure your messages.',
  );

  readonly cta = computed(() =>
    this.status() === 'needs-recovery' ? 'Verify' : 'Set up',
  );

  constructor() {
    addIcons({ lockClosed });
  }

  /** Navigate to the flow matching the current status. */
  act(): void {
    const path =
      this.status() === 'needs-recovery'
        ? '/encryption/unlock'
        : '/encryption/setup';
    void this.router.navigateByUrl(path);
  }
}
