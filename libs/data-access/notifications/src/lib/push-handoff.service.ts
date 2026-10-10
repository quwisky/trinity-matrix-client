import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import {
  ClientEvent,
  EventType,
  RoomEvent,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  PushHandoffBridge,
  type PushHandoffRoom,
} from '@trinity/platform-native';
import { Observable, catchError, defer, from, lastValueFrom, of } from 'rxjs';
import {
  LEGACY_NOTIFICATION_SOUND_EVENT,
  NOTIFICATION_SOUND_EVENT,
  NotificationSoundService,
} from './notification-sound.service';

/** One live account's listeners and what was last written for its rooms. */
interface HandoffBinding {
  readonly client: MatrixClient;
  /** `direct\0name` last written per room, so a sync that changes nothing writes nothing. */
  readonly written: Map<string, string>;
  readonly detach: () => void;
}

/**
 * Keeps the native push handoff store current for every signed-in account, so the
 * closed-app renderers (Android `TrinityMessagingService`, iOS `NotificationService`
 * extension) can fetch and title a notification without the app running.
 *
 * Writes each account's homeserver URL, access token and sound choice when it signs in,
 * when the SDK refreshes its access token and when the sound setting changes; writes room
 * names (as the SDK computes them, DM names included) and DM flags in one batch per sync or
 * rename, only for rooms that changed. Every bridge call runs after the previous one
 * settles, so a removal can never be overtaken by a write that started before it.
 *
 * Active only where {@link PushHandoffBridge.available}: native iOS and Android.
 */
@Injectable({ providedIn: 'root' })
export class PushHandoffService {
  private readonly matrix = inject(MatrixClientService);
  private readonly bridge = inject(PushHandoffBridge);
  private readonly sound = inject(NotificationSoundService);
  private readonly injector = inject(Injector);
  private readonly bindings = new Map<string, HandoffBinding>();
  /**
   * Accounts whose sign-out began, with every client that was live for them then (the bound
   * one and, mid-swap, the one not yet bound): nothing writes those clients again. A new
   * client for the same user is a new sign-in and is written afresh, even when no session
   * saw the account leave in between.
   */
  private readonly retired = new Map<string, Set<MatrixClient>>();
  private tail: Promise<void> = Promise.resolve();

  /** Own the handoff for one Application Runtime session. Never emits. */
  run(): Observable<never> {
    return new Observable<never>(() => {
      if (!this.bridge.available) return undefined;
      const accounts = effect(
        () => {
          const ids = this.matrix.accountIds();
          untracked(() => this.reconcile(ids));
        },
        { injector: this.injector },
      );
      const rotations = this.matrix.accessTokenRotations.subscribe(
        ({ userId, accessToken }) => this.writeAccount(userId, accessToken),
      );
      return () => {
        accounts.destroy();
        rotations.unsubscribe();
        for (const userId of [...this.bindings.keys()]) this.unbind(userId);
      };
    });
  }

  /**
   * Remove one account's entry (its sign-out's first step), or empty the store when no
   * account is given (clear-all-data, or replacing every live account). Cold; errors when
   * the native store refused, so the cleanup that called it can record the residue.
   */
  forget(userId?: string): Observable<void> {
    return defer(() => {
      if (!this.bridge.available) return of(void 0);
      const ids = userId
        ? [userId]
        : [...this.bindings.keys(), ...this.matrix.accountIds()];
      for (const id of ids) {
        const clients = new Set<MatrixClient>();
        const bound = this.bindings.get(id)?.client;
        const current = this.matrix.clientFor(id);
        if (bound) clients.add(bound);
        if (current) clients.add(current);
        if (clients.size > 0) this.retired.set(id, clients);
        this.bindings.get(id)?.written.clear();
      }
      return from(
        this.schedule(() =>
          userId ? this.bridge.removeAccount(userId) : this.bridge.clear(),
        ),
      );
    });
  }

  /**
   * Remove one account's delivered notifications for a room it just opened. Cold, finite
   * and best effort: a native failure completes quietly, so it can never surface in
   * Workspace.
   */
  clearRoom(userId: string, roomId: string): Observable<void> {
    return defer(() =>
      this.bridge.available
        ? this.bridge.clearRoom(userId, roomId)
        : of(void 0),
    ).pipe(catchError(() => of(void 0)));
  }

