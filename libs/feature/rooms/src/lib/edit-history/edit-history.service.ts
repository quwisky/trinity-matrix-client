import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { defer, finalize, of, type Observable } from 'rxjs';
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
  openHistory$(
    roomId: string,
    eventId: string,
  ): Observable<MatrixLinkClickTarget | null> {
    return defer(() => {
      if (this.showing) {
        return of(null); // already open — ignore the repeat subscription
      }
      this.showing = true;
      return this.dialog
        .openAndWait$<MatrixLinkClickTarget, EditHistoryComponent>(
          EditHistoryComponent,
          {
            ariaLabel: 'Edit history',
            inputs: { roomId, eventId },
          },
        )
        .pipe(finalize(() => (this.showing = false)));
    });
  }
}
