import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type WorkspaceNavigationIntent,
  WorkspaceNavigationService,
  type WorkspaceRoomNavigationOrigin,
} from '@trinity/application/workspace';
import { SelectedRoomLibraryService } from '@trinity/data-access/room-library';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { ShellStatusService } from './shell-status.service';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import {
  type ExactRoomSelection,
  type ExactSpaceSelection,
} from '../shared/exact-selection';

interface ConfirmedRoomLinkTarget extends ExactRoomSelection {
  readonly kind: 'room' | 'space';
}

/**
 * Routing a selection to the account that owns it.
 *
 * A visible row carries its exact owning Account into the semantic Workspace command.
 * Permalinks resolve against the same selected Room Library generation that rendered the
 * sidebar; confirmed membership flows carry their Account explicitly and skip that lookup.
 */
@Injectable()
export class AccountRoutingService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly status = inject(ShellStatusService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly roomSurfaces = inject(RoomSurfaceLifecycle);
  private readonly selected = inject(SelectedRoomLibraryService);
  private readonly destroyRef = inject(DestroyRef);

  /** An account's display name for user-facing copy, falling back to its user id. */
  accountLabel(accountId: string): string {
    return this.vm.accountBadges().get(accountId)?.name ?? accountId;
  }

  /**
   * Include/exclude an account from the mixed view (the account picker's checkbox). The
   * active account is always shown, and the service ignores an attempt to drop it.
   */
  onToggleAccountShown(userId: string): void {
    this.selected
      .toggleAccount(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed') {
            this.status.showError(
              'Unable to update the accounts shown right now.',
            );
          }
        },
        error: () =>
          this.status.showError(
            'Unable to update the accounts shown right now.',
          ),
      });
  }

  /** Open the exact Account-and-Room identity emitted by a visible Room row. */
  onSelectRoomSelection(
    selection: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin = 'room-list',
  ): void {
    this.openRoom(selection, origin);
  }

  /**
   * Select a space pill from the rail. In mixed mode a foreign account's space switches to
   * that account first; Home (`null`) and same-account spaces select directly.
   */
  onSelectSpaceRow({ spaceId, accountId }: ExactSpaceSelection): void {
    const changesAccount = accountId !== this.workspace.activeAccountId();
    this.navigate(
      {
        kind: 'scope',
        accountId,
        scope: spaceId ? { kind: 'space', spaceId } : { kind: 'home' },
      },
      changesAccount
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
    );
  }

  /** Open a resolved room if joined (jumping to `eventId` when given), else toast. */
  openLinkedRoom(roomId: string, eventId?: string): void {
    const room = this.selected
      .view()
      .rooms.find((candidate) => candidate.id === roomId);
    if (!room) {
      void this.status.showError("You're not in that room.");
      return;
    }
    if (
      roomId !== this.store.activeRoomId() ||
      room.accountId !== this.store.activeAccountId() ||
      this.store.pane() !== 'conversation'
    ) {
      this.openRoom(
        { roomId, accountId: room.accountId },
        'room-action',
        eventId,
      );
      return;
    }
    if (eventId) {
      this.roomSurfaces.transition({ kind: 'reveal-message', eventId });
    }
  }

  /**
   * Open a room/space after a Join or Accept request has succeeded. The normal linked-room
   * path checks the synced sidebar projection and can briefly reject the new membership
   * before `/sync` catches up, so confirmed membership deliberately bypasses that stale read.
   */
  openConfirmedLinkedRoom(target: ConfirmedRoomLinkTarget): void {
    if (target.kind === 'space') {
      this.navigate(
        {
          kind: 'scope',
          accountId: target.accountId,
          scope: { kind: 'space', spaceId: target.roomId },
        },
        'Unable to open that destination right now.',
      );
      return;
    }
    this.navigate(
      {
        kind: 'room',
        accountId: target.accountId,
        roomId: target.roomId,
        scope: { kind: 'rooms' },
        origin: 'room-action',
      },
      'Unable to open that destination right now.',
    );
  }

  private openRoom(
    selection: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin,
    eventId?: string,
  ): void {
    const changesAccount =
      selection.accountId !== this.workspace.activeAccountId();
    this.navigate(
      { kind: 'room', ...selection, origin },
      changesAccount
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
      eventId,
    );
  }

  private navigate(
    intent: WorkspaceNavigationIntent,
    error: string,
    eventId?: string,
  ): void {
    this.workspace
      .navigate(intent)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') {
          void this.status.showError(error);
        } else if (eventId) {
          this.roomSurfaces.transition({ kind: 'reveal-message', eventId });
        }
      });
  }
}
