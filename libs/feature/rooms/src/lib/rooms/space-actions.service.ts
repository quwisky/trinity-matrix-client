import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  RoomLibraryService,
  RoomReadinessService,
  SpaceChildrenService,
  SpaceContentsService,
  SpaceRoomOrderService,
  SpacesService,
  type RoomSortMode,
  type SpaceChildRoom,
} from '@trinity/data-access/room-library';
import { TrnAlertService, TrnDialogService } from '@trinity/components/overlay';
import { filter, map, Observable, of, switchMap, throwError } from 'rxjs';
import { AddToSpaceComponent } from '../add-to-space/add-to-space.component';
import { ManageSpaceRoomsComponent } from '../manage-space-rooms/manage-space-rooms.component';
import { SpaceSettingsComponent } from '../space-settings/space-settings.component';
import { runWithBusy } from '@trinity/util/ui';
import { isMobileOs } from '@trinity/platform-native';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { AccountRoutingService } from './account-routing.service';
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
  private readonly routing = inject(AccountRoutingService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly roomReadiness = inject(RoomReadinessService);
  private readonly spaces = inject(SpacesService);
  private readonly spaceChildren = inject(SpaceChildrenService);
  private readonly spaceContents = inject(SpaceContentsService);
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly alert = inject(TrnAlertService);
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);

  /** Rail "+": prompt for a name, create the space, then select it on success. */
  onCreateSpace(): void {
    const accountId = this.store.activeAccountId();
    if (!accountId) return;
    this.status.error.set(null); // don't carry a stale error into a fresh action
    this.alert
      .prompt$({
        header: 'Create a space',
        message: 'A space groups related rooms, like a Discord server.',
        placeholder: 'Space name',
        confirmText: 'Create',
        maxLength: 100,
      })
      .pipe(
        filter((name): name is string => name !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((name) => this.applyCreateSpace(accountId, name));
  }

  /**
   * Space overflow "Create a space inside": make a new space and link it as a child of
   * the active one, so a space can hold sub-spaces as well as rooms.
   */
  onCreateSubspace(): void {
    const parentId = this.store.activeSpaceId();
    const accountId = this.store.activeAccountId();
    if (!parentId || !accountId || !this.vm.canCurateSpace()) {
      return;
    }
    this.status.error.set(null);
    this.alert
      .prompt$({
        header: 'Create a space inside',
        message: `The new space will sit inside “${this.vm.activeSpaceName()}”.`,
        placeholder: 'Space name',
        confirmText: 'Create',
        maxLength: 100,
      })
      .pipe(
        filter((name): name is string => name !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((name) => {
        if (this.vm.canCurateSpace()) {
          this.applyCreateSubspace(parentId, accountId, name);
        }
      });
  }

  /** Sidebar "+": prompt for a name and create a room inside the active space. */
  onCreateChannel(): void {
    const spaceId = this.store.activeSpaceId();
    const accountId = this.store.activeAccountId();
    if (!spaceId || !accountId || !this.vm.canCurateSpace()) {
      return; // the affordance is hidden on Home, but guard regardless
    }
    this.status.error.set(null);
    this.alert
      .prompt$({
        header: 'Create a channel',
        message: `New channels are end-to-end encrypted and added to “${this.vm.activeSpaceName()}”.`,
        placeholder: 'Channel name',
        confirmText: 'Create',
        maxLength: 100,
      })
      .pipe(
        filter((name): name is string => name !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((name) => {
        if (this.vm.canCurateSpace()) {
          this.applyCreateChannel(accountId, spaceId, name);
        }
      });
  }

  /** Sidebar exit icon: confirm, then leave the active space (back to Home). */
  onLeaveSpace(): void {
    const spaceId = this.store.activeSpaceId();
    const accountId = this.store.activeAccountId();
    if (!spaceId || !accountId) {
      return;
    }
    const spaceName = this.vm.activeSpaceName();
    const accountName = this.routing.accountLabel(accountId);
    this.status.error.set(null);
    this.alert
      .confirm$({
        header: 'Leave space',
        message: `Leave “${spaceName}” as ${accountName}? You remain a member of its Rooms; only the Space itself is left.`,
        confirmText: 'Leave',
        variant: 'danger',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyLeaveSpace(accountId, spaceId));
  }

  private applyCreateSpace(accountId: string, name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss the prompt without creating
    }
    runWithBusy(
      this.spaces
        .createSpace(accountId, { name })
        .pipe(switchMap((spaceId) => this.waitForSpace(accountId, spaceId))),
      this.status,
    ).subscribe((spaceId) => this.nav.onSelectSpace({ spaceId, accountId }));
  }

  /**
   * Create the space first, then link it into its parent — two writes, in that order,
   * because the child link needs an id that does not exist until the room does.
   *
   * A failure of the second leaves a real, usable space that is simply not nested, which
   * is why the error is surfaced rather than swallowed: the user can add it to the parent
   * from "Add existing rooms" without having lost anything.
   */
  private applyCreateSubspace(
    parentId: string,
    accountId: string,
    name: string,
  ): void {
    if (!name.trim()) {
      return;
    }
    runWithBusy(
      this.spaces.createSpace(accountId, { name }).pipe(
        switchMap((spaceId) =>
          this.spaceChildren
            .addExistingRoom(accountId, parentId, spaceId)
            .pipe(map(() => spaceId)),
        ),
        switchMap((spaceId) => this.waitForSpace(accountId, spaceId)),
      ),
      this.status,
    ).subscribe((spaceId) => this.nav.onSelectSpace({ spaceId, accountId }));
  }

  private applyCreateChannel(
    accountId: string,
    spaceId: string,
    name: string,
  ): void {
    if (!name.trim()) {
      return;
    }
    // The new room surfaces in the sidebar live via Rooms/Spaces sync listeners.
    runWithBusy(
      this.spaceContents
        .create({ accountId, spaceId }, 'room', name)
        .pipe(
          switchMap((result) =>
            result.kind === 'linked'
              ? of(void 0)
              : throwError(
                  () =>
                    new Error(
                      `${result.item.name} was created as ${result.item.id}, but could not be linked. Open Space settings → Rooms & spaces to retry without creating another Room.`,
                    ),
                ),
          ),
        ),
      this.status,
    ).subscribe();
  }

  /** Cross the post-create `/sync` barrier before Workspace validates the new Space. */
  private waitForSpace(accountId: string, spaceId: string): Observable<string> {
    return this.roomReadiness
      .waitForRoom(accountId, spaceId)
      .pipe(map(() => spaceId));
  }

  private applyLeaveSpace(accountId: string, spaceId: string): void {
    runWithBusy(
      this.spaces.leaveSpace(accountId, spaceId),
      this.status,
    ).subscribe(() => this.nav.onSelectSpace({ spaceId: null, accountId }));
  }

  /** Sidebar "Join" on a not-yet-joined child: join it (via its routing servers). */
  onJoinChild(child: SpaceChildRoom): void {
    this.status.error.set(null);
    // On success the child lands in the synced read model — a room moves into the
    // joined channel list, a space into the rail — and its `joined` flag flips live,
    // dropping it from the "more channels"/Spaces lists. No manual selection here.
    runWithBusy(
      this.spaces.joinRoom(child.accountId, child.roomId, child.via),
      this.status,
    ).subscribe();
  }

  /** Sidebar remove icon on a joined channel: confirm, then unlink it from the space. */
  onRemoveFromSpace(roomId: string): void {
    const spaceId = this.store.activeSpaceId();
    const accountId = this.store.activeAccountId();
    if (!spaceId || !accountId || !this.vm.canCurateSpace()) {
      return; // the affordance only shows in a space, but guard regardless
    }
    this.status.error.set(null);
    const name =
      this.rooms.rooms().find((r) => r.id === roomId)?.name ?? 'this channel';
    this.alert
      .confirm$({
        header: 'Remove from space',
        message: `Remove “${name}” from “${this.vm.activeSpaceName()}”? You stay in the room — it’s just unlinked from this space.`,
        confirmText: 'Remove',
        variant: 'danger',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.vm.canCurateSpace()) {
          this.applyRemoveFromSpace(accountId, spaceId, roomId);
        }
      });
  }

  private applyRemoveFromSpace(
    accountId: string,
    spaceId: string,
    childId: string,
  ): void {
    runWithBusy(
      this.spaceContents.unlink({ accountId, spaceId }, childId),
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
    const accountId = this.store.activeAccountId();
    if (!spaceId || !accountId || !this.vm.canConfigureSpace()) {
      return;
    }
    this.openSpaceSettings(accountId, spaceId, 'general');
  }

  private openSpaceSettings(
    accountId: string,
    spaceId: string,
    initialSection: 'general' | 'members',
  ): void {
    this.dialog
      .openAndWait$(SpaceSettingsComponent, {
        ariaLabel: 'Space settings',
        placement: isMobileOs() ? 'fullscreen' : 'center',
        autoFocus: '[data-autofocus]',
        dismissGuard: (component) =>
          component?.requestExternalDismiss() ?? true,
        inputs: {
          accountId,
          spaceId,
          spaceDisplayName: this.vm.activeSpaceName(),
          initialSection,
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Space overflow "Add existing rooms": link rooms the user is already in. */
  onAddToSpace(): void {
    const spaceId = this.store.activeSpaceId();
    const accountId = this.store.activeAccountId();
    if (!spaceId || !accountId || !this.vm.canCurateSpace()) {
      return;
    }
    this.dialog
      .openAndWait$(AddToSpaceComponent, {
        ariaLabel: 'Add rooms to this space',
        inputs: { accountId, spaceId, spaceName: this.vm.activeSpaceName() },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Space overflow "Organise rooms": curate the child order and suggestions. */
  onManageSpaceRooms(): void {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.vm.canCurateSpace()) {
      return;
    }
    this.dialog
      .openAndWait$(ManageSpaceRoomsComponent, {
        ariaLabel: 'Organise this space',
        inputs: { spaceId, spaceName: this.vm.activeSpaceName() },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /**
   * Space overflow "Members": enter the same exact-target destination used by settings.
   * This shortcut remains available to ordinary members even when governance settings are
   * hidden; the destination keeps policy readable and hides only unavailable commands.
   */
  onOpenSpaceMembers(): void {
    const accountId = this.store.activeAccountId();
    const spaceId = this.store.activeSpaceId();
    if (!accountId || !spaceId) {
      return;
    }
    this.openSpaceSettings(accountId, spaceId, 'members');
  }
}
