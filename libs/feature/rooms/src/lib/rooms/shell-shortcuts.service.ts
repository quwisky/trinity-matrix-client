import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, switchMap } from 'rxjs';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { TrnDialogService } from '@trinity/components/overlay';
import type { RoomSummary } from '@trinity/data-access/room-library';
import {
  MruRoomsService,
  type MruRoomIdentity,
} from '../shortcuts/mru-rooms.service';
import { stepList, stepUnread } from '../shortcuts/room-navigation';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { AccountRoutingService } from './account-routing.service';
import { ShellStatusService } from './shell-status.service';
import { WorkspaceService } from './workspace.service';

/**
 * The keyboard surface: the global chord handler, room hopping and list walking, and the
 * quick switcher.
 *
 * Search selections are already fully qualified. This coordinator hands them to
 * Workspace's resolver rather than interpreting result kinds or re-deriving Account
 * ownership from shell projections.
 */
@Injectable()
export class ShellShortcutsService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly routing = inject(AccountRoutingService);
  private readonly status = inject(ShellStatusService);
  private readonly workspace = inject(WorkspaceService);
  private readonly mru = inject(MruRoomsService);
  private readonly switcher = inject(QuickSwitcherService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Global keyboard shortcuts (issues #12/#13). One listener rather than many host
   * bindings: it bails unless a modifier is held (so plain typing is untouched) and no
   * overlay owns the screen (mirrors {@link openSwitcher}'s guard), then asks
   * {@link KeyboardShortcutsService} which shortcut the chord triggers — honouring the
   * user's custom bindings and the desktop-only gate — and dispatches it. The bindings
   * themselves live in the registry (and the settings page); this only maps an id to its
   * action.
   *
   * "An overlay owns the screen" is two questions since the shell grew its right-hand slot.
   * `hasOpen()` used to answer both, because threads, pinned messages and in-room search
   * were dialogs; they are plain components in the slot now, so a chord fired while typing
   * in the search field would walk to another room — leaving a panel behind that is about
   * the room you just left. The roster is deliberately NOT counted: it is a column beside
   * the timeline, not something over it, and hopping rooms with it open has always worked.
   */
  onGlobalKeydown(event: Event): void {
    const e = event as KeyboardEvent;
    if (
      (!e.ctrlKey && !e.metaKey && !e.altKey) ||
      this.dialog.hasOpen() ||
      this.panelOwnsTheScreen()
    ) {
      return;
    }
    const hit = this.shortcuts.resolve(e);
    if (!hit) {
      return;
    }
    // preventDefault belongs to the branches that act, NOT to "the catalogue matched". The
    // catalogue also holds the composer's formatting shortcuts, which this handler knows
    // nothing about — blocking those here would swallow Ctrl+B app-wide and do nothing with
    // it. An id we do not handle must fall through to the browser untouched.
    switch (hit.id) {
      case 'switcher.open':
        e.preventDefault();
        void this.openSwitcher();
        break;
      case 'room.hop.back':
        e.preventDefault();
        this.hopRoom('back');
        break;
      case 'room.hop.forward':
        e.preventDefault();
        this.hopRoom('forward');
        break;
      case 'room.walk.down':
        e.preventDefault();
        this.walkList('next');
        break;
      case 'room.walk.up':
        e.preventDefault();
        this.walkList('previous');
        break;
      case 'room.walk.unread.down':
        e.preventDefault();
        this.walkUnread('next');
        break;
      case 'room.walk.unread.up':
        e.preventDefault();
        this.walkUnread('previous');
        break;
      case 'room.jump':
        if (hit.digit) {
          e.preventDefault();
          this.openShortcutTarget(
            this.mru.nth(hit.digit, this.activeRoom()),
            'shortcut',
          );
        }
        break;
    }
  }

  /** Whether the shell's right-hand slot is showing something ON TOP of the timeline. */
  private panelOwnsTheScreen(): boolean {
    const panel = this.store.rightPanel();
    return panel !== null && panel.kind !== 'members';
  }

  private hopRoom(direction: 'back' | 'forward'): void {
    // Across every mixed account, not just the active one — otherwise hopping back to a
    // room you opened on another account silently does nothing.
    const known = this.nav
      .knownRooms()
      .flatMap((room) =>
        room.accountIds.map((accountId) => ({ accountId, roomId: room.id })),
      );
    this.openShortcutTarget(
      this.mru.hop(direction, this.activeRoom(), known),
      'room-hop',
    );
  }

  // Both walks step through `filteredRooms`, not `visibleRooms`: with the sidebar's filter
  // box active they must not land on a room the user cannot see.
  private walkList(direction: 'next' | 'previous'): void {
    const rooms = this.vm.filteredRooms();
    this.openShortcutTarget(
      this.roomIdentity(
        stepList(
          rooms.map((room) => room.id),
          this.store.activeRoomId(),
          direction,
        ),
        rooms,
      ),
      'shortcut',
    );
  }

  private walkUnread(direction: 'next' | 'previous'): void {
    const rooms = this.vm.filteredRooms();
    this.openShortcutTarget(
      this.roomIdentity(
        stepUnread(rooms, this.store.activeRoomId(), direction),
        rooms,
      ),
      'shortcut',
    );
  }

  /**
   * Open a shortcut's resolved target when there is one and it isn't already open. The MRU
   * remembers rooms across account switches, so a target can name a room no account in the
   * current scope holds (it was unticked, or signed out) — opening that would tear down the
   * timeline and leave a blank chat pane, so drop it instead.
   */
  private openShortcutTarget(
    room: MruRoomIdentity | null,
    origin: 'shortcut' | 'room-hop',
  ): void {
    if (!room) return;
    const known = this.nav
      .knownRooms()
      .some(
        (candidate) =>
          candidate.id === room.roomId &&
          candidate.accountIds.includes(room.accountId),
      );
    if (
      !known ||
      (room.roomId === this.store.activeRoomId() &&
        room.accountId === this.store.activeAccountId())
    ) {
      return;
    }
    this.routing.onSelectRoomSelection(room, origin);
  }

  private roomIdentity(
    roomId: string | null,
    rooms: readonly RoomSummary[],
  ): MruRoomIdentity | null {
    const room = rooms.find((candidate) => candidate.id === roomId);
    return room ? { accountId: room.accountId, roomId: room.id } : null;
  }

  private activeRoom(): MruRoomIdentity | null {
    const accountId = this.store.activeAccountId();
    const roomId = this.store.activeRoomId();
    return accountId && roomId ? { accountId, roomId } : null;
  }

  /**
   * Open the switcher and offer its fully qualified selection to Workspace. Also the
   * header search button's handler.
   *
   * Bail when an overlay already owns the screen: the Cmd/Ctrl+K shortcut fires even while
   * a verification or settings modal is open (RoomsPage isn't destroyed), so without this it
   * would stack the switcher over that modal — and picking a result runs onSelectRoom() →
   * media.releaseAll(), revoking the open modal's pinned blobs.
   *
   * The right-hand slot is deliberately not part of this guard, unlike
   * {@link onGlobalKeydown}'s: this is also the header search button's handler, reachable
   * while a panel is open, and a button that silently does nothing is worse than a switch.
   * Picking a room takes the slot with it — `rightPanel` is keyed on the open room.
   */
  openSwitcher(): void {
    if (this.dialog.hasOpen()) {
      return; // an overlay owns the screen — don't stack the switcher over it
    }
    this.status.error.set(null);
    this.switcher
      .pick$()
      .pipe(
        filter((selection) => selection !== null),
        switchMap((selection) => this.workspace.openSearchIntent(selection)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'ready') {
            void this.status.showError(
              'Unable to open that search result right now.',
            );
          }
        },
        error: () =>
          this.status.showError('Unable to open that search result right now.'),
      });
  }
}
