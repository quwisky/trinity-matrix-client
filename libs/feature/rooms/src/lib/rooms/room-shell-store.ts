import { Injectable, inject, linkedSignal } from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';

/**
 * The rooms shell's own selection and pane state.
 *
 * `@Injectable()` with no `providedIn`: it is listed in `RoomsPage`'s `providers:` so it
 * shares the page's lifetime and its `DestroyRef`. `providedIn: 'root'` would keep selection
 * alive across navigations (returning to `/rooms` with a room marked active but its panes
 * already closed by `ngOnDestroy`) and would leak every `runWithBusy` subscription that later
 * coordinators tie to the page's DestroyRef. `shell-invariants.spec.ts` pins that distinction.
 *
 * Signals only. Nothing here derives, fetches or subscribes, which lets the view model and
 * the workflow coordinators both depend on it without a cycle.
 */
@Injectable()
export class RoomShellStore {
  private readonly workspace = inject(WorkspaceNavigationService);

  readonly activeAccountId = this.workspace.activeAccountId;
  readonly activeSpaceId = this.workspace.activeSpaceId;

  /**
   * Whether the Recent activity view is active — the default on launch. It lists every
   * joined DM + room (space-owned included), mixed by recency, so it overrides the
   * Home/Rooms/space scoping. Cleared by selecting Home, Rooms, or a space.
   */
  readonly recentView = this.workspace.recentView;

  /** Whether the Rooms view is active — filters the sidebar to non-DM rooms. Home (no
   * space) shows direct messages only; Recent, a space, or this view clears the others. */
  readonly roomsView = this.workspace.roomsView;

  /**
   * The selected room, DERIVED from the Workspace URL and never assigned.
   *
   * `/rooms/:roomId` is the single source of truth, which keeps a room linkable, bookmarkable
   * and survivable across a reload. The pane coordinate separately decides whether compact
   * layouts show that Conversation or the list, so returning to the list can retain selection.
   * Selecting a room is therefore a NAVIGATION (`RoomShellNavigationService.onSelectRoom`) and
   * this follows; a writable signal let the URL and the selected room disagree.
   *
   * `decodeRoomSegment` answers `null` for a segment that is not one of ours (a hand-typed or
   * truncated URL), so a bad link lands on the room list rather than asking the SDK for a
   * room id that cannot exist.
   */
  readonly activeRoomId = this.workspace.activeRoomId;
  readonly pane = this.workspace.pane;
  readonly placement = this.workspace.placement;

  /**
   * The sidebar's in-place room filter.
   *
   * Lives here rather than inside `ChannelSidebarComponent` because two consumers have to
   * agree on it: the list the sidebar renders, and the Alt+↑/↓ room walk in
   * `ShellShortcutsService`. A filter owned by the component would leave the walk stepping
   * through rooms that are not on screen. `ReadStateService` ("mark all as read") and
   * `RoomActionsService` (name lookup by id) deliberately keep reading the UNFILTERED
   * `visibleRooms` — they act on rooms rather than showing them.
   *
   * Reset whenever the shell switches which list it is showing, so a filter typed in one
   * space cannot silently narrow the next one. The source is the real view identity, not a
   * display name, so two spaces sharing a name still reset.
   */
  readonly roomFilter = linkedSignal<string, string>({
    source: () =>
      `${this.workspace.activeAccountId() ?? ''}|${this.recentView()}|${this.roomsView()}|${this.activeSpaceId() ?? ''}`,
    computation: () => '',
  });
}
