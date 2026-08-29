import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { EditHistoryComponent } from './edit-history.component';
import { type MatrixLinkClickTarget } from '../matrix-link/matrix-link.directive';

/**
 * Presents {@link EditHistoryComponent} for a message and resolves a permalink the reader
 * followed out of it (or null), which the host then routes — mirroring
 * the in-room search panel, which announces the event to jump to.
 *
 * Named for the dialog it opens, not the data it shows: the fetching
 * `EditHistoryService` lives in `@trinity/data-access/timeline`.
 *
 * A re-entrancy guard makes a repeat trigger a no-op rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class EditHistoryDialogService {
  private readonly dialog = inject(TrnDialogService);
  private showing = false;

  /** Show the versions of `eventId` in `roomId`; resolves a followed permalink, or null. */
  async openHistory(
    roomId: string,
    eventId: string,
  ): Promise<MatrixLinkClickTarget | null> {
    if (this.showing) {
      return null; // already open — ignore the repeat trigger
    }
    this.showing = true;
    try {
      return await this.dialog.openAndWait<
        MatrixLinkClickTarget,
        EditHistoryComponent
      >(EditHistoryComponent, {
        ariaLabel: 'Edit history',
        inputs: { roomId, eventId },
      });
    } finally {
      this.showing = false;
    }
  }
}
