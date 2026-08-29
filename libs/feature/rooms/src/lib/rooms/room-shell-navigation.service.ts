import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable, defer, from, of, tap } from 'rxjs';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { MediaService } from '@trinity/data-access/media';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import {
  AccountScopeService,
  MixedRoomsService,
  RoomsService,
  SpacesService,
  type RoomSummary,
} from '@trinity/data-access/rooms';
import { ThreadsService, TimelineService } from '@trinity/data-access/timeline';
import { BELOW_MEMBERS_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { MruRoomsService } from '../shortcuts/mru-rooms.service';
import type { AccountSwitchDestination } from './account-switch.models';
import { RoomShellStore } from './room-shell-store';

/**
 * Moving around the shell: which scope the sidebar shows, and which room is open.
 *
 * Nine workflows across the other coordinators finish by changing selection, which is why
 * this one exists before them — they inject it rather than reaching back into the page.
 *
 * `focusActiveView` is the one thing that cannot live here. It reads the page's two
 * `viewChild` refs, and a view query only exists on a component, so the page registers a
 * callback through {@link bindFocus} during init. A signal the page reacted to would have
 * worked too, but it would move the focus call from synchronous to post-effect and change
 * when focus lands relative to the render.
 */
@Injectable()
export class RoomShellNavigationService {
  private readonly store = inject(RoomShellStore);
  private readonly rooms = inject(RoomsService);
  private readonly spaces = inject(SpacesService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly media = inject(MediaService);
  private readonly pinned = inject(PinnedMessagesService);
  private readonly threads = inject(ThreadsService);
  private readonly timeline = inject(TimelineService);
  private readonly mru = inject(MruRoomsService);
  private readonly router = inject(Router);

  /**
   * The open room's projections, driven by the URL.
   *
   * One reaction rather than a call at each entry point: a room can now be opened by a click,
   * a keyboard hop, a notification tap, a pasted link, a reload or the Back button, and every
   * one of those is the same paramMap change. When this was a method the entry points had to
   * each remember the same five calls, and `closeOpenRoom` existed precisely because they had
   * already drifted apart once.
   *
   * `media.releaseAll()` runs on every transition including to `null`, because the blobs
   * belong to the room being left in both cases.
   *
   * `clearMarkedUnread` and `focusActiveView` live here rather than in {@link onSelectRoom}
   * for the same reason the projections do: they are properties of a room BECOMING open,
   * not of the click that opened it. A notification tap, a pasted link, a reload and Back
   * all change the URL without going through `onSelectRoom`, and while these were in the
   * click path every one of those left the come-back-to-it flag set and focus on `<body>`.
   *
   * MRU is the one that stays put: recording on every paramMap change would overwrite the
   * stack mid-cycle, which is exactly what `source: 'hop'` exists to prevent.
   *
   * Both of them run inside `untracked`, and that is load-bearing rather than tidiness. An
   * effect tracks every signal read during its synchronous body, CALLEES INCLUDED, and both
   * reach signals that have nothing to do with which room is open: `focusActiveView` reads
   * the `md` media query, `clearMarkedUnread` reads `matrix.accountIds()`. Tracked, this
   * effect would re-run — `media.releaseAll()` and all — on a window resize across 768px or
   * on an account being added, revoking the object URLs of every image currently on screen.
   * `MediaAttachmentComponent` re-resolves only when its input changes, and the memoised
   * `MessageView` keeps that identity stable, so those images would stay broken until the
   * room was closed and re-opened.
   */
  private readonly projectOpenRoom = effect(() => {
    const roomId = this.store.activeRoomId();
    // The focus handoff is about the pane that just BECAME visible. On the effect's first
    // run nothing became anything — the page simply rendered — and moving focus there
    // would scroll the list under the reader and announce it on every cold start.
    const isFirstRun = !this.hasProjected;
    this.hasProjected = true;
    this.media.releaseAll();
    if (!roomId) {
      this.timeline.close();
      this.threads.close();
      this.threads.closeThread();
      this.pinned.close();
      if (!isFirstRun) {
        untracked(() => this.focusActiveView());
      }
      return;
    }
    // All three no-op when `client.getRoom(roomId)` is null, and nothing retries — this
    // effect is their only caller and `activeRoomId` does not change again. What makes a
    // reload into /rooms/<segment> work is that the route does not activate until
    // `authGuard` has restored the client, by which point the room resolves. Measured with
    // the sync store deleted, so the room could only arrive over the network: the timeline
    // rendered. That ordering is load-bearing — if a guard is ever relaxed, this needs a
    // retry rather than silence.
    this.timeline.open(roomId);
    this.threads.open(roomId); // thread summaries, for the per-message indicators
    this.pinned.open(roomId);
    // Opening the room is the user dealing with it, so the come-back-to-it flag goes.
    // Cleared HERE rather than on the auto-ack in TimelineService: that path is gated on
    // the window having focus and dedupes repeat acks, so a room opened in a background
    // window — or re-opened after being acked once — would stay flagged for good.
    untracked(() => this.rooms.clearMarkedUnread(roomId));
    // On the mobile master-detail layout the chat and the list are separate pages, so the
    // one that just became visible has to take focus or it falls to `<body>`. A cold start
    // straight onto /rooms/<segment> is exempt for the reason above — but only the FOCUS
    // is; the room still opens and the flag above is still cleared.
    if (!isFirstRun) {
      untracked(() => this.focusActiveView());
    }
  });
  /**
   * Whether the member list is currently the overlay drawer rather than the static column.
   * Live, and created once against this service's `DestroyRef` — see the same field in
   * `MemberActionsService`.
   */
  private readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    inject(DestroyRef),
  );

  /**
   * Focuses the mobile master-detail pane that just became active.
   *
   * Assigned by the page's constructor, and deliberately NOT optional: an unbound
   * callback throws here instead of silently skipping the focus handoff. It was `?.()`
   * and bound from `ngOnInit`, which meant a missed binding produced no error, no failing
   * test and no focus — keyboard and screen-reader users simply landed on `<body>`.
   */
  private focusActiveView!: () => void;

  /** Whether {@link projectOpenRoom} has run at least once — see the note there. */
  private hasProjected = false;

  bindFocus(focus: () => void): void {
    this.focusActiveView = focus;
  }

  /** Switch to the Recent activity view (all DMs + rooms, mixed); clears any space. */
  onShowRecent(): void {
    this.store.recentView.set(true);
    this.store.roomsView.set(false);
    this.store.activeSpaceId.set(null);
    // Home clears the space hierarchy the same way; keep the sidebar's space extras off.
    this.spaces.openSpace(null);
  }

  onSelectSpace(id: string | null): void {
    // Selecting a space (or Home) leaves the Recent + Rooms views.
    this.store.recentView.set(false);
    this.store.roomsView.set(false);
    this.store.activeSpaceId.set(id);
    // Load (or clear, for Home) the space's full child hierarchy so the sidebar can
    // offer not-yet-joined channels + sub-spaces. The fetch is cancelled/replaced if
    // the selection changes again before it lands.
    this.spaces.openSpace(id);
  }

  /** Switch to the Rooms view (non-DM rooms); clears Recent and any selected space. */
  onShowRooms(): void {
    this.store.recentView.set(false);
    this.store.activeSpaceId.set(null);
    this.store.roomsView.set(true);
  }

  /**
   * Open a room by NAVIGATING to it. The projections follow the URL, not this call.
   *
   * Everything this used to do inline — releasing the previous room's media, opening the
   * timeline, threads and pinned projections — now happens in {@link projectOpenRoom}, which
   * reacts to `store.activeRoomId`. That is what makes the URL authoritative: a room opened
   * by a link, a reload or the Back button goes through exactly the same path as a click,
   * instead of each entry point having to remember the same five calls.
   */
  onSelectRoom(id: string, source: 'user' | 'hop' = 'user'): void {
    void this.router.navigate(['/rooms', encodeRoomSegment(id)]);
    // The only part that cannot move into {@link projectOpenRoom}: the effect cannot tell
    // a deliberate pick from an alt-tab hop, and recording a hop would destroy the stack
    // it is walking.
    if (source === 'user') {
      this.mru.record(id);
    }
  }

  /**
   * Drop the space/Rooms scope back to Recent before an account switch. `activeSpaceId`
   * names a space on the OUTGOING account: SpacesService re-projects onto the new client and
   * wipes it, leaving the sidebar empty, the header falling back to "Home", and the
   * space-only actions (leave / invite / create channel) aimed at a space the now-active
   * account isn't in. A selection that wants a different scope — selecting a foreign space —
   * sets its own afterwards.
   */
  resetViewScope(): void {
    // Only the SPACE scope is account-bound. Recent / Direct Messages / Rooms are filters
    // over whatever the new account has, so preserve the user's choice — resetting it too
    // silently dumped them in Recent mid-task. Fall back to Recent only when a space was
    // open, since that space belongs to the outgoing account.
    if (this.store.activeSpaceId() !== null) {
      this.store.recentView.set(true);
      this.store.roomsView.set(false);
      this.store.activeSpaceId.set(null);
    }
    // The sidebar's filter resets itself when the VIEW changes, and the branch above
    // deliberately leaves Recent / Direct Messages / Rooms alone — so on those three the
    // view key is unchanged and the query would survive into the new account's list,
    // pre-narrowing it (or emptying it) for no reason the user asked for. The rooms
    // underneath changed even though the view did not, which is exactly what the reset is
    // for, so clear it here rather than widening the store's key.
    this.store.roomFilter.set('');
    this.spaces.openSpace(null);
  }

  /**
   * Tear down the open room's panes and forget it. The single definition of "close the
   * open room" — leaving a room, switching account, and destroying the page all need
   * exactly this, and when it was inlined at each site they drifted (one forgot
   * `closeThread()`, leaving an open thread projecting a room the user had left).
   */
  closeOpenRoom(): void {
    // On mobile the member list is an overlay drawer; don't carry an open one over
    // to the next room (it would slide in unrequested). The wide static column keeps
    // its persisted open/closed state.
    if (this.membersAreDrawer()) {
      this.store.rightPanel.set(null);
    }
    void this.router.navigate(['/rooms']);
  }

  /** Prepare the Workspace fallback and release the outgoing Conversation. */
  prepareAccountSwitch(): Observable<boolean> {
    return defer(() => {
      if (this.membersAreDrawer()) {
        this.store.rightPanel.set(null);
      }
      return from(this.router.navigate(['/rooms']));
    }).pipe(
      tap((prepared) => {
        if (prepared) this.releaseOpenRoom();
      }),
    );
  }

  /** Repair the requested Workspace selection after Active Account readiness. */
  repairAccountSelection(
    destination: AccountSwitchDestination,
  ): Observable<boolean> {
    if (destination.kind === 'home') return of(true);
    if (destination.kind === 'space') {
      return defer(() => {
        this.onSelectSpace(destination.spaceId);
        return of(true);
      });
    }
    return defer(() =>
      from(
        this.router.navigate(
          ['/rooms', encodeRoomSegment(destination.roomId)],
          { replaceUrl: true },
        ),
      ),
    ).pipe(
      tap((repaired) => {
        if (repaired && destination.source === 'user') {
          this.mru.record(destination.roomId);
        }
      }),
    );
  }

  /**
   * The teardown half of closing a room, without the navigation.
   *
   * Exists for `RoomsPage.ngOnDestroy`, and only for it. Leaving `/rooms` for settings
   * destroys the page and with it {@link projectOpenRoom}, so nothing would otherwise close
   * the timeline, thread and pinned projections — they are ROOT-scoped and would keep
   * projecting a room nobody is looking at. Navigating from `ngOnDestroy` is not an option:
   * the router is already mid-navigation to wherever the user actually went.
   */
  releaseOpenRoom(): void {
    this.timeline.close();
    this.threads.close();
    this.threads.closeThread();
    this.pinned.close();
    this.media.releaseAll();
  }

  /**
   * Every room the shell can currently open, unfiltered by the active view. `visibleRooms()`
   * is a *filtered* projection (Home shows DMs only, a space shows its children), so an MRU
   * or hop target is routinely absent from it — resolving a row's owning account there would
   * silently miss and open the room on the wrong client.
   */
  knownRooms(): RoomSummary[] {
    return this.accountScope.mixing()
      ? this.mixedRooms.rooms()
      : this.rooms.rooms();
  }
}
