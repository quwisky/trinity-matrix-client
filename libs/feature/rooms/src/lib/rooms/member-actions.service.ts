import { Injectable, inject } from '@angular/core';
import {
  RoomModerationService,
  RoomsService,
  type MemberSummary,
} from '@trinity/data-access/rooms';
import { runWithBusy } from '@trinity/util/ui';
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

  /** Member-list row: open the member's info panel; "Message" opens/reuses a DM. */
  onSelectMember(member: MemberSummary): void {
    const roomId = this.store.activeRoomId();
    if (roomId) {
      // No need to close the list first any more: member info goes into the same slot, so
      // it REPLACES the roster rather than stacking over it. That closing step existed only
      // because the info panel was a dialog that would otherwise sit on top of the drawer.
      void this.openMemberInfo(member, roomId);
    }
  }

  /**
   * Show a member's info — in the shell's slot for the OPEN room, as a dialog anywhere else.
   *
   * The discriminator is the room id, not "is a room open". `space-actions.service.ts` opens
   * this from inside the space-members dialog with a SPACE id: there is no slot for a space,
   * and the shell behind it may even have a different room open, so putting it there would
   * show member info for one room while the timeline showed another. Comparing against
   * `activeRoomId` is what keeps the slot meaning "the open room's right-hand panel".
   */
  async openMemberInfo(member: MemberSummary, roomId: string): Promise<void> {
    // Kick/ban actions are gated by the viewer's power over this member; the panel
    // announces a user id only for "Message" (kick/ban close it themselves via sync).
    const caps = this.moderation.canModerate(roomId, member.userId);
    const direct = this.rooms.directRoomIds().has(roomId);

    if (roomId === this.store.activeRoomId()) {
      this.store.rightPanel.set({ kind: 'member', member, caps, direct });
      return;
    }

    const messageUserId = await this.memberInfo.open(
      member,
      roomId,
      caps,
      direct,
    );
    if (messageUserId) {
      this.startDirectMessage(messageUserId);
    }
  }

  /** "Message" picked in the slot's member panel — the dialog path resolves this itself. */
  onMemberMessage(userId: string): void {
    this.store.rightPanel.set(null);
    this.startDirectMessage(userId);
  }

  /**
   * The member panel closed — go BACK to the roster, not to an empty slot.
   *
   * You reach member info by clicking a row in the member list, and with one slot the panel
   * took that list's place. Closing to `null` would therefore answer "close this member" with
   * "and also the list you were reading", which is not what was asked — and it is worse after
   * a moderation write, where the panel closes ITSELF on success and the point is to see the
   * change land in the list. `promote-member.spec.mts` promotes someone and then looks for
   * them under a Moderator heading; that heading is in the roster.
   */
  onMemberPanelDismissed(): void {
    this.store.rightPanel.set({ kind: 'members' });
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
