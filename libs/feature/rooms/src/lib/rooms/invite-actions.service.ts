import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  InvitesService,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import { matrixRequestErrorHandling } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import {
  RoomLinkPreviewComponent,
  type RoomLinkPreviewResult,
} from '../room-link-preview/room-link-preview.component';
import { AccountRoutingService } from './account-routing.service';
import { ShellStatusService } from './shell-status.service';

/**
 * Accepting and declining room and space invites.
 *
 * The selected Room Library row travels intact from the sidebar, so duplicate room ids
 * remain qualified by their exact owning Account without a second, potentially stale lookup.
 */
@Injectable()
export class InviteActionsService {
  private readonly routing = inject(AccountRoutingService);
  private readonly status = inject(ShellStatusService);
  private readonly invites = inject(InvitesService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The invite row itself: show the room before deciding. Accept in the preview joins as the
   * invited account, exactly like the row's ✓, and then opens the room the same way.
   */
  onPreviewInvite(invite: PendingInvite): void {
    this.surfaces
      .openAndWait$<RoomLinkPreviewResult | null, RoomLinkPreviewComponent>(
        RoomLinkPreviewComponent,
        {
          autoFocus: 'first-heading',
          inputs: {
            target: { kind: 'room', roomIdOrAlias: invite.roomId },
            accountId: invite.accountId,
          },
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (!result?.membershipChanged || invite.isSpace) return;
        this.routing.onSelectRoomSelection(
          { roomId: invite.roomId, accountId: invite.accountId },
          invite.isDirect ? 'direct-invitation' : 'room-invitation',
        );
      });
  }

  /** Accept a pending invite (join); select the joined room when it's not a space. */
  onAcceptInvite(invite: PendingInvite): void {
    const { roomId, accountId } = invite;
    this.status.error.set(null);
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
      if (invite.isSpace) {
        return;
      }
      this.routing.onSelectRoomSelection(
        { roomId, accountId },
        invite.isDirect ? 'direct-invitation' : 'room-invitation',
      );
    });
  }

  /** Decline a pending invite (leave the invited room/space). */
  onDeclineInvite({ roomId, accountId }: PendingInvite): void {
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
}
