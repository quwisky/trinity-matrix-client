import { DestroyRef, Injectable, inject } from '@angular/core';
import {
  RoomModerationService,
  RoomsService,
  type MemberSummary,
} from '@trinity/data-access/rooms';
import {
  BELOW_MEMBERS_QUERY,
  mediaQuerySignal,
  runWithBusy,
} from '@trinity/util/ui';
import { MemberInfoService } from '../member-info/member-info.service';
import { UserCardService } from '../user-card/user-card.service';
import { RoomShellStore } from './room-shell-store';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';

/**
 * Everything that starts from a person: the member list, a member's info panel, the
 * hover card, and opening a DM with them.
 *
 * Extracted before the space coordinator on purpose. `onOpenSpaceMembers` ends by routing
 * the picked member into `openMemberInfo`, so if spaces moved first it would have to reach
 * back into the page for several commits — and with page-scoped providers a coordinator
 * injecting the page re-enters provider construction and throws NG0200 rather than merely
 * being untidy.
 */
@Injectable()
export class MemberActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomsService);
  private readonly moderation = inject(RoomModerationService);
  private readonly memberInfo = inject(MemberInfoService);
  private readonly userCard = inject(UserCardService);
  /**
   * Whether the member list is currently the overlay drawer rather than the static column.
   *
   * Live rather than read at call time, and a field rather than a local: `mediaQuerySignal`
   * keeps a listener for the caller's lifetime, so it has to be created once against this
   * service's `DestroyRef` instead of per invocation.
   */
  private readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    inject(DestroyRef),
  );

  /** Member-list row: open the member's info panel; "Message" opens/reuses a DM. */
  onSelectMember(member: MemberSummary): void {
    const roomId = this.store.activeRoomId();
    if (roomId) {
      // On the narrow layout the list is an overlay drawer — close it so the info
      // panel isn't stacked behind it. The wide static column stays put.
      if (this.membersAreDrawer()) {
        this.store.membersOpen.set(false);
      }
      void this.openMemberInfo(member, roomId);
    }
  }

  async openMemberInfo(member: MemberSummary, roomId: string): Promise<void> {
    // Kick/ban actions are gated by the viewer's power over this member; the panel
    // resolves a user id only for "Message" (kick/ban close it themselves via sync).
    const caps = this.moderation.canModerate(roomId, member.userId);
    const messageUserId = await this.memberInfo.open(
      member,
      roomId,
      caps,
      this.rooms.directRoomIds().has(roomId),
    );
    if (messageUserId) {
      this.startDirectMessage(messageUserId);
    }
  }

  /** Open (or reuse) a direct message with `userId` and navigate to it. */
  private startDirectMessage(userId: string): void {
    runWithBusy(this.rooms.createDirectMessage(userId), this.status).subscribe(
      (roomId) => this.nav.onSelectRoom(roomId),
    );
  }

  /** Show the user card; if they pick "Message", open (or reuse) a DM with the user. */
  async openUserCard(userId: string): Promise<void> {
    const messageUserId = await this.userCard.open(userId);
    if (messageUserId) {
      this.startDirectMessage(messageUserId);
    }
  }
}
