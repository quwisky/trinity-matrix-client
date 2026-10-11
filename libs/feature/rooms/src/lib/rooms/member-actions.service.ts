import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { runWithBusy } from '@trinity/util/ui';
import { MemberInfoComponent } from '../member-info/member-info.component';
import { type ExactRoomSelection } from '../shared/exact-selection';
import { UserCardComponent } from '../user-card/user-card.component';
import { RoomShellStore } from './room-shell-store';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';

/**
 * Everything that starts from a person: the member list, a member's info, the hover card,
 * and opening a DM with them.
 *
 * Extracted from the page so the member list, member info, hover card and direct-message
 * navigation share one lifecycle owner.
 */
@Injectable()
export class MemberActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly destroyRef = inject(DestroyRef);

  /** Member-list row: open the member's info over the list; "Message" opens/reuses a DM. */
  onSelectMember(member: MemberSummary): void {
    const accountId = this.store.activeAccountId();
    const roomId = this.store.activeRoomId();
    if (accountId && roomId) {
      this.openMemberInfo(member, { accountId, roomId });
    }
  }

  /**
   * Show a member's info as a modal surface: a bottom sheet on a phone, a tablet or below
   * `md`, a centred dialog otherwise (the rule `TrnSurfaceService` applies).
   *
   * The Room surface slot is left alone, so the member list stays where it was (the side
   * column, or the drawer on a phone) underneath. Closing, or a kick or ban landing, returns
   * to that list with the change visible; "Message" closes it and opens the DM.
   *
   * `owner` is the exact Account-and-Room target the member is viewed in. A non-Conversation
   * caller may name another Room or Space, and the moderation actions aim at it.
   */
  openMemberInfo(member: MemberSummary, owner: ExactRoomSelection): void {
    const direct =
      owner.accountId === this.store.activeAccountId() &&
      this.rooms.directRoomIds().has(owner.roomId);

    this.dialog
      .openAndWait$<string, MemberInfoComponent>(MemberInfoComponent, {
        inputs: {
          member,
          roomId: owner.roomId,
          direct,
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((messageUserId) => {
        if (messageUserId) this.startDirectMessage(messageUserId);
      });
  }

  /** Open (or reuse) a direct message with `userId` and navigate to it. */
  private startDirectMessage(userId: string): void {
    const accountId = this.store.activeAccountId();
    if (!accountId) return;
    runWithBusy(this.rooms.createDirectMessage(userId), this.status).subscribe(
      (roomId) => this.nav.onSelectRoom({ roomId, accountId }),
    );
  }

  /**
   * Show the user card; if they pick "Message", open (or reuse) a DM with the user.
   *
   * With an `anchor` the card is a popover pinned beside the element the reader clicked —
   * a mention sits inside the sentence it is part of, and a centred modal over that
   * sentence hides the context the card is being read against. Without one (an edit-history
   * permalink, whose dialog has already closed) it stays centred, and so does every touch
   * pointer: see `TrnSurfaceOptions.anchor`.
   */
  openUserCard(userId: string, anchor?: HTMLElement): void {
    this.dialog
      .openAndWait$<string, UserCardComponent>(UserCardComponent, {
        ariaLabel: 'User',
        inputs: { userId },
        kind: 'popover',
        anchor,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((messageUserId) => {
        if (messageUserId) this.startDirectMessage(messageUserId);
      });
  }
}
