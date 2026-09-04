import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AccountScopeService } from '@trinity/data-access/room-library';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';
import type { WorkspaceDestination } from './workspace.models';
import type { WorkspaceNavigationSource } from './workspace.models';
import { WorkspaceService } from './workspace.service';

/**
 * Routing a selection to the account that owns it.
 *
 * In mixed mode a visible row carries its exact owning Account into the semantic Workspace
 * command. Older ID-only shell paths still resolve ownership here and use the compatibility
 * destination seam until the rest of the shell migration lands.
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
  private readonly workspace = inject(WorkspaceService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly destroyRef = inject(DestroyRef);

  /** Switch to `accountId`, then repair the requested Workspace destination. */
  private runOnAccount(
    destination: WorkspaceDestination,
    source: WorkspaceNavigationSource = 'user',
  ): void {
    this.workspace
      .open(destination, { source, history: 'push' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') {
          void this.status.showError('Unable to open that account right now.');
        }
      });
  }

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
        error: () =>
          this.status.showError(
            'Unable to update the accounts shown right now.',
          ),
      });
  }

  /**
   * Compatibility path for ID-only shell navigation. Visible rows use
   * {@link onSelectRoomSelection} and never re-derive Account ownership from this list.
   */
  onSelectRoomRow(id: string, source: 'user' | 'hop' = 'user'): void {
    const accountId = this.nav.knownRooms().find((r) => r.id === id)?.accountId;
    if (id && accountId && accountId !== this.workspace.activeAccountId()) {
      this.runOnAccount(this.workspace.roomDestination(accountId, id), source);
      return;
    }
    this.nav.onSelectRoom(id, source);
  }

  /** Open the exact Account-and-Room identity emitted by a visible Room row. */
  onSelectRoomSelection(selection: {
    readonly roomId: string;
    readonly accountId: string;
  }): void {
    this.workspace
      .navigate({
        kind: 'room',
        accountId: selection.accountId,
        roomId: selection.roomId,
        origin: 'room-list',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') {
          void this.status.showError(
            'Unable to open that destination right now.',
          );
        }
      });
  }

  /**
   * Select a space pill from the rail. In mixed mode a foreign account's space switches to
   * that account first; Home (`null`) and same-account spaces select directly.
   */
  onSelectSpaceRow(id: string | null): void {
    const accountId = id
      ? this.vm.railSpaces().find((s) => s.id === id)?.accountId
      : undefined;
    if (id && accountId && accountId !== this.workspace.activeAccountId()) {
      this.runOnAccount(
        this.workspace.scopeDestination(accountId, {
          kind: 'space',
          spaceId: id,
        }),
      );
      return;
    }
    this.nav.onSelectSpace(id);
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
    const current = this.workspace.view();
    const scope = isDirect
      ? ({ kind: 'home' } as const)
      : current.accountId === accountId && current.scope.kind !== 'space'
        ? current.scope
        : ({ kind: 'recent' } as const);
    this.runOnAccount(
      this.workspace.roomInScopeDestination(accountId, roomId, scope),
    );
  }
}
