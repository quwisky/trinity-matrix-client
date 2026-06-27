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

/** A banner call-to-action: a label and the route it navigates to. */
interface BannerAction {
  label: string;
  path: string;
}

/**
 * Non-blocking prompt shown in the rooms shell when this device's encryption
 * isn't ready. Reads {@link CryptoService.status}: `needs-setup` offers first-time
 * setup; `needs-recovery` offers both ways to trust this device — the recovery key
 * or verifying with another signed-in session. Renders nothing when crypto is
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
        <!-- Live region scoped to the message so the action buttons aren't read
             as part of the polite announcement. -->
        <span class="banner__text" role="status">{{ message() }}</span>
        <span class="banner__actions">
          @for (action of actions(); track action.path) {
            <ion-button
              class="banner__action"
              size="small"
              fill="solid"
              (click)="go(action.path)"
            >
              {{ action.label }}
            </ion-button>
          }
        </span>
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
      ? "This device isn't verified yet — unlock your encrypted messages."
      : 'Set up encryption to secure your messages.',
  );

  readonly actions = computed<BannerAction[]>(() => {
    switch (this.status()) {
      case 'needs-setup':
        return [{ label: 'Set up', path: '/encryption/setup' }];
      case 'needs-recovery':
        return [
          { label: 'Use recovery key', path: '/encryption/unlock' },
          { label: 'Verify another device', path: '/encryption/verify' },
        ];
      default:
        return [];
    }
  });

  constructor() {
    addIcons({ lockClosed });
  }

  go(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
