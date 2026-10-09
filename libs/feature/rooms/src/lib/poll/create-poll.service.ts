import { Injectable, inject } from '@angular/core';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { EMPTY, catchError, map, of, switchMap, type Observable } from 'rxjs';
import {
  CreatePollDialogComponent,
  type NewPoll,
} from './create-poll-dialog.component';

/**
 * Presents {@link CreatePollDialogComponent} and, on confirm, starts the poll in the
 * open room via {@link TimelineActionsService.createPoll}, toasting a failure. Owns
 * presentation + orchestration so the composer just triggers it.
 */
@Injectable({ providedIn: 'root' })
export class CreatePollService {
  private readonly dialog = inject(TrnSurfaceService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly toast = inject(TrnToastService);

  /** Open the poll composer; on create, send the poll to the active room. */
  open$(): Observable<void> {
    return this.dialog
      .openAndWait$<NewPoll, CreatePollDialogComponent>(
        CreatePollDialogComponent,
        {
          autoFocus: '[data-testid=poll-question]',
        },
      )
      .pipe(
        switchMap((poll) =>
          poll
            ? this.timelineActions.createPoll(
                poll.question,
                poll.options,
                poll.maxSelections,
              )
            : of(void 0),
        ),
        map(() => undefined),
        catchError(() => {
          this.toast.show('Could not create the poll.', {
            duration: 4000,
            variant: 'danger',
          });
          return EMPTY;
        }),
      );
  }
}
