import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountScopeService } from '@trinity/data-access/rooms';
import type { AccountSwitchDestination } from './account-switch.models';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';
import { WorkspaceAccountSwitchService } from './workspace-account-switch.service';

/**
 * Routing a selection to the account that owns it.
 *
 * In mixed mode a row in the sidebar may belong to an account that is not the active one,
 * so opening it means switching account first and then selecting — which is what
 * `runOnAccount` wraps. Everything that can be reached from a row therefore lives here
 * rather than in the plain navigation coordinator: the row handlers themselves, the
 * permalink opener, and the account-visibility toggle.
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
  private readonly accountSwitch = inject(WorkspaceAccountSwitchService);
  private readonly matrix = inject(MatrixClientService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly destroyRef = inject(DestroyRef);

  /** Switch to `accountId`, then repair the requested Workspace destination. */
  private runOnAccount(
    accountId: string,
    destination: AccountSwitchDestination,
  ): void {
    this.accountSwitch
      .switchAccount(accountId, destination)
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
    this.accountScope.toggle(userId);
  }

  /**
   * Open a room chosen from the sidebar list. In mixed-account mode the row may belong to
   * a different signed-in account — switch to that account first (so every downstream
   * action runs on its client), then open the room; otherwise open it directly.
   */
  onSelectRoomRow(id: string, source: 'user' | 'hop' = 'user'): void {
    const accountId = this.nav.knownRooms().find((r) => r.id === id)?.accountId;
    if (accountId && accountId !== this.matrix.activeUserId()) {
      this.runOnAccount(accountId, {
        kind: 'room',
        roomId: id,
        source,
      });
      return;
    }
    this.nav.onSelectRoom(id, source);
  }

  /**
   * Select a space pill from the rail. In mixed mode a foreign account's space switches to
   * that account first; Home (`null`) and same-account spaces select directly.
   */
  onSelectSpaceRow(id: string | null): void {
    const accountId = id
      ? this.vm.railSpaces().find((s) => s.id === id)?.accountId
      : undefined;
    if (accountId && accountId !== this.matrix.activeUserId()) {
      this.runOnAccount(accountId, { kind: 'space', spaceId: id });
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
    if (roomId !== this.store.activeRoomId()) {
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
    this.nav.onShowRooms();
    this.nav.onSelectRoom(roomId);
  }
}
