import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  ClientEvent,
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access-matrix-client';
import { isMarkedUnread } from './room-projection';

/** A no-arg listener reused across every unread-affecting client / room event. */
type UnreadListener = () => void;

/** The client + shared handler attached for one account, kept so we can detach it. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: UnreadListener;
}

/**
 * Cross-account unread aggregator. Where {@link RoomsService.totalUnread} sums only the
 * ACTIVE account's rooms, this sums every signed-in account so the app-icon badge — and,
 * later, the account switcher — reflects all of them at once.
 *
 * It attaches a lightweight listener to each account's client (reading notification
 * counts directly, with no full room projection) and reconciles that listener set as
 * accounts are added or removed. Recomputes are coalesced onto a microtask so a sync
 * burst across several accounts rebuilds the totals once; the rebuild writes a signal,
 * which schedules change detection so the badge updates promptly.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAggregatorService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _unreadByAccount = signal<ReadonlyMap<string, number>>(
    new Map(),
  );
  /** Unread notification total per account user id (absent = not yet synced). */
  readonly unreadByAccount = this._unreadByAccount.asReadonly();

  /** App-wide unread total across every signed-in account. Drives the app-icon badge. */
  readonly totalUnread = computed(() => {
    let sum = 0;
    for (const count of this._unreadByAccount().values()) {
      sum += count;
    }
    return sum;
  });

  private readonly listeners = new Map<string, AccountListener>();

  constructor() {
    // Reconcile per-account listeners against the live account set — runs at startup
    // and on every add/remove, attaching to new clients and dropping gone ones.
    effect(() => this.reconcile(this.matrix.accountIds()));
  }

  private reconcile(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const [userId, listener] of this.listeners) {
      if (!live.has(userId)) {
        this.detach(listener.client, listener.handler);
        this.listeners.delete(userId);
      }
    }
    for (const userId of ids) {
      if (this.listeners.has(userId)) {
        continue;
      }
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue; // not fully started yet; a later accountIds tick re-checks it
      }
      const handler: UnreadListener = () => this.scheduleFlush();
      this.attach(client, handler);
      this.listeners.set(userId, { client, handler });
    }
    this.scheduleFlush();
  }

  /**
   * Coalesce a burst of events into one rebuild: recompute the totals on the microtask
   * after the current task drains, deduped by the shared coalescer.
   */
  /**
   * Coalesced through the shared primitive. Keyed on the account set, not one active
   * client, so it takes the batching alone rather than `projectFromClient`.
   */
  private readonly flusher = coalesce(() => {
    // flush() writes the per-account signal, which schedules change detection.
    this.flush();
  });

  private scheduleFlush(): void {
    this.flusher.schedule();
  }

  private flush(): void {
    const counts = new Map<string, number>();
    for (const userId of this.listeners.keys()) {
      counts.set(userId, this.unreadFor(userId));
    }
    this._unreadByAccount.set(counts);
  }

  /**
   * Sum an account's joined, non-space rooms' unread notification counts.
   *
   * A room the user flagged to come back to counts as one, even though the server's count
   * for it is zero — that flag is the only thing saying the room wants attention, and a
   * badge that ignored it would leave "come back to this" visible nowhere but the one
   * sidebar list that happens to show the room.
   */
  private unreadFor(userId: string): number {
    const client = this.matrix.clientFor(userId);
    if (!client) {
      return 0;
    }
    return client
      .getRooms()
      .filter(
        (room) => !room.isSpaceRoom() && room.getMyMembership() === 'join',
      )
      .reduce((sum, room) => {
        const notifications = room.getUnreadNotificationCount(
          NotificationCountType.Total,
        );
        return sum + (notifications || (isMarkedUnread(room) ? 1 : 0));
      }, 0);
  }

  private attach(client: MatrixClient, handler: UnreadListener): void {
    client.on(ClientEvent.Sync, handler);
    client.on(ClientEvent.Room, handler);
    client.on(RoomEvent.MyMembership, handler);
    client.on(RoomEvent.Receipt, handler);
    client.on(RoomEvent.AccountData, handler); // carries the marked-unread flag
  }

  private detach(client: MatrixClient, handler: UnreadListener): void {
    client.off(ClientEvent.Sync, handler);
    client.off(ClientEvent.Room, handler);
    client.off(RoomEvent.MyMembership, handler);
    client.off(RoomEvent.Receipt, handler);
    client.off(RoomEvent.AccountData, handler);
  }
}
