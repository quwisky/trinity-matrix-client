import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { UserCardComponent } from './user-card.component';

/**
 * Presents {@link UserCardComponent} for a user (e.g. when a mention is clicked) and
 * resolves the user id if the viewer chose "Message" (so the host opens a DM), or
 * `null` when the card is dismissed. Owns presentation only.
 */
@Injectable({ providedIn: 'root' })
export class UserCardService {
  private readonly dialog = inject(TrnDialogService);

  /** Open the card for `userId`; resolves the id to message, or null if dismissed. */
  open(userId: string): Promise<string | null> {
    return this.dialog.openAndWait<string, UserCardComponent>(
      UserCardComponent,
      { ariaLabel: 'User', inputs: { userId } },
    );
  }
}
