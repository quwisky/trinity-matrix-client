import { RoomSettingsService } from '@trinity/data-access/rooms';
import { Injectable, inject } from '@angular/core';
import { RoomAliasesService } from '@trinity/data-access/rooms';
import {
  RoomLibraryService,
  SpaceChildrenService,
  SpaceRoomOrderService,
  SpacesService,
  type MemberSummary,
  type RoomSortMode,
  type SpaceChildRoom,
} from '@trinity/data-access/room-library';
import { TrnAlertService, TrnDialogService } from '@trinity/components/overlay';
import { map, switchMap } from 'rxjs';
import { AddToSpaceComponent } from '../add-to-space/add-to-space.component';
import { ManageSpaceRoomsComponent } from '../manage-space-rooms/manage-space-rooms.component';
import { SpaceMembersComponent } from '../space-members/space-members.component';
import { SpaceSettingsComponent } from '../space-settings/space-settings.component';
import { runWithBusy } from '@trinity/util/ui';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { MemberActionsService } from './member-actions.service';
import { ShellStatusService } from './shell-status.service';

/**
 * Creating, curating, configuring and leaving spaces.
 *
 * The `on*` methods own the prompt and confirmation copy and the power-level gating; the
 * matching `apply*` methods own the write and the navigation that follows it. That split
 * is the existing shape and is kept deliberately — it is what lets a spec drive the write
 * without standing up a dialog.
 *
 * `onInviteToSpace` is not here: it shares `invitePeople` with the room cluster, so it
 * moves with that one rather than duplicating the helper or reaching back into the page.
 */
