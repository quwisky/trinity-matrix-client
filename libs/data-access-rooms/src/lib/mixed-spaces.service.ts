import { Injectable, inject, signal } from '@angular/core';
import { ClientEvent, RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
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
  private flushScheduled = false;

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
      if (this.listeners.has(userId)) {
        continue;
      }
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue;
      }
      const handler: Listener = () => this.scheduleFlush();
      this.attach(client, handler);
      this.listeners.set(userId, { client, handler });
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.accounts.size > 1) {
        this.syncListeners();
        this.flush();
      }
    });
  }

  private flush(): void {
    const all: SpaceSummary[] = [];
    for (const userId of this.listeners.keys()) {
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue;
      }
      for (const room of client.getRooms()) {
        if (!room.isSpaceRoom() || room.getMyMembership() !== 'join') {
          continue;
        }
        const name = room.name || room.roomId;
        all.push({
          id: room.roomId,
          accountId: userId,
          name,
          initial: initialOf(name),
          avatarMxc: room.getMxcAvatarUrl(),
          childRoomIds: spaceChildIdsOf(client, room),
        });
      }
    }
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
