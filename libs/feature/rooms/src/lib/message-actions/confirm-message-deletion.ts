import { type TrnAlertService } from '@trinity/components/overlay';
import { filter, take, type Observable } from 'rxjs';

/** One Conversations-owned confirmation policy for deleting a message. */
export function confirmMessageDeletion$(
  alert: TrnAlertService,
): Observable<true> {
  return alert
    .confirm$({
      header: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      confirmText: 'Delete',
      variant: 'danger',
    })
    .pipe(
      filter((confirmed): confirmed is true => confirmed),
      take(1),
    );
}
