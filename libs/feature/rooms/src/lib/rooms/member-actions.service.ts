import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { runWithBusy } from '@trinity/util/ui';
import { MemberInfoService } from '../member-info/member-info.service';
import { type ExactRoomSelection } from '../shared/exact-selection';
import { UserCardService } from '../user-card/user-card.service';
import { RoomShellStore } from './room-shell-store';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';

/**
 * Everything that starts from a person: the member list, a member's info panel, the
 * hover card, and opening a DM with them.
 *
 * Extracted from the page so the Conversation member slot, member dialog, hover card and
 * direct-message navigation share one lifecycle owner.
 */
@Injectable()
export class MemberActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly roomSurfaces = inject(RoomSurfaceLifecycle);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly memberInfo = inject(MemberInfoService);
  private readonly userCard = inject(UserCardService);
  private readonly destroyRef = inject(DestroyRef);

  /** Member-list row: open the member's info panel; "Message" opens/reuses a DM. */
  onSelectMember(member: MemberSummary): void {
    const accountId = this.store.activeAccountId();
    const roomId = this.store.activeRoomId();
    if (accountId && roomId) {
      // No need to close the list first any more: member info goes into the same slot, so
      // it REPLACES the roster rather than stacking over it. That closing step existed only
      // because the info panel was a dialog that would otherwise sit on top of the drawer.
      this.openMemberInfo(member, { accountId, roomId });
    }
  }

  /**
   * Show a member's info — in the shell's slot for the OPEN room, as a dialog anywhere else.
   *
   * The discriminator is the exact Account-and-Room owner, not "is a room open".
   * A non-Conversation caller may supply a different Room or Space id. There is no shell
   * slot for that target, and the shell behind it may even have another Conversation open.
   * Exact comparison keeps the slot tied to the open Conversation even when two Accounts
   * contain the same Matrix room id.
   */
  openMemberInfo(member: MemberSummary, owner: ExactRoomSelection): void {
    const activeAccountId = this.store.activeAccountId();
    const direct =
      owner.accountId === activeAccountId &&
      this.rooms.directRoomIds().has(owner.roomId);

    if (
      owner.accountId === activeAccountId &&
      owner.roomId === this.store.activeRoomId()
    ) {
      this.roomSurfaces.transition({
        kind: 'open-member',
        member,
        direct,
      });
      return;
    }

    this.memberInfo
      .open$(member, owner.roomId, direct)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((messageUserId) => {
        if (messageUserId) this.startDirectMessage(messageUserId);
      });
  }

  /** "Message" picked in the slot's member panel — the dialog path resolves this itself. */
  onMemberMessage(userId: string): void {
    this.roomSurfaces.transition({ kind: 'dismiss' });
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
    this.roomSurfaces.transition({ kind: 'dismiss' });
  }

  /** Open (or reuse) a direct message with `userId` and navigate to it. */
  private startDirectMessage(userId: string): void {
    const accountId = this.store.activeAccountId();
    if (!accountId) return;
    runWithBusy(this.rooms.createDirectMessage(userId), this.status).subscribe(
      (roomId) => this.nav.onSelectRoom({ roomId, accountId }),
    );
  }

  /** Show the user card; if they pick "Message", open (or reuse) a DM with the user. */
  openUserCard(userId: string, anchor?: HTMLElement): void {
    this.userCard
      .open$(userId, anchor)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((messageUserId) => {
        if (messageUserId) this.startDirectMessage(messageUserId);
      });
  }
}
