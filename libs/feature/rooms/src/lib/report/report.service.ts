import { Injectable, inject } from '@angular/core';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { RoomModerationService } from '@trinity/data-access/room-administration';
import {
  EMPTY,
  catchError,
  defer,
  map,
  of,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';

/**
 * Reports a message to the room's server administrators: prompts for a reason, hands
 * the send to {@link RoomModerationService.reportMessage}, and toasts the outcome.
 * Available on any message (it needs no room-admin rights).
 */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly moderation = inject(RoomModerationService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);

  /** Prompt for a reason and report `eventId` in `roomId` to the server admins. */
  report$(roomId: string, eventId: string): Observable<void> {
    return defer(() => {
      if (!roomId || !eventId) {
        return of(void 0);
      }
      return this.alert
        .prompt$({
          header: 'Report message',
          message: 'Report this message to the room’s server administrators?',
          confirmText: 'Report',
          variant: 'danger',
          placeholder: 'Reason (optional)',
        })
        .pipe(
          switchMap((reason) =>
            reason === null
              ? EMPTY
              : this.moderation.reportMessage(roomId, eventId, reason),
          ),
          tap(() =>
            this.toast.show('Reported to the server admins.', {
              duration: 3000,
            }),
          ),
          map(() => undefined),
          catchError(() => {
            this.toast.show('Could not report the message.', {
              duration: 4000,
              variant: 'danger',
            });
            return EMPTY;
          }),
        );
    });
  }
}
