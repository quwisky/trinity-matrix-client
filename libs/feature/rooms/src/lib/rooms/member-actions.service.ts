import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { filter, take, takeUntil } from 'rxjs';
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
  private readonly injector = inject(Injector);

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
   * It belongs to the open Conversation (`owner`), like the slot panels: Workspace
   * navigation does not close overlays, so when another Room or Account becomes active (a
   * notification tap, say) this closes it, and nothing it started runs as the new Account.
   */
  private openMemberInfo(
    member: MemberSummary,
    owner: ExactRoomSelection,
  ): void {
    const ref = this.dialog.open<string, MemberInfoComponent>(
      MemberInfoComponent,
      {
        ariaLabel: 'Member info',
        inputs: {
          member,
          roomId: owner.roomId,
          owningAccountId: owner.accountId,
          direct: this.rooms.directRoomIds().has(owner.roomId),
        },
      },
    );
    const closed = ref.closed.pipe(take(1));

    toObservable(
      computed(
        () =>
          this.store.activeAccountId() === owner.accountId &&
          this.store.activeRoomId() === owner.roomId,
      ),
      { injector: this.injector },
    )
      .pipe(
        filter((ownerActive) => !ownerActive),
        take(1),
        takeUntil(closed),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => ref.close());

    closed
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((messageUserId) => {
        if (messageUserId)
          this.startDirectMessage(messageUserId, owner.accountId);
      });
  }

  /**
   * Open (or reuse) a direct message with `userId` from `accountId` and navigate to it.
   * Nothing happens unless `accountId` is still the active Account: a DM is created as the
   * active Account, and must not be created as one that replaced the requester.
   */
  private startDirectMessage(
    userId: string,
    accountId = this.store.activeAccountId(),
  ): void {
    if (!accountId || accountId !== this.store.activeAccountId()) return;
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
