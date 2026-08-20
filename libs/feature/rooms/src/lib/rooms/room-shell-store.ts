import { Injectable, inject, linkedSignal, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { decodeRoomSegment } from '@trinity/util/matrix';
import { BELOW_MEMBERS_QUERY, matchesQuery } from '@trinity/util/ui';

/**
 * The rooms shell's own selection and pane state.
 *
 * Deliberately `@Injectable()` with no `providedIn`: this is listed in `RoomsPage`'s
 * `providers:` array so it shares the page's lifetime and its `DestroyRef`. Making it
 * `providedIn: 'root'` would keep selection alive across navigations — you would return
 * to `/rooms` with a room still marked active but its panes already closed by
 * `ngOnDestroy` — and would leak every `runWithBusy` subscription that later coordinators
 * tie to the page's DestroyRef. `shell-invariants.spec.ts` pins that distinction.
 *
 * Signals only. Nothing here derives, fetches or subscribes, which is what lets the view
 * model and the workflow coordinators both depend on it without a cycle.
 */
@Injectable()
export class RoomShellStore {
  readonly activeSpaceId = signal<string | null>(null);

  /**
   * Whether the Recent activity view is active — the default on launch. It lists every
   * joined DM + room (space-owned included), mixed by recency, so it overrides the
   * Home/Rooms/space scoping. Cleared by selecting Home, Rooms, or a space.
   */
  readonly recentView = signal(true);

  /** Whether the Rooms view is active — filters the sidebar to non-DM rooms. Home (no
   * space) shows direct messages only; Recent, a space, or this view clears the others. */
  readonly roomsView = signal(false);

  /**
   * The open room — DERIVED from the URL, never assigned.
   *
   * `/rooms/:roomId` is the single source of truth, which is what makes a room linkable,
   * bookmarkable and survivable across a reload, and what makes Android's hardware Back close
   * the room instead of walking out of the shell. Opening a room is therefore a NAVIGATION
   * (`RoomShellNavigationService.onSelectRoom`), and this follows; nothing writes it.
   *
   * That direction matters beyond tidiness. When this was a writable signal the URL and the
   * open room could disagree, and did: a notification tap wrote `?room=` and the page then
   * stripped the param back off, so the address bar described a room the shell was not
   * showing for as long as the strip took to land.
   *
   * `decodeRoomSegment` answers `null` for a segment that is not one of ours — a hand-typed
   * or truncated URL — so a bad link lands on the room list rather than asking the SDK for a
   * room id that cannot exist.
   */
  readonly activeRoomId = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => {
        const segment = params.get('roomId');
        return segment ? decodeRoomSegment(segment) : null;
      }),
    ),
    { initialValue: null },
  );

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
      `${this.recentView()}|${this.roomsView()}|${this.activeSpaceId() ?? ''}`,
    computation: () => '',
  });

  /**
   * Whether the member list is shown. At or above the `members` breakpoint it's the static
   * right column, shown by default; below it an overlay drawer that must start closed.
   * Seeded from the viewport so the drawer doesn't render open on a mobile load, while the
   * wide layout keeps the column visible by default.
   *
   * A one-shot `matchesQuery` and deliberately NOT `mediaQuerySignal`: this is a SEED for a
   * state the user then owns. A live signal would re-evaluate on every rotation across the
   * boundary and reopen a column the user had explicitly closed.
   *
   * Negated rather than asking `MEMBERS_QUERY` directly, because `matchesQuery` answers
   * `false` where `matchMedia` does not exist and the two directions disagree about what
   * that should mean. Asking the BELOW query makes the unknown case the static column, which
   * is what this has always done — asking the min-width one would silently make a context
   * with no `matchMedia` start with the list hidden.
   */
  readonly membersOpen = signal(!matchesQuery(BELOW_MEMBERS_QUERY));

  /**
   * Event id the message list should scroll to, set by in-room search, a reply
   * preview, or the pinned panel. Bound to the list's `jumpToId`, paired with
   * {@link jumpRequest} so re-selecting the SAME message still re-triggers the jump.
   */
  readonly messageSearchTarget = signal<string | null>(null);

  /** Bumped on every jump request so the list re-jumps even to an unchanged target. */
  readonly jumpRequest = signal(0);
}
