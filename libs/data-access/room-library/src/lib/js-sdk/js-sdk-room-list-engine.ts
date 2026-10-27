import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  EventType,
  MatrixError,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  Subject,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  filter,
  from,
  map,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  RoomEncryptionFlags,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
  type EngineFailure,
  type EngineResult,
  type VectorDiff,
} from '@trinity/util/matrix';
import type {
  CreateRoomRequest,
  RoomInfo,
  RoomListEngine,
  TypingMember,
} from '../room-list-engine';
import { createEncryptedRoom, openDirectRoom } from './direct-rooms';
import { directMapOf, isMarkedUnread, toRoomInfo } from './room-info';
import { roomTyping } from './room-typing';

const LISTED = new Set(['join', 'invite', 'knock']);

/** How long a create or leave waits for `/sync` to show its effect before replying anyway. */
const SETTLE_TIMEOUT_MS = 15_000;

const INVITE_BLOCKED_ERRCODES = new Set([
  'M_INVITE_BLOCKED',
  'ORG.MATRIX.MSC4155.INVITE_BLOCKED',
]);

/** The invitee blocks invites (MSC4380), so the invite was refused. */
export function isInviteBlocked(error: unknown): boolean {
  return (
    error instanceof MatrixError &&
    INVITE_BLOCKED_ERRCODES.has(error.errcode ?? '')
  );
}

const ACCOUNT_NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

function inviteFailed(error: unknown): EngineFailure {
  if (!isInviteBlocked(error)) return requestFailed(error);
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return { kind, code: 'invite-blocked', diagnostic };
}

/** The raw `m.direct` map, left rooms included, keeping only well-formed entries. */
function directContent(
  client: MatrixClient,
): Readonly<Record<string, readonly string[]>> {
  const content = client.getAccountData?.(EventType.Direct)?.getContent() ?? {};
  const map: Record<string, string[]> = {};
  for (const [userId, roomIds] of Object.entries(content)) {
    if (Array.isArray(roomIds)) {
      map[userId] = roomIds.filter(
        (id): id is string => typeof id === 'string',
      );
    }
  }
  return map;
}

/** Resolves once `done(room)` holds, sync stops, or {@link SETTLE_TIMEOUT_MS} passes. */
function settled(
  client: MatrixClient,
  roomId: string,
  done: (room: Room | null) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (done(client.getRoom(roomId))) finish();
    };
    const onSync = (state: SyncState): void => {
      if (state === SyncState.Stopped) finish();
    };
    const timer = setTimeout(() => finish(), SETTLE_TIMEOUT_MS);
    function finish(): void {
      clearTimeout(timer);
      client.off(ClientEvent.Room, check);
      client.off(RoomEvent.MyMembership, check);
      client.off(ClientEvent.Sync, onSync);
      resolve();
    }
    client.on(ClientEvent.Room, check);
    client.on(RoomEvent.MyMembership, check);
    client.on(ClientEvent.Sync, onSync);
    check();
  });
}

const joined = (room: Room | null): boolean =>
  room?.getMyMembership() === 'join';

/** The newest event the server has confirmed, skipping local echoes. */
function latestConfirmed(room: Room | null): MatrixEvent | null {
  const events = room?.getLiveTimeline().getEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (!events[i].status) return events[i];
  }
  return null;
}

