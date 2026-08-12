import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/kit/button';
import { TimelineService } from '@trinity/data-access/timeline';
import { BannerComponent } from '@trinity/ui';
import { TrnIconComponent } from '@trinity/kit/icon';

/**
 * Banner shown at the top of a room that has been **upgraded** (`m.room.tombstone`):
 * the room is frozen and a successor replaces it. Reads {@link TimelineService.tombstone}
 * and emits {@link goToRoom} with the successor's id so the host can join + open it.
 * Renders nothing for a live room.
 */
@Component({
  selector: 'trn-tombstone-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, TrnButton, BannerComponent],
  templateUrl: './tombstone-banner.component.html',
})
export class TombstoneBannerComponent {
  private readonly timeline = inject(TimelineService);

  readonly tombstone = this.timeline.tombstone;

  /** The successor room id to move to, when the user chooses to. */
  readonly goToRoom = output<string>();

  go(): void {
    const tombstone = this.tombstone();
    if (tombstone) {
      this.goToRoom.emit(tombstone.replacementRoomId);
    }
  }
}