  private reconcile(ids: readonly string[]): void {
    for (const userId of [...this.bindings.keys()]) {
      if (!ids.includes(userId)) this.unbind(userId);
    }
    // A retired account that has gone may sign in again later and be written afresh.
    for (const userId of [...this.retired.keys()]) {
      if (!ids.includes(userId)) this.retired.delete(userId);
    }
    for (const userId of ids) {
      const client = this.matrix.clientFor(userId);
      const bound = this.bindings.get(userId);
      if (!client || bound?.client === client) continue;
      // The same user signed in again under a new client without leaving the list in
      // between (a re-authentication).
      if (bound) this.unbind(userId);
      this.bind(userId, client);
    }
  }

  private bind(userId: string, client: MatrixClient): void {
    if (!this.isRetired(userId, client)) this.retired.delete(userId);
    const onSync = (state: SyncState): void => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        this.writeRooms(userId);
      }
    };
    const onName = (): void => this.writeRooms(userId);
    const onAccountData = (event: MatrixEvent): void => {
      const type = event.getType();
      if (type === EventType.Direct) {
        this.writeRooms(userId);
      } else if (
        type === NOTIFICATION_SOUND_EVENT ||
        type === LEGACY_NOTIFICATION_SOUND_EVENT
      ) {
        this.writeAccount(userId);
      }
    };
    client.on(ClientEvent.Sync, onSync);
    client.on(RoomEvent.Name, onName);
    client.on(ClientEvent.AccountData, onAccountData);
    this.bindings.set(userId, {
      client,
      written: new Map(),
      detach: () => {
        client.off(ClientEvent.Sync, onSync);
        client.off(RoomEvent.Name, onName);
        client.off(ClientEvent.AccountData, onAccountData);
      },
    });
    this.writeAccount(userId);
    this.writeRooms(userId);
  }

  private unbind(userId: string): void {
    this.bindings.get(userId)?.detach();
    this.bindings.delete(userId);
  }

  /** `accessToken` is passed on rotation: the SDK adopts the new token after this runs. */
  private writeAccount(userId: string, accessToken?: string): void {
    const binding = this.bindings.get(userId);
    if (!binding || this.isRetired(userId, binding.client)) return;
    const token = accessToken ?? binding.client.getAccessToken();
    if (!token) return;
    const account = {
      userId,
      homeserverUrl: binding.client.getHomeserverUrl(),
      accessToken: token,
      sound: this.sound.isOn(userId),
    };
    void this.schedule(() => this.bridge.setAccount(account)).catch(
      () => undefined,
    );
  }

  private writeRooms(userId: string): void {
    const binding = this.bindings.get(userId);
    if (!binding || this.isRetired(userId, binding.client)) return;
    const direct = directRoomIds(binding.client);
    const changed: PushHandoffRoom[] = [];
    for (const room of binding.client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue;
      const entry = {
        roomId: room.roomId,
        name: room.name,
        direct: direct.has(room.roomId),
      };
      const key = `${entry.direct ? 1 : 0}\u0000${entry.name}`;
      if (binding.written.get(entry.roomId) === key) continue;
      binding.written.set(entry.roomId, key);
      changed.push(entry);
    }
    if (changed.length === 0) return;
    void this.schedule(() => this.bridge.setRooms(userId, changed)).catch(
      () => {
        // Forget what was not stored, so the next sync writes it again.
        for (const room of changed) binding.written.delete(room.roomId);
      },
    );
  }

  private isRetired(userId: string, client: MatrixClient): boolean {
    return this.retired.get(userId)?.has(client) ?? false;
  }

  private schedule(operation: () => Observable<void>): Promise<void> {
    const next = this.tail.then(() =>
      lastValueFrom(operation(), { defaultValue: undefined }),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Room ids the `m.direct` account data lists as DMs. */
function directRoomIds(client: MatrixClient): ReadonlySet<string> {
  const map =
    client
      .getAccountData(EventType.Direct)
      ?.getContent<Record<string, unknown>>() ?? {};
  const ids = new Set<string>();
  for (const roomIds of Object.values(map)) {
    if (!Array.isArray(roomIds)) continue;
    for (const roomId of roomIds) {
      if (typeof roomId === 'string') ids.add(roomId);
    }
  }
  return ids;
}
