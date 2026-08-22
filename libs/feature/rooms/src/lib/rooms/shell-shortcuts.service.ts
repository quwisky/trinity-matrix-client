import { Injectable, inject } from '@angular/core';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { RoomsService } from '@trinity/data-access/rooms';
import { TrnDialogService } from '@trinity/components/overlay';
import { runWithBusy } from '@trinity/util/ui';
import { MruRoomsService } from '../shortcuts/mru-rooms.service';
import { stepList, stepUnread } from '../shortcuts/room-navigation';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { type SwitcherSelection } from '@trinity/data-access/search';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { ShellStatusService } from './shell-status.service';

/**
 * The keyboard surface: the global chord handler, room hopping and list walking, and the
 * quick switcher.
 *
 * Last of the workflow clusters on purpose. `jumpTo` can land on a room, a space or an
 * invite, so it needs navigation, account routing AND invites to already exist — it is the
 * one method that touches three other coordinators, and it is why invites had to precede
 * shortcuts rather than the other way round.
 */
@Injectable()
export class ShellShortcutsService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly routing = inject(AccountRoutingService);
  private readonly inviteActions = inject(InviteActionsService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomsService);
  private readonly mru = inject(MruRoomsService);
  private readonly switcher = inject(QuickSwitcherService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly dialog = inject(TrnDialogService);

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
            this.mru.nth(hit.digit, this.store.activeRoomId()),
            'user',
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
    const known = new Set(this.nav.knownRooms().map((room) => room.id));
    this.openShortcutTarget(
      this.mru.hop(direction, this.store.activeRoomId(), known),
      'hop',
    );
  }

  // Both walks step through `filteredRooms`, not `visibleRooms`: with the sidebar's filter
  // box active they must not land on a room the user cannot see.
  private walkList(direction: 'next' | 'previous'): void {
    this.openShortcutTarget(
      stepList(
        this.vm.filteredRooms().map((room) => room.id),
        this.store.activeRoomId(),
        direction,
      ),
      'user',
    );
  }

  private walkUnread(direction: 'next' | 'previous'): void {
    this.openShortcutTarget(
      stepUnread(this.vm.filteredRooms(), this.store.activeRoomId(), direction),
      'user',
    );
  }

  /**
   * Open a shortcut's resolved target when there is one and it isn't already open. The MRU
   * remembers rooms across account switches, so a target can name a room no account in the
   * current scope holds (it was unticked, or signed out) — opening that would tear down the
   * timeline and leave a blank chat pane, so drop it instead.
   */
  private openShortcutTarget(
    roomId: string | null,
    source: 'user' | 'hop',
  ): void {
    if (!roomId || roomId === this.store.activeRoomId()) {
      return;
    }
    if (!this.nav.knownRooms().some((room) => room.id === roomId)) {
      return;
    }
    this.routing.onSelectRoomRow(roomId, source);
  }

  /**
   * Open the switcher and jump to the selection: room/DM open the room, space selects
   * it in the rail, a directory person opens (or reuses) a DM, an invite runs the
   * page's existing accept path. Also the header search button's handler.
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
  async openSwitcher(): Promise<void> {
    if (this.dialog.hasOpen()) {
      return; // an overlay owns the screen — don't stack the switcher over it
    }
    const selection = await this.switcher.pick();
    if (!selection) {
      return; // cancelled / already open
    }
    this.jumpTo(selection);
  }

  private jumpTo(selection: SwitcherSelection): void {
    switch (selection.kind) {
      case 'room':
      case 'dm':
        // Via the row path, so picking a mixed-in account's room switches to that account
        // before opening it — otherwise the jump would land on the wrong client.
        this.routing.onSelectRoomRow(selection.id);
        break;
      case 'space':
        this.routing.onSelectSpaceRow(selection.id);
        break;
      case 'user':
        this.status.error.set(null);
        runWithBusy(
          this.rooms.createDirectMessage(selection.id),
          this.status,
        ).subscribe((roomId) => this.nav.onSelectRoom(roomId));
        break;
      case 'invite':
        this.inviteActions.onAcceptInvite({ roomId: selection.id });
        break;
    }
  }
}
