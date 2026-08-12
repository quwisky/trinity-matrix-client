import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/kit/overlay';
import { MessageSearchComponent } from './message-search.component';

/**
 * Presents the {@link MessageSearchComponent} scoped to a room and resolves the chosen
 * event id (or `null` when cancelled). Wraps {@link TrnDialogService} so `RoomsPage`
 * stays thin and performs the timeline jump with the returned id — mirroring
 * {@link ThreadPanelService} / {@link QuickSwitcherService}. Opened as a full-height,
 * right-aligned side panel (`side: 'end'`), the spartan equivalent of the old
 * `justify-content: flex-end` modal css.
 *
 * A re-entrancy guard means re-triggering search while it's already open is a no-op
 * rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class MessageSearchService {
  private readonly dialog = inject(TrnDialogService);
  private open = false;

  /** Open in-room search for `roomId`; resolves the chosen event id, or null. */
  async search(roomId: string): Promise<string | null> {
    if (this.open) {
      return null; // already showing — ignore the repeat trigger
    }
    this.open = true;
    try {
      // Signal inputs are populated from `inputs` (app sets useSetInputAPI).
      return await this.dialog.openAndWait<string, MessageSearchComponent>(
        MessageSearchComponent,
        {
          ariaLabel: 'Search messages',
          side: 'end',
          inputs: { roomId },
          // Focus the query field, not CDK's first tabbable element (the close button).
          autoFocus: '[data-autofocus]',
        },
      );
    } finally {
      this.open = false;
    }
  }
}
