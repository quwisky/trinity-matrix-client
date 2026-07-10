import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import { type MemberSummary } from '@trinity/data-access-rooms';
import { MemberInfoComponent } from './member-info.component';

/**
 * Presents {@link MemberInfoComponent} for a room member (e.g. when their row is
 * clicked) and resolves their user id if the viewer chose "Message" (so the host opens
 * a DM), or `null` when the panel is dismissed. Owns presentation only.
 */
@Injectable({ providedIn: 'root' })
export class MemberInfoService {
  private readonly dialog = inject(TrnDialogService);

  /** Open the info panel for `member` in `roomId`; resolves their id to message, or null. */
  open(member: MemberSummary, roomId: string): Promise<string | null> {
    return this.dialog.openAndWait<string, MemberInfoComponent>(
      MemberInfoComponent,
      { inputs: { member, roomId } },
    );
  }
}
