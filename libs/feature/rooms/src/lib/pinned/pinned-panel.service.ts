import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import { PinnedMessagesPanelComponent } from './pinned-messages-panel.component';

/**
 * Presents the {@link PinnedMessagesPanelComponent} for the active room and resolves
 * the event id the user chose to jump to (or `null` when they just closed it).
 * Wraps {@link TrnDialogService} so `RoomsPage` stays thin and performs the timeline
 * jump with the returned id — mirroring {@link ThreadPanelService} /
 * {@link MessageSearchService}. Opened as a full-height, right-aligned side panel
 * (`side: 'end'`), full-screen on mobile.
 *
 * The panel reads the already-open {@link PinnedMessagesService} directly, so no
 * inputs are threaded in here. A re-entrancy guard makes re-triggering while it's
 * already open a no-op rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class PinnedPanelService {
  private readonly dialog = inject(TrnDialogService);
  private open = false;

  /** Open the pinned panel; resolves the chosen event id to jump to, or null. */
  async openPanel(): Promise<string | null> {
    if (this.open) {
      return null; // already showing — ignore the repeat trigger
    }
    this.open = true;
    try {
      return await this.dialog.openAndWait<
        string,
        PinnedMessagesPanelComponent
      >(PinnedMessagesPanelComponent, { side: 'end' });
    } finally {
      this.open = false;
    }
  }
}
