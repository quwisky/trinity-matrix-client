import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCloudOff } from '@ng-icons/lucide';
import { MatrixClientService } from '@trinity/core';

/**
 * Slim banner shown in the rooms shell when the sync connection is lost. The
 * timeline keeps rendering from the persistent IndexedDB sync store, so this
 * reassures the user that what they see is cached while the SDK reconnects.
 * Reads {@link MatrixClientService.connectivity}; renders nothing when online.
 */
@Component({
  selector: 'trn-connectivity-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['connectivity-banner.component.scss'],
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideCloudOff })],
  template: `
    @if (offline()) {
      <div class="conn-banner" role="status">
        <ng-icon
          class="conn-banner__icon"
          name="lucideCloudOff"
          aria-hidden="true"
        />
        <span>You’re offline. Reconnecting…</span>
      </div>
    }
  `,
})
export class ConnectivityBannerComponent {
  private readonly matrix = inject(MatrixClientService);

  readonly offline = computed(() => this.matrix.connectivity() === 'offline');
}
