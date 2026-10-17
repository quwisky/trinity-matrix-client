import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  InvitesService,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import { matrixRequestErrorHandling } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { Subject, finalize, type Observable } from 'rxjs';
import {
  RoomLinkPreviewComponent,
  type RoomLinkPreviewResult,
} from '../room-link-preview/room-link-preview.component';
import { ReportService } from '../report/report.service';
import { AccountRoutingService } from './account-routing.service';
import { ShellStatusService } from './shell-status.service';

/** An invite answer that has finished, dialogs and all: declined, or still pending. */
export interface InviteAnswered {
  readonly roomId: string;
  readonly declined: boolean;
}

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
  private readonly reports = inject(ReportService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly answers = new Subject<InviteAnswered>();

  /** Lets the invite list move focus on once a declined row is gone and no dialog holds it. */
  readonly answered: Observable<InviteAnswered> = this.answers.asObservable();

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
        // Only the preview's Open step returns a result. It also offers Open when the invite
        // was already accepted elsewhere (`membershipChanged` false), so that opens too.
        if (!result) return;
        // The preview's Open step is an explicit request, so a joined space opens too, once
        // its join has synced.
        if (invite.isSpace) {
          this.routing.openConfirmedLinkedRoom({
            kind: 'space',
            roomId: invite.roomId,
            accountId: invite.accountId,
          });
          return;
        }
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
      // Only a DM switches view. The Home view lists DIRECT MESSAGES ONLY (see
      // `visibleRooms`), so a joined ROOM would open in the timeline while vanishing from the
      // sidebar. A room is instead left on whatever view the user was already on — Recent
      // activity by default, which lists everything.
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
    let declined = false;
    runWithBusy(
      this.invites.declineInvite(roomId, accountId),
      this.status,
      matrixRequestErrorHandling(
        'decline room invite',
        'Could not decline the invitation. Try again.',
      ),
    )
      .pipe(finalize(() => this.answers.next({ roomId, declined })))
      .subscribe(() => (declined = true));
  }

  /** Report the invited room to the invited account's server admins, then decline. */
  onDeclineAndReport(invite: PendingInvite): void {
    let declined = false;
    this.reports
      .declineAndReport$({
        accountId: invite.accountId,
        roomId: invite.roomId,
        inviterId: invite.inviterId,
        inviterName: invite.inviterName,
      })
      .pipe(
        finalize(() => this.answers.next({ roomId: invite.roomId, declined })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((answer) => (declined = answer === 'declined'));
  }
}
