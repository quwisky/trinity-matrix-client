import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { BannerComponent } from '@trinity/components/generic-content';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { IdentityChangeActionsComponent } from './identity-change-actions.component';
import { identityChangeSentence } from './identity-change-copy';
import { IdentityChangeReviewComponent } from './identity-change-review.component';
import { RoomIdentityChangesService } from './room-identity-changes.service';

/**
 * Room banner while any member of the open encrypted room has an unanswered identity change.
 * One person is named with their actions; several are summed up with a Review list.
 */
@Component({
  selector: 'trn-identity-change-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BannerComponent,
    IdentityChangeActionsComponent,
    TrnButton,
    TrnIconComponent,
  ],
  templateUrl: './identity-change-banner.component.html',
})
export class IdentityChangeBannerComponent {
  private readonly runtime = inject(ConversationRuntime);
  private readonly changesService = inject(RoomIdentityChangesService);
  private readonly surfaces = inject(TrnSurfaceService);

  private readonly key = computed(() => this.runtime.focused()?.key ?? null);
  protected readonly changes = computed(() =>
    this.changesService.changes(this.key()),
  );
  protected readonly message = computed(() => {
    const changes = this.changes();
    if (changes.length === 0) return '';
    const [only] = changes;
    return changes.length === 1 && only
      ? identityChangeSentence(only)
      : `${changes.length} people in this room changed identity.`;
  });

  review(): void {
    const key = this.key();
    if (!key) return;
    this.surfaces.open(IdentityChangeReviewComponent, {
      inputs: { roomKey: key },
      ariaLabel: 'Changed identities',
    });
  }
}