/** {@link RoomListEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkRoomListEngine implements RoomListEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  /** A client whose list must be re-read now: a write the SDK does not echo locally. */
  private readonly written$ = new Subject<MatrixClient>();

  rooms(accountId: string): Observable<readonly VectorDiff<RoomInfo>[]> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      return client
        ? this.roomsOf(client)
        : concat(of([{ op: 'reset', values: [] }] as const), NEVER);
    });
  }

  typing(
    accountId: string,
  ): Observable<Readonly<Record<string, readonly TypingMember[]>>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      return client ? roomTyping(client) : concat(of({}), NEVER);
    });
  }

  directMap(
    accountId: string,
  ): Observable<Readonly<Record<string, readonly string[]>>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of({}), NEVER);
      return new Observable<void>((subscriber) => {
        const onAccountData = (event: MatrixEvent): void => {
          if (event.getType() === EventType.Direct) subscriber.next();
        };
        client.on(ClientEvent.AccountData, onAccountData);
        return () => client.off(ClientEvent.AccountData, onAccountData);
      }).pipe(
        startWith(undefined),
        map(() => directContent(client)),
        distinctUntilChanged<Readonly<Record<string, readonly string[]>>>(
          plainEqual,
        ),
      );
    });
  }

  setTag(
    accountId: string,
    roomId: string,
    tag: 'favourite' | 'lowPriority',
    on: boolean,
  ): Observable<EngineResult<null>> {
    const name = tag === 'favourite' ? 'm.favourite' : 'm.lowpriority';
    return this.command(accountId, async (client) => {
      await (on
        ? client.setRoomTag(roomId, name, {})
        : client.deleteRoomTag(roomId, name));
      this.written$.next(client);
      return null;
    });
  }

  setMarkedUnread(
    accountId: string,
    roomId: string,
    unread: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      await client.setRoomAccountData(roomId, EventType.MarkedUnread, {
        unread,
      });
      return null;
    });
  }

  markRead(
    accountId: string,
    roomId: string,
    receipts: 'public' | 'private',
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      const room = client.getRoom(roomId);
      // Cleared even for an empty room: a room flagged unread and then marked read stops
      // being flagged either way.
      if (room && isMarkedUnread(room)) {
        await client.setRoomAccountData(roomId, EventType.MarkedUnread, {
          unread: false,
        });
      }
      const latest = latestConfirmed(room);
      const latestId = latest?.getId();
      if (latest && latestId) {
        await Promise.all([
          client.setRoomReadMarkers(roomId, latestId),
          client.sendReadReceipt(
            latest,
            receipts === 'public' ? ReceiptType.Read : ReceiptType.ReadPrivate,
          ),
        ]);
      }
      return null;
    });
  }

  leave(accountId: string, roomId: string): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      await client.leave(roomId);
      await settled(
        client,
        roomId,
        (room) => !room || !LISTED.has(room.getMyMembership()),
      );
      return null;
    });
  }

  createRoom(
    accountId: string,
    request: CreateRoomRequest,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.command(accountId, (client) =>
      createEncryptedRoom(client, {
        name: request.name,
        isPublic: request.isPublic,
        ...(request.topic === null ? {} : { topic: request.topic }),
      }).pipe(switchMap((roomId) => this.joinedRoom(client, roomId))),
    );
  }

  createDirectMessage(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.command(accountId, (client) =>
      openDirectRoom(client, userId).pipe(
        switchMap((roomId) => this.joinedRoom(client, roomId)),
      ),
    );
  }

  resolveAlias(
    accountId: string,
    alias: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.command(accountId, async (client) => ({
      roomId: (await client.getRoomIdForAlias(alias)).room_id,
    }));
  }

  invite(
    accountId: string,
    roomId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.command(
      accountId,
      async (client) => {
        await client.invite(roomId, userId);
        return null;
      },
      inviteFailed,
    );
  }

  /** A cold command: `account-not-live` without a client, else `run` with its failure mapped. */
  private command<T>(
    accountId: string,
    run: (client: MatrixClient) => Promise<T> | Observable<T>,
    failed: (error: unknown) => EngineFailure = requestFailed,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(ACCOUNT_NOT_LIVE));
      return from(run(client)).pipe(
        map((value): EngineResult<T> => engineOk(value)),
        catchError((error: unknown) => of(engineFail(failed(error)))),
      );
    });
  }

  /** A created room's id, once `/sync` shows it joined. */
  private async joinedRoom(
    client: MatrixClient,
    roomId: string,
  ): Promise<{ readonly roomId: string }> {
    await settled(client, roomId, joined);
    return { roomId };
  }

  /** A reset of every listed room on subscribe, and again once per microtask the list may have changed. */
  private roomsOf(
    client: MatrixClient,
  ): Observable<readonly VectorDiff<RoomInfo>[]> {
    return new Observable((subscriber) => {
      const encryption = new RoomEncryptionFlags();
      // The live timeline each row was built from, or null when it was empty: see onPagedIn.
      let builtFrom = new Map<string, EventTimeline | null>();
      // The other party in each DM. A DM's picture is that member's avatar.
      let dmPeers: ReadonlySet<string> = new Set();

      const emit = (): void => {
        const { userByRoom } = directMapOf(client);
        const crypto = client.getCrypto?.();
        const rooms = client
          .getRooms()
          .filter((room) => LISTED.has(room.getMyMembership()));
        const values = rooms.map((room) =>
          toRoomInfo(
            client,
            room,
            encryption,
            userByRoom.get(room.roomId) ?? null,
          ),
        );
        for (const room of rooms) {
          if (
            room.getMyMembership() !== 'join' ||
            room.hasEncryptionStateEvent() ||
            encryption.answered(room.roomId)
          ) {
            continue;
          }
          // Any answer can change the row: the lock, or a preview held back until now.
          void encryption.refresh(crypto, room.roomId).then(() => {
            if (encryption.answered(room.roomId) && !subscriber.closed) {
              flusher.schedule();
            }
          });
        }
        builtFrom = new Map(
          rooms.map((room) => {
            const timeline = room.getLiveTimeline();
            return [room.roomId, timeline.getEvents().length ? timeline : null];
          }),
        );
        dmPeers = new Set(userByRoom.values());
        subscriber.next([{ op: 'reset', values }]);
      };
      const flusher = coalesce(emit);
      const schedule = (): void => flusher.schedule();

      // The list does not rebuild on every timeline event, so a row is re-read when history
      // pages into a room whose timeline was empty or has been replaced since (a rewind after
      // an unblock), or its preview and order would stay as they were until the next sync.
      const onPagedIn = (
        _event: MatrixEvent | undefined,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
      ): void => {
        if (
          toStartOfTimeline &&
          room &&
          builtFrom.has(room.roomId) &&
          builtFrom.get(room.roomId) !== room.getLiveTimeline()
        ) {
          flusher.schedule();
        }
      };
      // Gated on the DM map so a member event in a large room does not rebuild the whole list.
      const onMember = (
        _event: MatrixEvent,
        _state: RoomState,
        member: RoomMember,
      ): void => {
        if (dmPeers.has(member.userId)) flusher.schedule();
      };

      const events = [
        ClientEvent.Sync,
        ClientEvent.Room,
        RoomEvent.Name,
        RoomEvent.MyMembership,
        // An encrypted room's notification count is only recomputed once the message decrypts,
        // after the Sync that carried the ciphertext.
        MatrixEventEvent.Decrypted,
        RoomEvent.Receipt,
        RoomEvent.Tags,
        // Room account data carries the marked-unread flag.
        RoomEvent.AccountData,
      ] as const;
      for (const event of events) client.on(event, schedule);
      client.on(RoomEvent.Timeline, onPagedIn);
      client.on(RoomStateEvent.Members, onMember);
      const written = this.written$
        .pipe(filter((target) => target === client))
        .subscribe(emit);

      emit();

      return () => {
        flusher.cancel();
        written.unsubscribe();
        for (const event of events) client.off(event, schedule);
        client.off(RoomEvent.Timeline, onPagedIn);
        client.off(RoomStateEvent.Members, onMember);
      };
    });
  }
}
