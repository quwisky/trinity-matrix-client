import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { WORKSPACE_SYSTEM_STATUS } from '@trinity/application/workspace';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { BannerComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * Slim banner shown in the rooms shell when the sync connection is lost. The
 * timeline keeps rendering from the persistent IndexedDB sync store, so this
 * reassures the user that what they see is cached while the SDK reconnects.
 * Reads {@link MatrixClientService.connectivity} and the active account's waiting count;
 * renders nothing when online with nothing waiting.
 */
@Component({
  selector: 'trn-connectivity-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, BannerComponent],
  templateUrl: './connectivity-banner.component.html',
})
export class ConnectivityBannerComponent {
  private readonly matrix = inject(MatrixClientService);
  private readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);

  readonly offline = computed(() => this.matrix.connectivity() === 'offline');

  readonly waitingText = computed(() => {
    const count = this.matrix.waitingCount();
    if (count === 0) return '';
    return `${count} ${count === 1 ? 'message' : 'messages'} waiting to send`;
  });

  /**
   * Offline waits for the next page or room switch on a phone, so it never moves a row being
   * read. Messages waiting mean the person just tried to send, so that shows at once.
   */
  readonly shown = this.systemStatus.settleBanner(
    computed(() => this.offline() || this.waitingText() !== ''),
    computed(() => this.waitingText() !== ''),
  );

  readonly liveText = computed(() =>
    [this.offline() ? 'You’re offline. Reconnecting…' : '', this.waitingText()]
      .filter(Boolean)
      .join(' '),
  );
}
