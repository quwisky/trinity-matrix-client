import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { MessageSourceComponent } from './message-source.component';

/** Opens the {@link MessageSourceComponent} dialog with an event's raw JSON. */
@Injectable({ providedIn: 'root' })
export class MessageSourceService {
  private readonly timeline = inject(ConversationRuntime).timeline;
  private readonly dialog = inject(TrnDialogService);

  /** Show the raw source of `eventId` in `roomId` (a no-op if it isn't loaded). */
  open(roomId: string, eventId: string): void {
    const raw = this.timeline.rawEvent(roomId, eventId);
    if (!raw) {
      return;
    }
    this.dialog.open(MessageSourceComponent, {
      inputs: { source: JSON.stringify(raw, null, 2) },
      ariaLabel: 'Message source',
    });
  }
}