@Injectable()
export class SpaceActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly memberActions = inject(MemberActionsService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly spaces = inject(SpacesService);
  private readonly spaceChildren = inject(SpaceChildrenService);
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly roomSettings = inject(RoomSettingsService);
  private readonly aliases = inject(RoomAliasesService);
  private readonly alert = inject(TrnAlertService);
  private readonly dialog = inject(TrnDialogService);

  /** Rail "+": prompt for a name, create the space, then select it on success. */
  async onCreateSpace(): Promise<void> {
    this.status.error.set(null); // don't carry a stale error into a fresh action
    const name = await this.alert.prompt({
      header: 'Create a space',
      message: 'A space groups related rooms, like a Discord server.',
      placeholder: 'Space name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateSpace(name);
    }
  }

  /**
   * Space overflow "Create a space inside": make a new space and link it as a child of
   * the active one, so a space can hold sub-spaces as well as rooms.
   */
  async onCreateSubspace(): Promise<void> {
    const parentId = this.store.activeSpaceId();
    if (!parentId || !this.vm.canCurateSpace()) {
      return;
    }
    this.status.error.set(null);
    const name = await this.alert.prompt({
      header: 'Create a space inside',
      message: `The new space will sit inside “${this.vm.activeSpaceName()}”.`,
      placeholder: 'Space name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null && this.vm.canCurateSpace()) {
      this.applyCreateSubspace(parentId, name);
    }
  }

  /** Sidebar "+": prompt for a name and create a room inside the active space. */
  async onCreateChannel(): Promise<void> {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.vm.canCurateSpace()) {
      return; // the affordance is hidden on Home, but guard regardless
    }
    this.status.error.set(null);
    const name = await this.alert.prompt({
      header: 'Create a channel',
      message: `New channels are end-to-end encrypted and added to “${this.vm.activeSpaceName()}”.`,
      placeholder: 'Channel name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null && this.vm.canCurateSpace()) {
      this.applyCreateChannel(spaceId, name);
    }
  }

  /** Sidebar exit icon: confirm, then leave the active space (back to Home). */
  async onLeaveSpace(): Promise<void> {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      return;
    }
    this.status.error.set(null);
    if (
      await this.alert.confirm({
        header: 'Leave space',
        message: `Leave “${this.vm.activeSpaceName()}”? Its rooms stay on your account — only the space is left.`,
        confirmText: 'Leave',
        destructive: true,
      })
    ) {
      this.applyLeaveSpace(spaceId);
    }
  }

  private applyCreateSpace(name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss the prompt without creating
    }
    runWithBusy(this.spaces.createSpace({ name }), this.status).subscribe(
      (spaceId) => this.nav.onSelectSpace(spaceId),
    );
  }

  /**
   * Create the space first, then link it into its parent — two writes, in that order,
   * because the child link needs an id that does not exist until the room does.
   *
   * A failure of the second leaves a real, usable space that is simply not nested, which
   * is why the error is surfaced rather than swallowed: the user can add it to the parent
   * from "Add existing rooms" without having lost anything.
   */
  private applyCreateSubspace(parentId: string, name: string): void {
    if (!name.trim()) {
      return;
    }
    runWithBusy(
      this.spaces
        .createSpace({ name })
        .pipe(
          switchMap((spaceId) =>
            this.spaceChildren
              .addExistingRoom(parentId, spaceId)
              .pipe(map(() => spaceId)),
          ),
        ),
      this.status,
    ).subscribe((spaceId) => this.nav.onSelectSpace(spaceId));
  }

  private applyCreateChannel(spaceId: string, name: string): void {
    if (!name.trim()) {
      return;
    }
    // The new room surfaces in the sidebar live via Rooms/Spaces sync listeners.
    runWithBusy(
      this.spaces.createRoomInSpace(spaceId, { name }),
      this.status,
    ).subscribe();
  }

  private applyLeaveSpace(spaceId: string): void {
    runWithBusy(this.spaces.leaveSpace(spaceId), this.status).subscribe(() =>
      this.nav.onSelectSpace(null),
    );
  }

  /** Sidebar "Join" on a not-yet-joined child: join it (via its routing servers). */
  onJoinChild(child: SpaceChildRoom): void {
    this.status.error.set(null);
    // On success the child lands in the synced read model — a room moves into the
    // joined channel list, a space into the rail — and its `joined` flag flips live,
    // dropping it from the "more channels"/Spaces lists. No manual selection here.
    runWithBusy(
      this.spaces.joinRoom(child.roomId, child.via),
      this.status,
    ).subscribe();
  }

  /** Sidebar remove icon on a joined channel: confirm, then unlink it from the space. */
  async onRemoveFromSpace(roomId: string): Promise<void> {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.vm.canCurateSpace()) {
      return; // the affordance only shows in a space, but guard regardless
    }
    this.status.error.set(null);
    const name =
      this.rooms.rooms().find((r) => r.id === roomId)?.name ?? 'this channel';
    if (
      (await this.alert.confirm({
        header: 'Remove from space',
        message: `Remove “${name}” from “${this.vm.activeSpaceName()}”? You stay in the room — it’s just unlinked from this space.`,
        confirmText: 'Remove',
        destructive: true,
      })) &&
      this.vm.canCurateSpace()
    ) {
      this.applyRemoveFromSpace(spaceId, roomId);
    }
  }

  private applyRemoveFromSpace(spaceId: string, childId: string): void {
    runWithBusy(
      this.spaces.removeRoomFromSpace(spaceId, childId),
      this.status,
    ).subscribe();
  }

  /**
   * Sidebar header sort menu: order the open space's rooms. `null` is "use my default", and
   * *drops* the override rather than storing today's default — so the space keeps following
   * that default if it is later changed in Settings.
   */
  onSetSpaceSort(mode: RoomSortMode | null): void {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      return; // the control is space-only, but the handler shouldn't assume it
    }
    if (mode) {
      runWithBusy(
        this.spaceOrder.setForSpace(spaceId, mode),
        this.status,
      ).subscribe();
    } else {
      runWithBusy(
        this.spaceOrder.clearForSpace(spaceId),
        this.status,
      ).subscribe();
    }
  }

  /**
   * Space overflow "Space settings": edit the active space's name, topic, avatar and join
   * rule. Seeds from raw state rather than the rail summary — `SpaceSummary` carries no
   * topic, and its `name` is the pill's display name rather than the `m.room.name` a save
   * has to compare against.
   */
  onOpenSpaceSettings(): void {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.vm.canConfigureSpace()) {
      return;
    }
    const identity = this.roomSettings.currentIdentity(spaceId);
    const editable = this.roomSettings.editableFields(spaceId);
    const access = this.roomSettings.currentAccess(spaceId);
    void this.dialog.openAndWait(SpaceSettingsComponent, {
      ariaLabel: 'Space settings',
      inputs: {
        spaceId,
        name: identity.name,
        topic: identity.topic,
        avatarMxc: identity.avatarMxc,
        joinRule: access.joinRule,
        canEditName: editable.name,
        canEditTopic: editable.topic,
        canEditAvatar: editable.avatar,
        canEditJoinRule: editable.joinRule,
        canManageAliases: this.aliases.canManageAliases(spaceId),
      },
    });
  }

  /** Space overflow "Add existing rooms": link rooms the user is already in. */
  onAddToSpace(): void {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.vm.canCurateSpace()) {
      return;
    }
    void this.dialog.openAndWait(AddToSpaceComponent, {
      ariaLabel: 'Add rooms to this space',
      inputs: { spaceId, spaceName: this.vm.activeSpaceName() },
    });
  }

  /** Space overflow "Organise rooms": curate the child order and suggestions. */
  onManageSpaceRooms(): void {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.vm.canCurateSpace()) {
      return;
    }
    void this.dialog.openAndWait(ManageSpaceRoomsComponent, {
      ariaLabel: 'Organise this space',
      inputs: { spaceId, spaceName: this.vm.activeSpaceName() },
    });
  }

  /**
   * Space overflow "Members": list the space's members, with the same moderation the room
   * member list offers.
   *
   * Picking someone opens the SHARED member-info panel against the space id — a space is a
   * room, so `canModerate` and every kick/ban/power-level action already answer correctly
   * for it. One moderation surface rather than a space-shaped copy of it.
   */
  onOpenSpaceMembers(): void {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      return;
    }
    void this.dialog
      .openAndWait<MemberSummary | null, SpaceMembersComponent>(
        SpaceMembersComponent,
        {
          ariaLabel: 'Space members',
          inputs: { spaceId, spaceName: this.vm.activeSpaceName() },
        },
      )
      .then((member) => {
        if (member) {
          void this.memberActions.openMemberInfo(member, spaceId);
        }
      });
  }
}
