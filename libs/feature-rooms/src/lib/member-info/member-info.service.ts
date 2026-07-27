import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import {
  type MemberSummary,
  type ModerationCaps,
} from '@trinity/data-access-rooms';
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
   * Open the info panel for `member` in `roomId`; `caps` decides whether the
   * kick / ban actions show. Resolves their id to message, or null.
   */
  open(
    member: MemberSummary,
    roomId: string,
    caps: ModerationCaps = {
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    },
    /** True for a direct message, where nobody is the owner. */
    direct = false,
  ): Promise<string | null> {
    return this.dialog.openAndWait<string, MemberInfoComponent>(
      MemberInfoComponent,
      {
        ariaLabel: 'Member info',
        inputs: {
          member,
          roomId,
          canKick: caps.kick,
          canBan: caps.ban,
          canSetPower: caps.setPower,
          myPower: caps.myPower,
          direct,
        },
      },
    );
  }
}
