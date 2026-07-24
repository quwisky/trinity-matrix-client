import { Injectable, inject, signal } from '@angular/core';
import { ClientEvent, RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { initialOf, spaceChildIdsOf } from './room-projection';
import { type SpaceSummary } from './spaces.service';

type Listener = () => void;

interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: Listener;
}

/**
 * Cross-account spaces for the mixed-account view: every signed-in account's joined
 * spaces, each tagged with its `accountId` and its joined `childRoomIds`. The child ids
 * let the global mixed Rooms view exclude space-owned rooms across every account (as the
 * single-account view does); a selected space's full hierarchy still loads through
 * {@link SpacesService} once its account is made active (selecting a foreign space switches
 * the active account first).
 *
 * Only attaches per-account listeners while {@link setEnabled enabled}, mirroring
 * {@link MixedRoomsService}.
 */
@Injectable({ providedIn: 'root' })
export class MixedSpacesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _spaces = signal<SpaceSummary[]>([]);
  /** Every signed-in account's joined spaces as pills; empty while disabled. */
  readonly spaces = this._spaces.asReadonly();

  private enabled = false;
  private readonly listeners = new Map<string, AccountListener>();
  private flushScheduled = false;

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
      this._spaces.set([]);
    }
  }

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
      if (this.enabled) {
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
