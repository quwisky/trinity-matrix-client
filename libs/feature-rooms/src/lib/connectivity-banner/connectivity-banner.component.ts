import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCloudOff } from '@ng-icons/lucide';
import { MatrixClientService } from '@trinity/core';
import { BannerComponent } from '@trinity/ui';

/**
 * Slim banner shown in the rooms shell when the sync connection is lost. The
 * timeline keeps rendering from the persistent IndexedDB sync store, so this
 * reassures the user that what they see is cached while the SDK reconnects.
 * Reads {@link MatrixClientService.connectivity}; renders nothing when online.
 */
@Component({
  selector: 'trn-connectivity-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, BannerComponent],
  viewProviders: [provideIcons({ lucideCloudOff })],
  template: `
    @if (offline()) {
      <trn-banner tone="neutral">
        <ng-icon trnBannerIcon name="lucideCloudOff" aria-hidden="true" />
        You’re offline. Reconnecting…
      </trn-banner>
    }
  `,
})
export class ConnectivityBannerComponent {
  private readonly matrix = inject(MatrixClientService);

  readonly offline = computed(() => this.matrix.connectivity() === 'offline');
}
