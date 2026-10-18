import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { WORKSPACE_SYSTEM_STATUS } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import {
  BannerComponent,
  type TrnBannerPlacement,
} from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnAlertService } from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { filter } from 'rxjs';

/**
 * Asks the active account to sign in again on this device when its crypto store predates
 * store keys. The sign-in is a new device on purpose: only a new device gets a new,
 * encrypted store, and saving it removes the old unencrypted one. The global banner slot
 * decides when it shows (only with key backup on); dismissing hides it for this session.
 */
@Component({
  selector: 'trn-sign-in-again-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, TrnButton, BannerComponent],
  templateUrl: './sign-in-again-banner.component.html',
  host: { class: 'block' },
})
export class SignInAgainBannerComponent {
  private readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  readonly visible = computed(
    () => this.systemStatus.bannerSlot() === 'sign-in-again',
  );

  readonly placement = computed<TrnBannerPlacement>(() =>
    this.systemStatus.bannerSlotReserved() ? 'global' : 'inline',
  );

  /**
   * Asks first: key backup being on does not prove the person still has the recovery key,
   * and the new device can read older messages only with it or another signed-in device.
   */
  signInAgain(): void {
    const userId = this.matrix.activeUserId();
    if (!userId) return;
    this.alert
      .confirm$({
        header: 'Sign in again?',
        message:
          'To read older encrypted messages here afterwards, you need this account’s recovery key or another signed-in device. Without either, they can’t be read on this device.',
        confirmText: 'Continue',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.router.navigate(['/login'], {
          queryParams: { reauth: userId, device: 'new' },
        });
      });
  }

  dismiss(): void {
    this.systemStatus.dismissSignInAgain();
  }
}
