import {
  DestroyRef,
  Injectable,
  Injector,
  afterNextRender,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountScopeService } from '@trinity/data-access/rooms';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { ShellStatusService } from './shell-status.service';

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
  private readonly auth = inject(AuthService);
  private readonly matrix = inject(MatrixClientService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** Switch to `accountId`, then run `then` once the switch has landed. */
  runOnAccount(accountId: string, then: () => void): void {
    this.nav.closeOpenRoom();
    this.nav.resetViewScope();
    this.auth
      .switchAccount(accountId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        // Deferred past the render that follows the switch: RoomsService/SpacesService
        // re-project onto the new client from an effect, and a space hierarchy requested
        // before that flush is wiped by it — leaving the sidebar's "More Channels" and
        // sub-space sections permanently empty until the pill is clicked a second time.
        afterNextRender(() => then(), { injector: this.injector }),
      );
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
   * Open a room. `source` distinguishes a normal open (the default — records the visit,
   * committing any hop cycle) from a hop-driven one (leaves the MRU stack frozen so
   * repeated hops keep cycling deeper). Every existing caller uses the default.
   */
  /**
   * Open a room chosen from the sidebar list. In mixed-account mode the row may belong to
   * a different signed-in account — switch to that account first (so every downstream
   * action runs on its client), then open the room; otherwise open it directly.
   */
  onSelectRoomRow(id: string, source: 'user' | 'hop' = 'user'): void {
    const accountId = this.nav.knownRooms().find((r) => r.id === id)?.accountId;
    if (accountId && accountId !== this.matrix.activeUserId()) {
      this.runOnAccount(accountId, () => this.nav.onSelectRoom(id, source));
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
      this.runOnAccount(accountId, () => this.nav.onSelectSpace(id));
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
}
