import { Injectable, inject } from '@angular/core';
import { TrnDialogService, TrnToastService } from '@trinity/kit/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
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
  private readonly dialog = inject(TrnDialogService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly toast = inject(TrnToastService);

  /** Open the poll composer; on create, send the poll to the active room. */
  async open(): Promise<void> {
    const poll = await this.dialog.openAndWait<
      NewPoll,
      CreatePollDialogComponent
    >(CreatePollDialogComponent, { ariaLabel: 'Create poll' });
    if (!poll) {
      return;
    }
    this.timelineActions.createPoll(poll.question, poll.options).subscribe({
      error: () =>
        this.toast.show('Could not create the poll.', {
          duration: 4000,
          variant: 'destructive',
        }),
    });
  }
}
