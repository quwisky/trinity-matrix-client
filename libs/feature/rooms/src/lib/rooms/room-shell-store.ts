import {
  Injectable,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { decodeRoomSegment } from '@trinity/util/matrix';
import type { MemberSummary, ModerationCaps } from '@trinity/data-access/rooms';
import { BELOW_MEMBERS_QUERY, matchesQuery } from '@trinity/util/ui';

/**
 * The surfaces that can occupy the shell's right-hand slot.
 *
 * `null` is "nothing showing", which on the narrow layout is the only honest state — the slot
 * is an overlay drawer there, and an overlay that is always open is what the member list used
 * to be before this phase.
 */
export type RightPanel =
  | { readonly kind: 'members' }
  | { readonly kind: 'threads' }
  | { readonly kind: 'thread'; readonly rootEventId: string }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'search' }
  // Member info carries its subject AND the viewer's power over them, because the caps are
  // resolved against the room at the moment the row is clicked. Recomputing them from the
  // slot later would ask a different question — "can I moderate them now" — which is the
  // same answer today and not the one the panel was opened with.
  | {
      readonly kind: 'member';
      readonly member: MemberSummary;
      readonly caps: ModerationCaps;
      readonly direct: boolean;
    }
  | null;

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
   * What the right-hand slot is showing, if anything.
   *
   * ONE slot, not five independent flags. The member list was a column with its own boolean
   * while threads, the threads list, pinned messages and search were CDK dialogs with
   * `side: 'end'` — so they stacked OVER the member list rather than sharing the layout with
   * it, and only one could be open at a time by accident (each service kept its own
   * re-entrancy guard) rather than by design. A single slot makes "only one" structural:
   * opening threads while members is showing replaces it, because there is one value.
   *
   * A discriminated union rather than a string, because two of the surfaces carry data —
   * a thread needs its root event, a member card needs its member — and a bare
   * `'thread' | null` would have to be shadowed by a second signal holding the id, which is
   * the invalid-state-is-representable shape this exists to avoid.
   */
  readonly rightPanel = signal<RightPanel>(
    // Seeded to the member list at the wide layout, closed below it — which is what the
    // member column has always done. `matchesQuery` and deliberately NOT `mediaQuerySignal`:
    // this SEEDS a state the user then owns, and a live signal would re-evaluate on every
    // rotation across the boundary and reopen a panel the user had explicitly closed.
    //
    // Negated rather than asking `MEMBERS_QUERY` directly, because `matchesQuery` answers
    // `false` where `matchMedia` does not exist and the two directions disagree about what
    // that should mean. Asking the BELOW query makes the unknown case the static column,
    // which is what this has always done.
    matchesQuery(BELOW_MEMBERS_QUERY) ? null : { kind: 'members' },
  );

  /** Whether the member list is the surface currently in the slot. */
  readonly membersOpen = computed(() => this.rightPanel()?.kind === 'members');

  /**
   * Event id the message list should scroll to, set by in-room search, a reply
   * preview, or the pinned panel. Bound to the list's `jumpToId`, paired with
   * {@link jumpRequest} so re-selecting the SAME message still re-triggers the jump.
   */
  readonly messageSearchTarget = signal<string | null>(null);

  /** Bumped on every jump request so the list re-jumps even to an unchanged target. */
  readonly jumpRequest = signal(0);
}
