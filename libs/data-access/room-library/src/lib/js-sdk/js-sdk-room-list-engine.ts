import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  EventType,
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
  tap,
} from 'rxjs';
import {
  JS_SDK_CLIENTS,
  coalesce,
  RoomEncryptionFlags,
  liveRoomState,
} from '@trinity/data-access/matrix-client';
import {
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
  HierarchyEntry,
  InviteBlocking,
  RoomInfo,
  RoomListEngine,
  SpaceChildLink,
  TypingMember,
} from '../room-list-engine';
import { createRoomOrSpace, openDirectRoom } from './direct-rooms';
import {
  NO_INVITE_BLOCKING,
  inviteBlockingOf,
  writeInviteBlocking,
} from './invite-permission';
import {
  directMapOf,
  isInviteBlocked,
  isMarkedUnread,
  toRoomInfo,
} from './room-info';
import { roomsInCommonOf } from './mutual-rooms';
import { roomTyping } from './room-typing';
import {
  childContent,
  fetchHierarchy,
  readChildLinks,
  serverNameOf,
} from './space-links';

const LISTED = new Set(['join', 'invite', 'knock']);

/** How long a create or leave waits for `/sync` to show its effect before replying anyway. */
const SETTLE_TIMEOUT_MS = 15_000;

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

/**
 * Emits once and completes when `done(room)` holds, sync stops, or {@link SETTLE_TIMEOUT_MS}
 * passes. Unsubscribing removes its listeners and timer.
 */
function settled(
  client: MatrixClient,
  roomId: string,
  done: (room: Room | null) => boolean,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    const finish = (): void => {
      subscriber.next();
      subscriber.complete();
    };
    const check = (): void => {
      if (done(client.getRoom(roomId))) finish();
    };
    const onSync = (state: SyncState): void => {
      if (state === SyncState.Stopped) finish();
    };
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
    client.on(ClientEvent.Room, check);
    client.on(RoomEvent.MyMembership, check);
    client.on(RoomStateEvent.Events, check);
    client.on(ClientEvent.Sync, onSync);
    check();
    return () => {
      clearTimeout(timer);
      client.off(ClientEvent.Room, check);
      client.off(RoomEvent.MyMembership, check);
      client.off(RoomStateEvent.Events, check);
      client.off(ClientEvent.Sync, onSync);
    };
  });
}

const joined = (room: Room | null): boolean =>
  room?.getMyMembership() === 'join';

const listed = (room: Room | null): boolean =>
  !!room && LISTED.has(room.getMyMembership());

