import { Injectable, effect, inject, signal } from '@angular/core';
import {
  ClientEvent,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';
import { sameAccountSet } from './account-scope.service';
import {
  buildRoomSummary,
  compareRoomSummaries,
  directMapOf,
} from './room-projection';
import { type RoomSummary } from './room-library.service';

/** A no-arg listener reused across every room-affecting event of one account. */
type Listener = () => void;

/** The client + shared handler attached for one account, kept so we can detach it. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: Listener;
}

/**
 * Cross-account room projection for the mixed-account view. Where {@link RoomLibraryService}
 * projects only the ACTIVE account's rooms, this aggregates **every** signed-in account's
 * joined non-space rooms into one list, each row tagged with its `accountId` (and its own
 * account's `m.direct` DM classification), sorted favourite-first then most-recent across
 * accounts.
 *
 * Only attaches listeners for the accounts named by {@link setAccounts} (the user's picker
 * selection), so you pay for exactly the accounts you mix and nothing when you don't mix at
 * all. Mirrors {@link UnreadAggregatorService}'s reconcile-and-coalesce shape.
 */
@Injectable({ providedIn: 'root' })
export class MixedRoomsService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _rooms = signal<RoomSummary[]>([]);
  /** The selected accounts' joined rooms, mixed and sorted; empty unless mixing. */
  readonly rooms = this._rooms.asReadonly();

  private accounts: ReadonlySet<string> = new Set();
  private readonly listeners = new Map<string, AccountListener>();

  /**
   * Aggregate exactly these accounts (the user's mixed-account selection). Fewer than two is
   * not a mix — the single-account {@link RoomLibraryService} covers that — so the projection
   * detaches and empties, and only the selected accounts ever get listeners attached.
   */
  setAccounts(ids: ReadonlySet<string>): void {
    const next = ids.size > 1 ? ids : new Set<string>();
    if (sameAccountSet(next, this.accounts)) {
      return;
    }
    this.accounts = next;
    if (next.size === 0) {
      for (const { client, handler } of this.listeners.values()) {
        this.detach(client, handler);
      }
      this.listeners.clear();
      this._rooms.set([]);
      return;
    }
    this.syncListeners();
    // Selection is a generation boundary for the public selected view. Rebuild now so
    // its Room, Space, and invitation rows can be published together; SDK event bursts
    // still use the coalesced path below.
    this.flush();
  }

  constructor() {
    // The dedupe below prefers the ACTIVE account's copy of a shared room, so a switch has
    // to re-attribute those rows. Nothing else triggers it: the selection set is unchanged
    // by a switch, so both setAccounts() and the page's effect early-return.
    effect(() => {
      this.matrix.activeUserId();
      this.scheduleFlush();
    });
  }

  /** Reconcile the per-account listener set against the selection (attach/detach). */
  private syncListeners(): void {
    // Only accounts that are both selected and still signed in.
    const live = new Set(this.matrix.accountIds());
    const wanted = new Set<string>();
    for (const id of this.accounts) {
      if (live.has(id)) {
        wanted.add(id);
      }
    }
    for (const [userId, listener] of this.listeners) {
      if (!wanted.has(userId)) {
        this.detach(listener.client, listener.handler);
        this.listeners.delete(userId);
      }
    }
    for (const userId of wanted) {
      const client = this.matrix.clientFor(userId);
      const held = this.listeners.get(userId);
      if (held) {
        // Same user id can get a NEW client object (re-adding an already signed-in account
        // stops and re-creates it). Holding the old one strands the listener on a stopped
        // client and that account silently stops updating.
        if (held.client === client) {
          continue;
        }
        this.detach(held.client, held.handler);
        this.listeners.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later event re-checks it
      }
      const handler: Listener = () => this.scheduleFlush();
      this.attach(client, handler);
      this.listeners.set(userId, { client, handler });
    }
  }

  /**
   * Coalesce a burst of events into one rebuild on the next microtask, via the shared
   * primitive. This service is keyed on the ACCOUNT SET rather than one active client, so
   * it takes the batching alone and not `projectFromClient` — the same split
   * Timeline and exact-Conversation pin projections use.
   */
  private readonly flusher = coalesce(() => {
    if (this.accounts.size > 1) {
      // An account can be added/removed between flushes; keep the listener set current,
      // then flush() writes the signal (which schedules change detection).
      this.syncListeners();
      this.flush();
    }
  });

  private scheduleFlush(): void {
    this.flusher.schedule();
  }

  private flush(): void {
    // Two mixed accounts can be joined to the SAME room (a shared public room, or a DM
    // between your own two accounts). Emitting both would put duplicate ids in the list:
    // `@for`'s track key collides (NG0955) and every `find(r => r.id === …)` lookup would
    // resolve to an arbitrary one — so clicking the row badged A could open it as B.
    // Keep one row per room id, preferring the active account's copy so opening it acts as
    // the account you're already using. Accounts are visited in a stable order so the
    // fallback pick doesn't flip between flushes.
    const active = this.matrix.activeUserId();
    const byRoomId = new Map<string, RoomSummary>();
    for (const userId of [...this.listeners.keys()].sort()) {
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue;
      }
      const { userByRoom } = directMapOf(client);
      for (const room of client.getRooms()) {
        if (room.isSpaceRoom() || room.getMyMembership() !== 'join') {
          continue;
        }
        const summary = buildRoomSummary(
          room,
          userId,
          userByRoom.get(room.roomId),
        );
        const existing = byRoomId.get(room.roomId);
        if (!existing) {
          byRoomId.set(room.roomId, summary);
          continue;
        }
        // Same room on two accounts: keep one identity but carry the LOUDEST unread of the
        // two, or a mention that arrived on the copy we drop would be invisible — the row
        // and the rail badge would both read as read.
        const winner =
          userId === active && existing.accountId !== active
            ? summary
            : existing;
        byRoomId.set(room.roomId, {
          ...winner,
          // Both memberships travel with the row: the merged unread below is the loudest of
          // the two, and only an action that reaches BOTH accounts can clear it again.
          accountIds: [...existing.accountIds, userId],
          unreadCount: Math.max(existing.unreadCount, summary.unreadCount),
          highlightCount: Math.max(
            existing.highlightCount,
            summary.highlightCount,
          ),
          hasUnread: existing.hasUnread || summary.hasUnread,
          // OR'd for the same reason as hasUnread: taking it from the winner alone would
          // leave the row reading as unread while claiming it is not flagged, which is
          // both the wrong menu item and a badge with no count behind it.
          markedUnread: existing.markedUnread || summary.markedUnread,
          // OR'd deliberately: demoting a room on one account demotes the merged row for
          // both. Taking it from the winner instead would move the row between groups as
          // you switch active account, which reads as a bug rather than a preference.
          // `favourite` is NOT merged this way — it rides the winner, as it always has —
          // so the two flags disagree on purpose; see the note on RoomSummary.lowPriority.
          lowPriority: existing.lowPriority || summary.lowPriority,
        });
      }
    }
    const all = [...byRoomId.values()];
    all.sort(compareRoomSummaries);
    this._rooms.set(all);
  }

  private attach(client: MatrixClient, handler: Listener): void {
    client.on(ClientEvent.Sync, handler);
    client.on(ClientEvent.Room, handler);
    client.on(RoomEvent.Name, handler);
    client.on(RoomEvent.MyMembership, handler);
    client.on(RoomEvent.Receipt, handler);
    client.on(RoomEvent.Tags, handler);
    // Room account data carries the marked-unread flag; without this the mixed list
    // only picks it up when some unrelated event happens to fire.
    client.on(RoomEvent.AccountData, handler);
    client.on(MatrixEventEvent.Decrypted, handler);
    client.on(RoomStateEvent.Members, handler);
  }

  private detach(client: MatrixClient, handler: Listener): void {
    client.off(ClientEvent.Sync, handler);
    client.off(ClientEvent.Room, handler);
    client.off(RoomEvent.Name, handler);
    client.off(RoomEvent.MyMembership, handler);
    client.off(RoomEvent.Receipt, handler);
    client.off(RoomEvent.Tags, handler);
    client.off(RoomEvent.AccountData, handler);
    client.off(MatrixEventEvent.Decrypted, handler);
    client.off(RoomStateEvent.Members, handler);
  }
}
