import {
  RoomAliasesService,
  RoomSettingsService,
} from '@trinity/data-access/room-administration';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PublicRoomsService } from '@trinity/data-access/discovery';
import {
  RoomLibraryService,
  RoomReadinessService,
  SpacesService,
  AccountScopeService,
} from '@trinity/data-access/room-library';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
} from '@trinity/components/overlay';
import { matrixRequestErrorHandling } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { UserPickerService } from '../user-picker/user-picker.service';
import {
  RoomDirectoryComponent,
  type DirectoryJoin,
} from '../room-directory/room-directory.component';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { AccountRoutingService } from './account-routing.service';
import { ShellStatusService } from './shell-status.service';

/**
 * The life of a room: creating one, starting a DM, joining from the directory, inviting
 * people, opening its settings, and leaving.
 *
 * `invitePeople` lives here and is shared with `onInviteToSpace`, which is why that space
 * handler moved into this cluster rather than staying with the other space workflows —
 * one helper, one owner, no duplicate.
 */
@Injectable()
export class RoomActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly routing = inject(AccountRoutingService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly roomReadiness = inject(RoomReadinessService);
  private readonly spaces = inject(SpacesService);
  private readonly publicRooms = inject(PublicRoomsService);
  private readonly roomSettings = inject(RoomSettingsService);
  private readonly aliases = inject(RoomAliasesService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly userPicker = inject(UserPickerService);
  private readonly alert = inject(TrnAlertService);
  private readonly dialog = inject(TrnDialogService);
  private readonly actionSheet = inject(TrnActionSheetService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sidebar room ⋮ menu "Leave room": confirm, then leave the room entirely — on the
   * account that owns the row. Leaving is irreversible for a private room, so it must
   * never fall through to the active account just because the row belongs to another. */
  async onLeaveRoom({
    roomId,
    accountId,
  }: {
    roomId: string;
    accountId?: string;
  }): Promise<void> {
    const name =
      this.vm.visibleRooms().find((r) => r.id === roomId)?.name ?? 'this room';
    // Leaving is per-account and irreversible, so never fan it out the way the idempotent
    // actions are — name the account instead, since a merged row represents two memberships.
    const as =
      this.accountScope.mixing() && accountId
        ? ` as ${this.routing.accountLabel(accountId)}`
        : '';
    const confirmed = await this.alert.confirm({
      header: 'Leave room',
      message: `Leave “${name}”${as}? You'll stop receiving its messages and need a new invite (or a public join) to come back.`,
      confirmText: 'Leave',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    this.rooms
      .leave(roomId, accountId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // The room drops from the sidebar via sync. If it was the open one, tear the
        // room panes down (mirroring ngOnDestroy / onSelectRoom) so the timeline,
        // threads, and pinned projections stop listening on a room we just left.
        next: () => {
          const leftAccountId = accountId ?? this.store.activeAccountId();
          if (
            this.store.activeAccountId() === leftAccountId &&
            this.store.activeRoomId() === roomId
          ) {
            this.nav.clearOpenRoom();
          }
        },
        error: () => void this.status.showError('Could not leave the room.'),
      });
  }

  /** Home "+": choose between creating a room, exploring the directory, and a DM. */
  onNewChat(): void {
    this.actionSheet.open({
      header: 'New message',
      buttons: [
        { text: 'Create a room', handler: () => void this.onCreateRoom() },
        {
          text: 'Explore public rooms',
          handler: () => void this.onExploreRooms(),
        },
        {
          text: 'Start a direct message',
          handler: () => void this.onStartDm(),
        },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
  }

  /** Browse the public directory; open a room — or select a space — joined from it. */
  async onExploreRooms(): Promise<void> {
    const joined = await this.dialog.openAndWait<DirectoryJoin | null>(
      RoomDirectoryComponent,
    );
    if (!joined) {
      return;
    }
    const accountId = this.store.activeAccountId();
    if (!accountId) return;
    // The join endpoint can close the dialog before /sync publishes the Room. Workspace
    // correctly rejects an unavailable destination, so cross that finite readiness barrier
    // before asking it to select the new Room or Space.
    this.roomReadiness
      .waitForRoom(accountId, joined.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (joined.isSpace) {
            // A joined space lands in the rail — select it there.
            this.nav.onSelectSpace(joined.roomId);
          } else {
            // A joined public room is a spaceless non-DM, so it lives in the Rooms view
            // (Home shows DMs only) — select both coordinates in one Workspace command.
            this.nav.onSelectRoomInScope(joined.roomId, { kind: 'rooms' });
          }
        },
        error: () =>
          void this.status.showError('Joined, but the room is not ready yet.'),
      });
  }

  /** Move to a room's upgraded successor (from the tombstone banner): join it, then open it. */
  onGoToUpgradedRoom(roomId: string): void {
    this.status.error.set(null);
    runWithBusy(
      this.publicRooms.join(roomId),
      this.status,
      matrixRequestErrorHandling(
        'join upgraded room',
        'Could not join the room. Try again.',
      ),
    ).subscribe((joinedId) => {
      // Surface the successor in the sidebar (Home shows DMs only) so it isn't
      // opened-but-invisible, mirroring onExploreRooms.
      this.nav.onSelectRoomInScope(joinedId, { kind: 'rooms' });
    });
  }

  /** Prompt for a name, create a standalone encrypted room, then select it. */
  async onCreateRoom(): Promise<void> {
    this.status.error.set(null);
    const name = await this.alert.prompt({
      header: 'Create a room',
      message: 'New rooms are end-to-end encrypted.',
      placeholder: 'Room name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateRoom(name);
    }
  }

  /** Pick a user (MXID or directory), open/reuse a DM with them, then select it. */
  async onStartDm(): Promise<void> {
    this.status.error.set(null);
    const userId = await this.userPicker.pick({
      title: 'Start a direct message',
      confirmLabel: 'Message',
    });
    if (!userId) {
      return; // cancelled
    }
    runWithBusy(this.rooms.createDirectMessage(userId), this.status).subscribe(
      (roomId) => this.nav.onSelectRoom(roomId),
    );
  }

  /** Open-room header: invite a user to the active room. */
  async onInviteToRoom(): Promise<void> {
    const roomId = this.store.activeRoomId();
    if (roomId && this.vm.roomInvitePermission().available) {
      await this.invitePeople(
        roomId,
        this.vm.activeRoom()?.name ?? 'this room',
      );
    }
  }

  /** Space sidebar: invite a user to the active space. */
  async onInviteToSpace(): Promise<void> {
    const spaceId = this.store.activeSpaceId();
    if (spaceId && this.vm.spaceInvitePermission().available) {
      await this.invitePeople(spaceId, this.vm.activeSpaceName());
    }
  }

  private applyCreateRoom(name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss without creating
    }
    runWithBusy(this.rooms.createRoom({ name }), this.status).subscribe(
      (roomId) => this.nav.onSelectRoom(roomId),
    );
  }

  /** Shared invite flow for a room or space: pick a user, invite, then toast. */
  private async invitePeople(targetId: string, label: string): Promise<void> {
    this.status.error.set(null);
    const userId = await this.userPicker.pick({
      title: `Invite to ${label}`,
      confirmLabel: 'Invite',
    });
    if (!userId) {
      return; // cancelled
    }
    runWithBusy(
      this.rooms.inviteUser(targetId, userId),
      this.status,
      matrixRequestErrorHandling(
        'invite user to room',
        'Could not invite this user. Try again.',
      ),
    ).subscribe(
      () => void this.status.showSuccess(`Invitation sent to ${userId}.`),
    );
  }

  /** Header "Room settings": edit the active room's name and topic in a dialog. */
  onOpenRoomSettings(): void {
    const room = this.vm.activeRoom();
    if (!room) {
      return;
    }
    const editable = this.roomSettings.editableFields(room.id);
    const access = this.roomSettings.currentAccess(room.id);
    // Seeded from raw state, NOT from RoomSummary: its `name` is `room.name || roomId`,
    // and the SDK's `room.name` invents a display name out of the member list for a
    // nameless room. Pre-filling the Name field with "Alice, Bob" (or a raw !id) shows a
    // value nobody typed, and invites the user to "correct" a fabrication into a real
    // m.room.name. Same reasoning as the space dialog, which is why currentIdentity exists.
    const identity = this.roomSettings.currentIdentity(room.id);
    // "Members of this space can join" needs the spaces the room actually sits in — read
    // from the space children, never from the room's own m.space.parent, which
    // removeRoomFromSpace leaves behind on purpose.
    const parentSpaces = this.spaces.parentSpaceIds(room.id).map((id) => ({
      id,
      name: this.vm.railSpaces().find((s) => s.id === id)?.name ?? id,
    }));
    // The dialog writes on save; the name/topic/access update live via the rooms
    // sync listeners, so nothing to do with the resolved result here.
    void this.dialog.openAndWait(RoomSettingsComponent, {
      ariaLabel: 'Room settings',
      inputs: {
        roomId: room.id,
        name: identity.name,
        topic: identity.topic,
        avatarMxc: identity.avatarMxc,
        joinRule: access.joinRule,
        historyVisibility: access.historyVisibility,
        canEditName: editable.name,
        canEditTopic: editable.topic,
        canEditAvatar: editable.avatar,
        canEditJoinRule: editable.joinRule,
        canEditHistory: editable.history,
        allowedSpaceIds: access.allowedSpaceIds,
        parentSpaces,
        supportsRestricted: this.roomSettings.supportsRestricted(room.id),
        canManageAliases: this.aliases.canManageAliases(room.id),
      },
    });
  }
}
