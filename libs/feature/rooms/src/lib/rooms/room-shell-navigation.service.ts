import { Injectable, inject } from '@angular/core';
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
import { MruRoomsService } from '../shortcuts/mru-rooms.service';
import { RoomShellStore } from './room-shell-store';
import { membersShownAsDrawer } from './shell-layout';

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

  /** Set by the page; focuses the mobile master-detail pane that just became active. */
  private focusActiveView?: () => void;

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

  onSelectRoom(id: string, source: 'user' | 'hop' = 'user'): void {
    // Drop the previous room's resolved media URLs before switching timelines.
    this.media.releaseAll();
    this.store.activeRoomId.set(id);
    this.timeline.open(id);
    this.threads.open(id); // project this room's thread summaries for indicators
    this.pinned.open(id); // project this room's pinned messages
    if (source === 'user') {
      this.mru.record(id);
    }
    // Opening the room is the user dealing with it, so the come-back-to-it flag goes.
    // Cleared HERE rather than on the auto-ack in TimelineService: that path is gated on
    // the window having focus and dedupes repeat acks, so a room opened in a background
    // window — or re-opened after being acked once — would stay flagged for good.
    this.rooms.clearMarkedUnread(id);
    // On mobile, setting activeRoomId switches from the room-list page to the chat.
    this.focusActiveView?.();
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
    if (membersShownAsDrawer()) {
      this.store.membersOpen.set(false);
    }
    this.store.activeRoomId.set(null);
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
