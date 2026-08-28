import { Injectable, inject } from '@angular/core';
import {
  InvitesService,
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access/invites';
import { AccountScopeService } from '@trinity/data-access/rooms';
import { matrixRequestErrorHandling } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { AccountRoutingService } from './account-routing.service';
import { ShellStatusService } from './shell-status.service';

/**
 * Accepting and declining room and space invites.
 *
 * Accepting routes through {@link AccountRoutingService.onSelectRoomRow} rather than
 * selecting directly, because an invite may belong to an account that is not the active
 * one — which is why the account cluster had to move first.
 */
@Injectable()
export class InviteActionsService {
  private readonly nav = inject(RoomShellNavigationService);
  private readonly routing = inject(AccountRoutingService);
  private readonly status = inject(ShellStatusService);
  private readonly invites = inject(InvitesService);
  private readonly mixedInvites = inject(MixedInvitesService);
  private readonly accountScope = inject(AccountScopeService);

  /** Accept a pending invite (join); select the joined room when it's not a space. */
  onAcceptInvite({
    roomId,
    accountId,
  }: {
    roomId: string;
    accountId?: string;
  }): void {
    this.status.error.set(null);
    const invite = this.knownInvites().find((i) => i.roomId === roomId);
    // Joined on the account the invite was sent to — answering one must never need an
    // account switch, and joining as the wrong account would fail or join the wrong user.
    runWithBusy(
      this.invites.acceptInvite(roomId, accountId),
      this.status,
      matrixRequestErrorHandling(
        'accept room invite',
        'Could not join the room. Try again.',
      ),
    ).subscribe(() => {
      // Open what was just joined. A joined space needs nothing — it appears in the rail.
      //
      // Only a DM switches view. `onSelectSpace(null)` lands on the Home view, which lists
      // DIRECT MESSAGES ONLY (see `visibleRooms`) — right for a DM, and wrong for anything
      // else: a joined ROOM would be opened in the timeline while vanishing from the sidebar,
      // measurably so (the row count dropped from 2 to 1). That was correct before the rail
      // split in bd16dc25, when Home listed everything. A room is instead left on whatever
      // view the user was already on — Recent activity by default, which lists everything.
      if (!invite || invite.isSpace) {
        return;
      }
      if (invite.isDirect) {
        this.nav.onSelectSpace(null);
      }
      this.routing.onSelectRoomRow(roomId);
    });
  }

  /** Decline a pending invite (leave the invited room/space). */
  onDeclineInvite({
    roomId,
    accountId,
  }: {
    roomId: string;
    accountId?: string;
  }): void {
    this.status.error.set(null);
    runWithBusy(
      this.invites.declineInvite(roomId, accountId),
      this.status,
      matrixRequestErrorHandling(
        'decline room invite',
        'Could not decline the invitation. Try again.',
      ),
    ).subscribe();
  }

  /** Pending invites across the mixed accounts, or the active account's when not mixing. */
  private knownInvites(): readonly PendingInvite[] {
    return this.accountScope.mixing()
      ? this.mixedInvites.invites()
      : this.invites.pendingInvites();
  }
}