/** Whether the room's live state holds the state event `eventId`. */
const holds =
  (type: string, stateKey: string, eventId: string) =>
  (room: Room | null): boolean =>
    !!room &&
    liveRoomState(room)?.getStateEvents(type, stateKey)?.getId() === eventId;

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
  /** A client whose invite blocking must be re-read now, ahead of the `/sync` echo. */
  private readonly blockingWritten$ = new Subject<MatrixClient>();

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
    return this.command(accountId, (client) =>
      from(client.leave(roomId)).pipe(
        switchMap(() => this.settle(client, roomId, (room) => !listed(room))),
        map(() => null),
      ),
    );
  }

  createRoom(
    accountId: string,
    request: CreateRoomRequest,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.command(accountId, (client) =>
      createRoomOrSpace(client, request).pipe(
        switchMap((roomId) => {
          const { parentSpaceId } = request;
          if (!parentSpaceId) return of(roomId);
          // Our homeserver in `via` so a remote server can route to the new room.
          const via = [serverNameOf(client.getUserId())];
          return this.writeChild(client, parentSpaceId, roomId, {
            via,
            suggested: true,
            order: '',
          }).pipe(
            switchMap(() =>
              client.sendStateEvent(
                roomId,
                EventType.SpaceParent,
                { via, canonical: true },
                parentSpaceId,
              ),
            ),
            map(() => roomId),
          );
        }),
        switchMap((roomId) => this.once(client, roomId, joined)),
      ),
    );
  }

  createDirectMessage(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    // Listed, not joined: a reused DM may still be an invite, and is already in the list.
    return this.command(accountId, (client) =>
      openDirectRoom(client, userId).pipe(
        switchMap((roomId) => this.once(client, roomId, listed)),
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

  join(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.command(accountId, (client) =>
      from(
        client.joinRoom(
          roomIdOrAlias,
          via.length > 0 ? { viaServers: [...via] } : undefined,
        ),
      ).pipe(switchMap((room) => this.once(client, room.roomId, joined))),
    );
  }

  spaceChildLinks(
    accountId: string,
    spaceId: string,
  ): Observable<readonly SpaceChildLink[]> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      return client ? this.linksOf(client, spaceId) : concat(of([]), NEVER);
    });
  }

  spaceHierarchy(
    accountId: string,
    spaceId: string,
    { maxPages }: { readonly maxPages: number | null },
  ): Observable<EngineResult<readonly HierarchyEntry[]>> {
    return this.command(accountId, (client) =>
      fetchHierarchy(client, spaceId, maxPages),
    );
  }

  setSpaceChild(
    accountId: string,
    spaceId: string,
    childId: string,
    link: Omit<SpaceChildLink, 'childId'> | null,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) =>
      this.writeChild(client, spaceId, childId, link).pipe(map(() => null)),
    );
  }

  setSpaceParent(
    accountId: string,
    childId: string,
    spaceId: string,
    via: readonly string[],
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      await client.sendStateEvent(
        childId,
        EventType.SpaceParent,
        { via: [...via], canonical: true },
        spaceId,
      );
      return null;
    });
  }

  inviteBlocking(accountId: string): Observable<InviteBlocking> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      return client
        ? inviteBlockingOf(
            client,
            this.blockingWritten$.pipe(filter((target) => target === client)),
          )
        : concat(of(NO_INVITE_BLOCKING), NEVER);
    });
  }

  setInviteBlocking(
    accountId: string,
    blocked: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) =>
      writeInviteBlocking(client, blocked).pipe(
        tap(() => this.blockingWritten$.next(client)),
        map(() => null),
      ),
    );
  }

  roomsInCommon(
    accountId: string,
    userId: string,
  ): Observable<readonly string[]> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      return client ? roomsInCommonOf(client, userId) : concat(of([]), NEVER);
    });
  }

  /** Sends the `m.space.child` event and waits for `/sync` to apply it, as {@link settle} does. */
  private writeChild(
    client: MatrixClient,
    spaceId: string,
    childId: string,
    link: Omit<SpaceChildLink, 'childId'> | null,
  ): Observable<void> {
    return from(
      client.sendStateEvent(
        spaceId,
        EventType.SpaceChild,
        childContent(link),
        childId,
      ),
    ).pipe(
      switchMap(({ event_id }) =>
        this.settle(
          client,
          spaceId,
          holds(EventType.SpaceChild, childId, event_id),
        ),
      ),
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

  /** {@link settled}, re-emitting open `rooms()` subscriptions before the reply. */
  private settle(
    client: MatrixClient,
    roomId: string,
    done: (room: Room | null) => boolean,
  ): Observable<void> {
    return settled(client, roomId, done).pipe(
      tap(() => this.written$.next(client)),
    );
  }

  /** `roomId` once {@link settle}d. */
  private once(
    client: MatrixClient,
    roomId: string,
    done: (room: Room | null) => boolean,
  ): Observable<{ readonly roomId: string }> {
    return this.settle(client, roomId, done).pipe(map(() => ({ roomId })));
  }

  /** The space's links on subscribe, and again once per microtask they may have changed. */
  private linksOf(
    client: MatrixClient,
    spaceId: string,
  ): Observable<readonly SpaceChildLink[]> {
    return new Observable<readonly SpaceChildLink[]>((subscriber) => {
      const emit = (): void =>
        subscriber.next(readChildLinks(client.getRoom(spaceId)));
      const flusher = coalesce(emit);
      const onState = (event: MatrixEvent): void => {
        if (
          event.getRoomId() === spaceId &&
          event.getType() === EventType.SpaceChild
        ) {
          flusher.schedule();
        }
      };
      // The space itself may arrive after the subscription, with its state already set.
      const onRoom = (room: Room): void => {
        if (room.roomId === spaceId) flusher.schedule();
      };
      client.on(RoomStateEvent.Events, onState);
      client.on(ClientEvent.Room, onRoom);
      const written = this.written$
        .pipe(filter((target) => target === client))
        .subscribe(emit);

      emit();

      return () => {
        flusher.cancel();
        written.unsubscribe();
        client.off(RoomStateEvent.Events, onState);
        client.off(ClientEvent.Room, onRoom);
      };
    }).pipe(distinctUntilChanged<readonly SpaceChildLink[]>(plainEqual));
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
