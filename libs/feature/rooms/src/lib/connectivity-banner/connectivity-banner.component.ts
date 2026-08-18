import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { BannerComponent } from '@trinity/components/banner';
import { TrnIconComponent } from '@trinity/components/icon';

/**
 * Slim banner shown in the rooms shell when the sync connection is lost. The
 * timeline keeps rendering from the persistent IndexedDB sync store, so this
 * reassures the user that what they see is cached while the SDK reconnects.
 * Reads {@link MatrixClientService.connectivity}; renders nothing when online.
 */
@Component({
  selector: 'trn-connectivity-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, BannerComponent],
  templateUrl: './connectivity-banner.component.html',
})
export class ConnectivityBannerComponent {
  private readonly matrix = inject(MatrixClientService);

  readonly offline = computed(() => this.matrix.connectivity() === 'offline');
}
