import { Injectable, effect, inject, signal } from '@angular/core';
import { ClientEvent, RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access-matrix-client';
import { sameAccountSet } from './account-scope.service';
import { initialOf, spaceChildIdsOf } from './room-projection';
import { type SpaceSummary } from './spaces.service';

type Listener = () => void;

interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: Listener;
}

/**
 * Cross-account spaces for the mixed-account view: the selected accounts' joined spaces,
 * each tagged with its `accountId` and its joined `childRoomIds`. The child ids
 * let the global mixed Rooms view exclude space-owned rooms across every account (as the
 * single-account view does); a selected space's full hierarchy still loads through
 * {@link SpacesService} once its account is made active (selecting a foreign space switches
 * the active account first).
 *
 * Only attaches listeners for the accounts named by {@link setAccounts}, mirroring
 * {@link MixedRoomsService}.
 */
@Injectable({ providedIn: 'root' })
export class MixedSpacesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _spaces = signal<SpaceSummary[]>([]);
  /** The selected accounts' joined spaces as pills; empty unless mixing. */
  readonly spaces = this._spaces.asReadonly();

  private accounts: ReadonlySet<string> = new Set();
  private readonly listeners = new Map<string, AccountListener>();

  /** Aggregate exactly these accounts; fewer than two is not a mix (see MixedRoomsService). */
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
      this._spaces.set([]);
      return;
    }
    this.syncListeners();
    this.scheduleFlush();
  }

  constructor() {
    // Re-attribute deduped pills when the active account changes (see MixedRoomsService).
    effect(() => {
      this.matrix.activeUserId();
      this.scheduleFlush();
    });
  }

  private syncListeners(): void {
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
        continue;
      }
      const handler: Listener = () => this.scheduleFlush();
      this.attach(client, handler);
      this.listeners.set(userId, { client, handler });
    }
  }

  /**
   * Coalesced through the shared primitive. Keyed on the account set, not one active
   * client, so it takes the batching alone rather than `projectFromClient`.
   */
  private readonly flusher = coalesce(() => {
    if (this.accounts.size > 1) {
      this.syncListeners();
      this.flush();
    }
  });

  private scheduleFlush(): void {
    this.flusher.schedule();
  }

  private flush(): void {
    // One pill per space id, preferring the active account's copy — see MixedRoomsService
    // for why duplicate ids across mixed accounts must not reach the view.
    const active = this.matrix.activeUserId();
    const bySpaceId = new Map<string, SpaceSummary>();
    // Child ids are per-account (each keeps only the children THAT account joined), so the
    // deduped pill must carry the union — otherwise the dropped account's space-owned rooms
    // stop being excluded from the flat Rooms list and reappear there as top-level entries.
    const childrenBySpace = new Map<string, string[]>();
    for (const userId of [...this.listeners.keys()].sort()) {
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue;
      }
      for (const room of client.getRooms()) {
        if (!room.isSpaceRoom() || room.getMyMembership() !== 'join') {
          continue;
        }
        const merged = childrenBySpace.get(room.roomId) ?? [];
        for (const childId of spaceChildIdsOf(client, room)) {
          if (!merged.includes(childId)) {
            merged.push(childId);
          }
        }
        childrenBySpace.set(room.roomId, merged);

        const existing = bySpaceId.get(room.roomId);
        if (existing && !(userId === active && existing.accountId !== active)) {
          continue;
        }
        const name = room.name || room.roomId;
        bySpaceId.set(room.roomId, {
          id: room.roomId,
          accountId: userId,
          name,
          initial: initialOf(name),
          avatarMxc: room.getMxcAvatarUrl(),
          childRoomIds: [],
        });
      }
    }
    const all = [...bySpaceId.values()].map((space) => ({
      ...space,
      childRoomIds: childrenBySpace.get(space.id) ?? [],
    }));
    all.sort((a, b) => a.name.localeCompare(b.name));
    this._spaces.set(all);
  }

  private attach(client: MatrixClient, handler: Listener): void {
    client.on(ClientEvent.Sync, handler);
    client.on(ClientEvent.Room, handler);
    client.on(RoomEvent.Name, handler);
    client.on(RoomEvent.MyMembership, handler);
  }

  private detach(client: MatrixClient, handler: Listener): void {
    client.off(ClientEvent.Sync, handler);
    client.off(ClientEvent.Room, handler);
    client.off(RoomEvent.Name, handler);
    client.off(RoomEvent.MyMembership, handler);
  }
}
