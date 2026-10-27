import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { BannerComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * Slim banner shown in the rooms shell when the sync connection is lost. The
 * timeline keeps rendering from the persistent IndexedDB sync store, so this
 * reassures the user that what they see is cached while the SDK reconnects.
 * Reads {@link SessionStateService.connectivity} and the active account's waiting count;
 * renders nothing when online with nothing waiting.
 */
@Component({
  selector: 'trn-connectivity-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, BannerComponent],
  templateUrl: './connectivity-banner.component.html',
})
export class ConnectivityBannerComponent {
  private readonly matrix = inject(SessionStateService);

  readonly offline = computed(() => this.matrix.connectivity() === 'offline');

  readonly waitingText = computed(() => {
    const count = this.matrix.waitingCount();
    if (count === 0) return '';
    return `${count} ${count === 1 ? 'message' : 'messages'} waiting to send`;
  });

  readonly liveText = computed(() =>
    [this.offline() ? 'You’re offline. Reconnecting…' : '', this.waitingText()]
      .filter(Boolean)
      .join(' '),
  );
}
