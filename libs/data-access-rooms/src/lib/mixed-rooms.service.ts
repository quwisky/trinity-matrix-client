import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import {
  buildRoomSummary,
  compareRoomSummaries,
  directMapOf,
} from './room-projection';
import { type RoomSummary } from './rooms.service';

/** A no-arg listener reused across every room-affecting event of one account. */
type Listener = () => void;

/** The client + shared handler attached for one account, kept so we can detach it. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: Listener;
}

/**
 * Cross-account room projection for the mixed-account view. Where {@link RoomsService}
 * projects only the ACTIVE account's rooms, this aggregates **every** signed-in account's
 * joined non-space rooms into one list, each row tagged with its `accountId` (and its own
 * account's `m.direct` DM classification), sorted favourite-first then most-recent across
 * accounts.
 *
 * Only attaches its per-account listeners while {@link setEnabled enabled} (the mixed
 * toggle), so single-account / toggle-off users pay nothing. Mirrors
 * {@link UnreadAggregatorService}'s reconcile-and-coalesce shape.
 */
@Injectable({ providedIn: 'root' })
export class MixedRoomsService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _rooms = signal<RoomSummary[]>([]);
  /** Every signed-in account's joined rooms, mixed and sorted; empty while disabled. */
  readonly rooms = this._rooms.asReadonly();

  private enabled = false;
  private readonly listeners = new Map<string, AccountListener>();
  private flushScheduled = false;

  /**
   * Turn the aggregation on or off. Enabling attaches listeners to every account's client
   * and does a first read; disabling detaches everything and clears the list.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) {
      return;
    }
    this.enabled = on;
    if (on) {
      this.syncListeners();
      this.scheduleFlush();
    } else {
      for (const { client, handler } of this.listeners.values()) {
        this.detach(client, handler);
      }
      this.listeners.clear();
      this._rooms.set([]);
    }
  }

  /** Reconcile the per-account listener set against the live accounts (attach/detach). */
  private syncListeners(): void {
    const live = new Set(this.matrix.accountIds());
    for (const [userId, listener] of this.listeners) {
      if (!live.has(userId)) {
        this.detach(listener.client, listener.handler);
        this.listeners.delete(userId);
      }
    }
    for (const userId of this.matrix.accountIds()) {
      if (this.listeners.has(userId)) {
        continue;
      }
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue; // not fully started yet; a later event re-checks it
      }
      const handler: Listener = () => this.scheduleFlush();
      this.attach(client, handler);
      this.listeners.set(userId, { client, handler });
    }
  }

  /** Coalesce a burst of events into one rebuild on the next microtask. */
  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.enabled) {
        // An account can be added/removed between flushes; keep the listener set current,
        // then flush() writes the signal (which schedules change detection).
        this.syncListeners();
        this.flush();
      }
    });
  }

  private flush(): void {
    const all: RoomSummary[] = [];
    for (const userId of this.listeners.keys()) {
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue;
      }
      const { userByRoom } = directMapOf(client);
      for (const room of client.getRooms()) {
        if (room.isSpaceRoom() || room.getMyMembership() !== 'join') {
          continue;
        }
        all.push(buildRoomSummary(room, userId, userByRoom.get(room.roomId)));
      }
    }
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
    client.off(MatrixEventEvent.Decrypted, handler);
    client.off(RoomStateEvent.Members, handler);
  }
}
