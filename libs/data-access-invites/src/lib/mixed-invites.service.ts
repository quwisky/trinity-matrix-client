import { Injectable, effect, inject, signal } from '@angular/core';
import { ClientEvent, RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { buildInvite, type PendingInvite } from './invites.service';

/** A no-arg listener reused across every invite-affecting event of one account. */
type Listener = () => void;

/** The client + shared handler attached for one account, kept so we can detach it. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: Listener;
}

/** Whether two id sets hold the same members (order-independent). */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * Cross-account pending invites for the mixed-account view: every selected account's
 * invited rooms in one list, each tagged with the account it was sent to.
 *
 * Without this an invite to a mixed-in account is invisible — it has no sidebar row, no
 * quick-switcher entry and no badge anywhere — until the user happens to make that account
 * active, which is exactly the blind spot mixing exists to remove.
 *
 * Accepting/declining routes back to the owning account via
 * {@link InvitesService.acceptInvite}, so no account switch is needed to answer one.
 */
@Injectable({ providedIn: 'root' })
export class MixedInvitesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _invites = signal<PendingInvite[]>([]);
  /** The selected accounts' pending invites; empty unless mixing. */
  readonly invites = this._invites.asReadonly();

  private accounts: ReadonlySet<string> = new Set();
  private readonly listeners = new Map<string, AccountListener>();
  private flushScheduled = false;

  constructor() {
    // An invite can arrive on an account while a different one is active, and the active
    // account's own traffic is what would otherwise drive a re-read.
    effect(() => {
      this.matrix.activeUserId();
      this.scheduleFlush();
    });
  }

  /** Aggregate exactly these accounts; fewer than two is not a mix (see MixedRoomsService). */
  setAccounts(ids: ReadonlySet<string>): void {
    const next = ids.size > 1 ? ids : new Set<string>();
    if (sameSet(next, this.accounts)) {
      return;
    }
    this.accounts = next;
    if (next.size === 0) {
      for (const { client, handler } of this.listeners.values()) {
        this.detach(client, handler);
      }
      this.listeners.clear();
      this._invites.set([]);
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
      const client = this.matrix.clientFor(userId);
      const held = this.listeners.get(userId);
      if (held) {
        // A re-added account gets a NEW client object under the same id; holding the old
        // one strands the listener on a stopped client.
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
    const all: PendingInvite[] = [];
    for (const userId of [...this.listeners.keys()].sort()) {
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue;
      }
      for (const room of client.getRooms()) {
        if (room.getMyMembership() === 'invite') {
          all.push(buildInvite(client, room, userId));
        }
      }
    }
    all.sort((a, b) => a.name.localeCompare(b.name));
    this._invites.set(all);
  }

  private attach(client: MatrixClient, handler: Listener): void {
    client.on(ClientEvent.Sync, handler);
    client.on(ClientEvent.Room, handler);
    client.on(RoomEvent.MyMembership, handler);
    client.on(RoomEvent.Name, handler);
  }

  private detach(client: MatrixClient, handler: Listener): void {
    client.off(ClientEvent.Sync, handler);
    client.off(ClientEvent.Room, handler);
    client.off(RoomEvent.MyMembership, handler);
    client.off(RoomEvent.Name, handler);
  }
}
