import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import { ThreadViewComponent } from './thread-view.component';
import { ThreadsListComponent } from './threads-list.component';

/**
 * Presents the {@link ThreadViewComponent} (root, replies, and an in-thread
 * composer) via {@link TrnDialogService} as a full-height, right-aligned side panel
 * (`side: 'end'`) on the wide/desktop split-pane layout, falling back to a
 * full-screen panel on mobile (the card is `w-screen md:w-[480px]`). Centralized here
 * so the rooms page stays thin and the presentation can be retargeted later.
 *
 * Unlike `EncryptionDialogService` (which lives in `ui` to avoid a feature→feature
 * dependency), the thread view is owned by this feature, so it is presented
 * directly without a loader token.
 */
@Injectable({ providedIn: 'root' })
export class ThreadPanelService {
  private readonly dialog = inject(TrnDialogService);

  /** Open the thread rooted at `rootEventId` in `roomId`. */
  async open(roomId: string, rootEventId: string): Promise<void> {
    // Signal inputs are populated from `inputs` (app sets useSetInputAPI).
    this.dialog.open<void, ThreadViewComponent>(ThreadViewComponent, {
      ariaLabel: 'Thread',
      side: 'end',
      inputs: { roomId, rootEventId },
    });
  }

  /**
   * Open the threads-list panel for `roomId` (same side-panel sizing as the thread
   * view). When a row is tapped the list closes with the chosen thread-root id,
   * which is then opened as a thread view — so the two never stack and the list
   * stays free of any thread-open dependency.
   */
  async openList(roomId: string): Promise<void> {
    const data = await this.dialog.openAndWait<string, ThreadsListComponent>(
      ThreadsListComponent,
      { side: 'end', inputs: { roomId } },
    );
    if (data) {
      await this.open(roomId, data);
    }
  }
}
