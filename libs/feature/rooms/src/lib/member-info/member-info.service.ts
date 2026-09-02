import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { type Observable } from 'rxjs';
import { MemberInfoComponent } from './member-info.component';

/**
 * Presents {@link MemberInfoComponent} for a room member (e.g. when their row is
 * clicked) and resolves their user id if the viewer chose "Message" (so the host opens
 * a DM), or `null` when the panel is dismissed or a moderation action closed it. Owns
 * presentation only.
 */
@Injectable({ providedIn: 'root' })
export class MemberInfoService {
  private readonly dialog = inject(TrnDialogService);

  /**
   * Open the info panel for `member` in `roomId`. Live room state decides which
   * moderation actions are available. Resolves their id to message, or null.
   */
  open$(
    member: MemberSummary,
    roomId: string,
    /** True for a direct message, where nobody is the owner. */
    direct = false,
  ): Observable<string | null> {
    return this.dialog.openAndWait$<string, MemberInfoComponent>(
      MemberInfoComponent,
      {
        ariaLabel: 'Member info',
        inputs: {
          member,
          roomId,
          direct,
          surfaceSize: 'sm',
          surfaceLayout: 'dialog',
        },
      },
    );
  }
}
