import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type WorkspaceNavigationIntent,
  WorkspaceNavigationService,
  type WorkspaceRoomNavigationOrigin,
} from '@trinity/application/workspace';
import { AccountScopeService } from '@trinity/data-access/room-library';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';

/**
 * Routing a selection to the account that owns it.
 *
 * In mixed mode a visible row carries its exact owning Account into the semantic Workspace
 * command. Older ID-only shell paths resolve ownership here before submitting the same intent.
 *
 * This is why the cluster moved before invites and shortcuts. `onAcceptInvite` and
 * `jumpTo` both finish through `onSelectRoomRow`, so they need it to already have a home
 * that is not the page.
 */
@Injectable()
export class AccountRoutingService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly status = inject(ShellStatusService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly accountScope = inject(AccountScopeService);
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
    this.accountScope
      .toggle(userId)
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

  /**
   * Resolve legacy ID-only shell actions before submitting an exact semantic identity.
   * Visible rows use {@link onSelectRoomSelection} and skip this lookup.
   */
  onSelectRoomRow(
    id: string,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    const room = this.nav.knownRooms().find((candidate) => candidate.id === id);
    const accountId = room?.accountId ?? this.workspace.activeAccountId();
    if (!id || !accountId) return;
    this.openRoom({ roomId: id, accountId }, origin);
  }

  /** Open the exact Account-and-Room identity emitted by a visible Room row. */
  onSelectRoomSelection(
    selection: {
      readonly roomId: string;
      readonly accountId: string;
    },
    origin: WorkspaceRoomNavigationOrigin = 'room-list',
  ): void {
    this.openRoom(selection, origin);
  }

  /**
   * Select a space pill from the rail. In mixed mode a foreign account's space switches to
   * that account first; Home (`null`) and same-account spaces select directly.
   */
  onSelectSpaceRow(id: string | null): void {
    const accountId = id
      ? this.vm.railSpaces().find((s) => s.id === id)?.accountId
      : this.workspace.activeAccountId();
    if (!accountId) return;
    const changesAccount = accountId !== this.workspace.activeAccountId();
    this.navigate(
      {
        kind: 'scope',
        accountId,
        scope: id ? { kind: 'space', spaceId: id } : { kind: 'home' },
      },
      changesAccount
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
    );
  }

  /** Open a resolved room if joined (jumping to `eventId` when given), else toast. */
  openLinkedRoom(roomId: string, eventId?: string): void {
    // Against the mixed superset: while mixing, a room owned by another selected account is
    // listed and openable in the sidebar, so refusing its permalink would contradict the
    // list one column to the left.
    if (!this.nav.knownRooms().some((r) => r.id === roomId)) {
      void this.status.showError("You're not in that room.");
      return;
    }
    if (
      roomId !== this.store.activeRoomId() ||
      this.store.pane() !== 'conversation'
    ) {
      this.onSelectRoomRow(roomId);
    }
    if (eventId) {
      // Jump to the linked event (a no-op until it's in the loaded timeline).
      this.store.messageSearchTarget.set(eventId);
      this.store.jumpRequest.update((n) => n + 1);
    }
  }

  /**
   * Open a room/space after a Join or Accept request has succeeded. The normal linked-room
   * path checks the synced sidebar projection and can briefly reject the new membership
   * before `/sync` catches up, so confirmed membership deliberately bypasses that stale read.
   */
  openConfirmedLinkedRoom(roomId: string, isSpace: boolean): void {
    if (isSpace) {
      this.nav.onSelectSpace(roomId);
      return;
    }
    this.nav.onSelectRoomInScope(roomId, { kind: 'rooms' });
  }

  /** Open a newly accepted invite on its exact Account without waiting for sidebar sync. */
  openConfirmedInviteRoom(
    roomId: string,
    accountId: string,
    isDirect: boolean,
  ): void {
    this.navigate(
      {
        kind: 'room',
        accountId,
        roomId,
        origin: isDirect ? 'direct-invitation' : 'room-invitation',
      },
      accountId !== this.workspace.activeAccountId()
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
    );
  }

  private openRoom(
    selection: { readonly roomId: string; readonly accountId: string },
    origin: WorkspaceRoomNavigationOrigin,
  ): void {
    const changesAccount =
      selection.accountId !== this.workspace.activeAccountId();
    this.navigate(
      { kind: 'room', ...selection, origin },
      changesAccount
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
    );
  }

  private navigate(intent: WorkspaceNavigationIntent, error: string): void {
    this.workspace
      .navigate(intent)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') void this.status.showError(error);
      });
  }
}
