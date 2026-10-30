import { ErrorHandler, Injectable, Injector, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ClientEvent,
  Direction,
  EventStatus,
  EventType,
  M_POLL_END,
  M_POLL_RESPONSE,
  M_POLL_START,
  MatrixEvent,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
  ThreadEvent,
  type EventTimeline,
  type MatrixClient,
  type Room,
  type RoomMember,
  type RoomState,
  type Thread,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  takeWhile,
  type Subscriber,
} from 'rxjs';
import {
  JS_SDK_CLIENTS,
  SESSION_ENGINE,
  coalesce,
  RoomEncryptionFlags,
  isRoomEncrypted,
  liveRoomState,
} from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import {
  TYPING_TIMEOUT_MS,
  annotationContent,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  locationMessageContent,
  plainEqual,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
  voiceMessageContent,
  type EngineFailure,
  unwrapEngineResult,
  type EngineResult,
  type VectorDiff,
} from '@trinity/util/matrix';
import type { MessageShield } from '../message-presentation';
import { shieldKey, shieldText } from '../shield-presentation';
import type {
  EventTimelineItem,
  OutgoingMessage,
  OutgoingText,
  Profile,
  ReactionDetailGroup,
  RetentionHint,
  ShieldCode,
  ThreadSummaryInfo,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  TimelineItemKey,
  TimelineRoomState,
  TimelineUpdate,
  VoiceClip,
} from '../timeline-engine';
import {
  collectMessageSenders,
  isDisplayableMessage,
  reactionSendersFor,
} from './event-reads';
import { revisionOf } from './event-revision';
import { JsSdkTimelineRetention } from './js-sdk-timeline-retention';
import { scrollbackLive } from './live-scrollback';
import { isPresentableSystemEvent } from './normalize-timeline-event';
import {
  editContent,
  fetchRoomEvent,
  forwardedContent,
  myReactionIds,
  replyMessageContent,
  textContent,
  voiceExtension,
} from './outgoing-content';
import {
  resolveShieldsInto,
  resolvedShields,
  shieldsToCheck,
  shownContent,
  shownShieldCode,
  shownSubject,
  unencryptedShieldFor,
} from './shields';
import { threadSummaryInfo, threadSummaryRevision } from './thread-summary';
import { profileOf, toTimelineItem, transactionIdOf } from './timeline-item';
import { TimelineRowCache } from './timeline-row-cache';

/** Events per page while paging back to a target event. */
const SCROLLBACK = 30;
/** The most pages a rewound room is refilled with. */
const MAX_REFILL_PAGES = 20;

const UNAVAILABLE: TimelineUpdate = { kind: 'room-unavailable' };
const READ_MARKER: TimelineItem = {
  kind: 'readMarker',
  uniqueId: 'read-marker',
};
const TIMELINE_START: TimelineItem = {
  kind: 'timelineStart',
  uniqueId: 'timeline-start',
};

function localFailure(
  code:
    | 'account-not-live'
    | 'message-unavailable'
    | 'unsupported'
    | 'not-cancellable'
    | 'not-forwardable'
    | 'encryption-unavailable',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function failureFrom(
  code: 'request-failed' | 'message-unavailable' | 'unsupported',
  error: unknown,
): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  if (code !== 'request-failed') return { kind, code, diagnostic };
  return {
    kind,
    code,
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

function errcodeOf(error: unknown): string | undefined {
  return (error as { errcode?: string } | null)?.errcode;
}

function notFound(error: unknown): boolean {
  return (
    errcodeOf(error) === 'M_NOT_FOUND' ||
    (error as { httpStatus?: number } | null)?.httpStatus === 404
  );
}

/** A JSON copy: drops `undefined` keys, so the event crosses the engine boundary. */
function plainEvent(event: MatrixEvent): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(event.getEffectiveEvent())) as Readonly<
    Record<string, unknown>
  >;
}

/** A threaded reply that lives only in its thread (not the root, not an `m.in_reply_to`). */
function isThreadReply(event: MatrixEvent): boolean {
  return event.threadRootId !== undefined && !event.isThreadRoot;
}

/** The pagination a page runs under: the room's live timeline, or one of its threads. */
function pageKey(roomId: string, focus: TimelineFocus): string {
  return focus.kind === 'live' ? roomId : `${roomId}\x1f${focus.rootEventId}`;
}

function atStart(room: Room): boolean {
  return room.getLiveTimeline().getPaginationToken(Direction.Backward) === null;
}

function tombstoneOf(room: Room): TimelineRoomState['tombstone'] {
  const content = liveRoomState(room)
    ?.getStateEvents?.(EventType.RoomTombstone, '')
    ?.getContent();
  const replacement = content?.['replacement_room'];
  return typeof replacement === 'string'
    ? {
        replacementRoomId: replacement,
        body: typeof content?.['body'] === 'string' ? content['body'] : '',
      }
    : null;
}

/** The newest event the server has confirmed, hidden ones included. */
function latestConfirmedId(events: readonly MatrixEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!events[i].status) return events[i].getId() ?? null;
  }
  return null;
}

/** The room's `m.fully_read` event id, or null. */
function fullyReadOf(room: Room): string | null {
  const eventId = room.getAccountData(EventType.FullyRead)?.getContent()?.[
    'event_id'
  ];
  return typeof eventId === 'string' ? eventId : null;
}

/** Statuses of a local echo the SDK can still resend or cancel. */
const UNSENT: ReadonlySet<EventStatus | null> = new Set([
  EventStatus.NOT_SENT,
  EventStatus.QUEUED,
  EventStatus.ENCRYPTING,
]);

/** The local echo of `transactionId`, pending or, once sent, in the live timeline. */
function echoOf(room: Room, transactionId: string): MatrixEvent | undefined {
  return (
    room.getEventForTxnId(transactionId) ??
    room
      .getLiveTimeline()
      .getEvents()
      .find((event) => transactionIdOf(event) === transactionId)
  );
}

/** The id `item` is known by in the room: its event id, else its local echo's. */
function idOf(room: Room, item: TimelineItemKey): string | null {
  if (item.eventId !== null) return item.eventId;
  return item.transactionId === null
    ? null
    : (room.getEventForTxnId(item.transactionId)?.getId() ?? null);
}

/** A loaded event, a thread's included. */
function findEvent(
  room: Room,
  eventId: string,
  threadRootId: string | null,
): MatrixEvent | undefined {
  return (
    room.findEventById(eventId) ??
    room
      .getThread(threadRootId ?? '')
      ?.events.find((e) => e.getId() === eventId) ??
    room
      .getLiveTimeline()
      .getEvents()
      .find((e) => e.getId() === eventId)
  );
}

/** The event type and content Trinity sends for `message`. */
function outgoing(
  room: Room,
  message: OutgoingMessage,
  replyTo: string | null,
  target: MatrixEvent | undefined,
): { readonly type: string; readonly content: Record<string, unknown> } {
  switch (message.kind) {
    case 'text':
      return {
        type: EventType.RoomMessage,
        content: replyTo
          ? replyMessageContent(room, replyTo, message, target, shownContent)
          : textContent(message),
      };
    case 'location':
      return {
        type: EventType.RoomMessage,
        content: locationMessageContent(
          message.lat,
          message.lng,
          message.label ?? undefined,
        ),
      };
    case 'sticker':
      return {
        type: EventType.Sticker,
        content: { body: message.body, url: message.url, info: message.info },
      };
    case 'poll-start':
      return {
        type: M_POLL_START.name,
        content: pollStartContent(
          message.question,
          message.answers,
          message.maxSelections,
        ),
      };
    case 'poll-response':
      return {
        type: M_POLL_RESPONSE.name,
        content: pollResponseContent(message.pollId, message.answerIds),
      };
    case 'poll-end':
      return {
        type: M_POLL_END.name,
        content: pollEndContent(message.pollId),
      };
  }
}

/** An open `timeline()` subscription, which commands bring up to date before replying. */
interface Feed {
  readonly client: MatrixClient;
  readonly roomId: string;
  /** See {@link pageKey}. */
  readonly pageKey: string;
  /** Emits the current items now, dropping a queued emission. */
  flush(): void;
  /**
   * {@link flush}; while a landed page waits for its flush, resolves after that flush instead,
   * so the page still arrives with the pagination state it ends in.
   */
  settle(): Promise<void>;
  /** Emits the pagination state with no diffs. */
  announce(): void;
}

/**
 * {@link TimelineEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. Every
 * emission is a `reset`; an unchanged event keeps its item object from one reset to the next.
 */
@Injectable({ providedIn: 'root' })
export class JsSdkTimelineEngine implements TimelineEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  // Resolved on use: the media service needs the session's MatrixClientService.
  private readonly injector = inject(Injector);
  private readonly feeds = new Set<Feed>();
  private readonly retention = new JsSdkTimelineRetention({
    clientFor: (accountId) => this.clients.clientFor(accountId),
    errors: inject(ErrorHandler),
    subscribed: (client, roomId) =>
      [...this.feeds].some((f) => f.client === client && f.roomId === roomId),
    refill: (accountId, roomId, target, held) =>
      this.refill(accountId, roomId, target, held),
  });
  /** The {@link pageKey}s with a page in flight, per client. */
  private readonly paging = new WeakMap<MatrixClient, Set<string>>();
  /** The last page queued per {@link pageKey}, per client: each pages one page at a time. */
  private readonly queues = new WeakMap<
    MatrixClient,
    Map<string, Promise<unknown>>
  >();
  /** Threads whose last page brought nothing: hidden replies the count still includes. */
  private readonly exhausted = new WeakSet<Thread>();
  /**
   * Own thread sends not yet in their thread. The SDK keeps a threaded local echo out of every
   * timeline until its remote echo syncs into the thread.
   *
   * shortcut: pruned on each thread projection, send and cancel of the room, so a send that
   * syncs while no thread is open stays until the next; freed with its Room. Upgrade to a
   * per-echo status listener if that ever holds more than a handful.
   */
  private readonly threadEchoes = new WeakMap<
    Room,
    readonly { readonly rootId: string; readonly echo: MatrixEvent }[]
  >();

  /** The room's tracked thread sends that are neither cancelled nor in their thread yet. */
  private pruneThreadEchoes(
    room: Room,
  ): readonly { readonly rootId: string; readonly echo: MatrixEvent }[] {
    const pending = (this.threadEchoes.get(room) ?? []).filter(
      ({ rootId, echo }) => {
        if (echo.status === EventStatus.CANCELLED) return false;
        const events = room.getThread(rootId)?.events ?? [];
        return !events.some((e) => e === echo || e.getId() === echo.getId());
      },
    );
    if (pending.length) this.threadEchoes.set(room, pending);
    else this.threadEchoes.delete(room);
    return pending;
  }

  /** The thread's root, its displayable replies, then its own sends still on their way. */
  private threadEvents(
    room: Room,
    rootId: string,
    thread: Thread | null,
  ): MatrixEvent[] {
    const replies = (thread?.events ?? []).filter(isDisplayableMessage);
    const ids = new Set(replies.map((e) => e.getId()));
    const root = thread?.rootEvent ?? room.findEventById(rootId);
    const pending = this.pruneThreadEchoes(room);
    return [
      ...(root && !ids.has(root.getId()) ? [root] : []),
      ...replies,
      ...pending.filter((p) => p.rootId === rootId).map((p) => p.echo),
    ];
  }

  constructor() {
    inject(SESSION_ENGINE)
      .session()
      .pipe(
        takeUntilDestroyed(),
        finalize(() => this.retention.follow([])),
      )
      .subscribe((session) => this.retention.follow(session.accounts));
  }

  timeline(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
  ): Observable<TimelineUpdate> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(UNAVAILABLE), NEVER);
      return this.onceRoom<TimelineUpdate>(
        client,
        roomId,
        (subscriber) => subscriber.next(UNAVAILABLE),
        (room, subscriber) => this.attach(client, room, focus, subscriber),
      );
    });
  }

  threadSummaries(
    accountId: string,
    roomId: string,
  ): Observable<readonly VectorDiff<ThreadSummaryInfo>[]> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      const none: readonly VectorDiff<ThreadSummaryInfo>[] = [
        { op: 'reset', values: [] },
      ];
      if (!client) return concat(of(none), NEVER);
      return this.onceRoom<readonly VectorDiff<ThreadSummaryInfo>[]>(
        client,
        roomId,
        (subscriber) => subscriber.next(none),
        (room, subscriber) => this.attachSummaries(client, room, subscriber),
      );
    });
  }

  /** Runs `attach` on the room once the client holds it, and `missing` until then. */
  private onceRoom<T>(
    client: MatrixClient,
    roomId: string,
    missing: (subscriber: Subscriber<T>) => void,
    attach: (room: Room, subscriber: Subscriber<T>) => () => void,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      let detach: (() => void) | null = null;
      const onRoom = (room: Room): void => {
        if (room.roomId !== roomId || detach) return;
        client.off(ClientEvent.Room, onRoom);
        detach = attach(room, subscriber);
      };
      const room = client.getRoom(roomId);
      if (room) {
        detach = attach(room, subscriber);
      } else {
        missing(subscriber);
        client.on(ClientEvent.Room, onRoom);
      }
      return () => {
        client.off(ClientEvent.Room, onRoom);
        detach?.();
      };
    });
  }

  paginateBackwards(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
    count: number,
  ): Observable<EngineResult<{ readonly startReached: boolean }>> {
    return this.command(accountId, (client) => {
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      let stopped = false;
      if (focus.kind === 'thread') {
        const thread = room.getThread(focus.rootEventId);
        if (!thread || !this.canPageThread(thread)) {
          return of(engineOk({ startReached: true }));
        }
        return from(
          this.paged(
            client,
            pageKey(roomId, focus),
            async () => {
              const before = thread.events.length;
              await client.paginateEventTimeline(thread.liveTimeline, {
                backwards: true,
                limit: count,
              });
              if (thread.events.length === before) this.exhausted.add(thread);
            },
            () => stopped,
          ),
        ).pipe(
          map(() => engineOk({ startReached: !this.canPageThread(thread) })),
          finalize(() => (stopped = true)),
        );
      }
      return from(
        // Skipped, never shown as paging, when unsubscribed while queued behind another page.
        this.paged(
          client,
          roomId,
          () => scrollbackLive(client, room, count),
          () => stopped,
        ),
      ).pipe(
        map(() => engineOk({ startReached: atStart(room) })),
        finalize(() => (stopped = true)),
      );
    });
  }

  paginateUntil(
    accountId: string,
    roomId: string,
    eventId: string,
    maxPages: number,
  ): Observable<EngineResult<{ readonly found: boolean }>> {
    return this.command(accountId, (client) => {
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      const loaded = (): boolean => room.findEventById(eventId) !== undefined;
      if (loaded() || atStart(room)) return of(engineOk({ found: loaded() }));
      let stopped = false;
      return from(
        this.paged(
          client,
          roomId,
          async () => {
            for (let page = 0; page < maxPages && !stopped; page++) {
              if (atStart(room)) break;
              // Show the previous page before the next request, so live changes keep flowing.
              if (page > 0) this.flushFeeds(client, roomId);
              const live = room.getLiveTimeline();
              const before = live.getEvents().length;
              await scrollbackLive(client, room, SCROLLBACK);
              if (loaded()) return true;
              // A page that brought nothing to the same timeline: the start of the room. A
              // reset dropped the page instead, so paging goes on from the new timeline.
              if (
                room.getLiveTimeline() === live &&
                live.getEvents().length === before
              ) {
                break;
              }
            }
            return false;
          },
          () => stopped,
        ),
      ).pipe(
        map((found) => engineOk({ found: found === true })),
        finalize(() => (stopped = true)),
      );
    });
  }

  eventAt(
    accountId: string,
    roomId: string,
    timestamp: number,
  ): Observable<EngineResult<{ readonly eventId: string } | null>> {
    return this.command(accountId, async (client) => {
      try {
        // Forward: the first event at or after the timestamp.
        const { event_id } = await client.timestampToEvent(
          roomId,
          timestamp,
          Direction.Forward,
        );
        return engineOk({ eventId: event_id });
      } catch (error) {
        // A server that never heard of MSC3030 answers M_UNRECOGNIZED; M_NOT_FOUND is the
        // endpoint saying the room has no such event.
        if (errcodeOf(error) === 'M_UNRECOGNIZED') {
          return engineFail(failureFrom('unsupported', error));
        }
        if (errcodeOf(error) === 'M_NOT_FOUND') return engineOk(null);
        throw error;
      }
    });
  }

  eventSource(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<Readonly<Record<string, unknown>> | null>> {
    return this.command(accountId, async (client) => {
      const room = client.getRoom(roomId);
      if (!room) return engineFail(localFailure('message-unavailable'));
      const loaded = room.findEventById(eventId);
      if (loaded) return engineOk(plainEvent(loaded));
      try {
        const event = client.getEventMapper()(
          await client.fetchRoomEvent(roomId, eventId),
        );
        await client.decryptEventIfNeeded(event);
        return engineOk(plainEvent(event));
      } catch (error) {
        if (notFound(error)) {
          return engineFail(failureFrom('message-unavailable', error));
        }
        throw error;
      }
    });
  }

  reactionDetails(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<readonly ReactionDetailGroup[]>> {
    return this.command(accountId, async (client) => {
      const room = client.getRoom(roomId);
      const event = room?.findEventById(eventId);
      if (!room || !event) {
        return engineFail(localFailure('message-unavailable'));
      }
      return engineOk(
        reactionSendersFor(room, event).map(([key, senders]) => {
          const profiles: Record<string, Profile> = {};
          for (const userId of senders) {
            const profile = profileOf(userId, room.getMember(userId));
            if (profile) profiles[userId] = profile;
          }
          return { key, senders, profiles };
        }),
      );
    });
  }

  sendReceipt(
    accountId: string,
    roomId: string,
    eventId: string,
    options: {
      readonly threadRootId: string | null;
      readonly visibility: 'public' | 'private';
      readonly fullyRead: boolean;
    },
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      const room = client.getRoom(roomId);
      const event =
        room &&
        (room.findEventById(eventId) ??
          room
            .getThread(options.threadRootId ?? '')
            ?.events.find((e) => e.getId() === eventId) ??
          room
            .getLiveTimeline()
            .getEvents()
            .find((e) => e.getId() === eventId));
      // The server refuses a receipt on an event it has not confirmed.
      if (!room || !event || event.status) {
        return engineFail(localFailure('message-unavailable'));
      }
      await Promise.all([
        client.sendReadReceipt(
          event,
          options.visibility === 'public'
            ? ReceiptType.Read
            : ReceiptType.ReadPrivate,
        ),
        // A thread has no read marker of its own.
        ...(options.fullyRead && !options.threadRootId
          ? [client.setRoomReadMarkers(roomId, eventId)]
          : []),
      ]);
      return engineOk(null);
    });
  }

  setTyping(
    accountId: string,
    roomId: string,
    typing: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      await client.sendTyping(roomId, typing, typing ? TYPING_TIMEOUT_MS : 0);
      return engineOk(null);
    });
  }

  send(
    accountId: string,
    roomId: string,
    message: OutgoingMessage,
    options: {
      readonly threadRootId: string | null;
      readonly replyTo: string | null;
      readonly transactionId?: string;
    },
  ): Observable<
    EngineResult<{
      readonly transactionId: string;
      readonly eventId: string | null;
    }>
  > {
    return this.command<{
      readonly transactionId: string;
      readonly eventId: string | null;
    }>(accountId, (client) => {
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      const replyTo = message.kind === 'text' ? options.replyTo : null;
      // A reply can outlive its target in memory (a trimmed room, a restored draft): such a
      // target is fetched; when that fails the reply keeps its relation but no quote.
      const target = defer(() => {
        const loaded = replyTo ? room.findEventById(replyTo) : undefined;
        return loaded || !replyTo
          ? of(loaded)
          : from(fetchRoomEvent(client, roomId, replyTo));
      });
      return this.ensureThread(client, room, options.threadRootId).pipe(
        switchMap(() => target),
        switchMap((event) => {
          const { type, content } = outgoing(room, message, replyTo, event);
          const transactionId = options.transactionId ?? client.makeTxnId();
          const request =
            type === EventType.RoomMessage
              ? client.sendMessage(
                  roomId,
                  options.threadRootId,
                  content as never,
                  transactionId,
                )
              : client.sendEvent(
                  roomId,
                  options.threadRootId,
                  type as never,
                  content as never,
                  transactionId,
                );
          const rootId = options.threadRootId;
          const echo = rootId && room.getEventForTxnId(transactionId);
          if (rootId && echo) {
            const echoes = this.pruneThreadEchoes(room);
            this.threadEchoes.set(room, [...echoes, { rootId, echo }]);
          }
          void this.settleFeeds(client, roomId);
          return this.settled(
            client,
            roomId,
            request
              .finally(() => this.pruneThreadEchoes(room))
              .then(
                ({ event_id }) =>
                  engineOk({ transactionId, eventId: event_id ?? null }),
                (error: unknown) => {
                  // The echo stays, unsent, with its send state.
                  if (room.getEventForTxnId(transactionId)) {
                    return engineOk({ transactionId, eventId: null });
                  }
                  throw error;
                },
              ),
          );
        }),
      );
    });
  }

  edit(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    message: OutgoingText,
    options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onRoom(accountId, roomId, (client, room) => {
      const eventId = idOf(room, item);
      if (eventId === null)
        return engineFail(localFailure('message-unavailable'));
      return client
        .sendMessage(
          roomId,
          options.threadRootId,
          editContent(eventId, message) as never,
          client.makeTxnId(),
        )
        .then(() => engineOk(null));
    });
  }

  redact(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onRoom(accountId, roomId, (client, room) => {
      const eventId = idOf(room, item);
      if (eventId === null)
        return engineFail(localFailure('message-unavailable'));
      return (
        options.threadRootId
          ? client.redactEvent(roomId, options.threadRootId, eventId)
          : client.redactEvent(roomId, eventId)
      ).then(() => engineOk(null));
    });
  }

  toggleReaction(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    key: string,
    options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onRoom(accountId, roomId, (client, room) => {
      const { threadRootId } = options;
      const eventId = idOf(room, item);
      if (eventId === null || !findEvent(room, eventId, threadRootId)) {
        return engineFail(localFailure('message-unavailable'));
      }
      const mine = myReactionIds(client, room, eventId, key);
      const action = mine.length
        ? Promise.all(
            mine.map((id) =>
              threadRootId
                ? client.redactEvent(roomId, threadRootId, id)
                : client.redactEvent(roomId, id),
            ),
          )
        : client.sendEvent(
            roomId,
            threadRootId,
            EventType.Reaction,
            annotationContent(eventId, key) as never,
            client.makeTxnId(),
          );
      return action.then(() => engineOk(null));
    });
  }

  retrySend(
    accountId: string,
    roomId: string,
    transactionId: string,
  ): Observable<EngineResult<null>> {
    return this.onRoom(accountId, roomId, (client, room) => {
      const echo = room.getEventForTxnId(transactionId);
      if (!echo || !UNSENT.has(echo.status)) {
        return engineFail(localFailure('message-unavailable'));
      }
      return client.resendEvent(echo, room).then(() => engineOk(null));
    });
  }

  cancelSend(
    accountId: string,
    roomId: string,
    transactionId: string,
  ): Observable<EngineResult<null>> {
    return this.onRoom(accountId, roomId, (client, room) => {
      const echo = echoOf(room, transactionId);
      if (!echo) return engineFail(localFailure('message-unavailable'));
      try {
        // CANCELLED stops the reconnect resend; the caller lets go of any text it held.
        client.cancelPendingEvent(echo);
        this.pruneThreadEchoes(room);
        return engineOk(null);
      } catch {
        // SENDING means the request may already have crossed the network boundary.
        return engineFail(localFailure('not-cancellable'));
      }
    });
  }

  forward(
    accountId: string,
    sourceRoomId: string,
    eventId: string,
    targetRoomId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) => {
      const event = client.getRoom(sourceRoomId)?.findEventById(eventId);
      if (!event) return of(engineFail(localFailure('message-unavailable')));
      // What the row shows (an encrypted edit only once its own shield is checked), cut to
      // the message's own fields.
      const forwarded = forwardedContent(
        event.getType(),
        shownContent(event),
        Boolean(event.replyEventId),
      );
      if (!forwarded) return of(engineFail(localFailure('not-forwardable')));
      const transactionId = client.makeTxnId();
      const request =
        event.getType() === EventType.Sticker
          ? client.sendEvent(
              targetRoomId,
              null,
              EventType.Sticker,
              forwarded as never,
              transactionId,
            )
          : client.sendMessage(
              targetRoomId,
              null,
              forwarded as never,
              transactionId,
            );
      return this.settled(
        client,
        targetRoomId,
        request.then(() => engineOk(null)),
      );
    });
  }

  sendVoice(
    accountId: string,
    roomId: string,
    clip: VoiceClip,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) => {
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      const crypto = client.getCrypto?.();
      const file = new File(
        [clip.blob],
        `voice-message.${voiceExtension(clip.mimeType)}`,
        { type: clip.mimeType },
      );
      return from(isRoomEncrypted(room, crypto)).pipe(
        switchMap((encrypt) => {
          // Without a crypto store the SDK would send the event, and the clip's key, in the clear.
          if (encrypt && !crypto) {
            return of(engineFail(localFailure('encryption-unavailable')));
          }
          return this.injector
            .get(MediaService)
            .uploadMedia(file, encrypt, undefined, undefined, accountId)
            .pipe(
              switchMap((media) =>
                this.settled(
                  client,
                  roomId,
                  client
                    .sendMessage(
                      roomId,
                      null,
                      voiceMessageContent(
                        {
                          mxc: media.mxc,
                          file: media.file,
                          mimeType: media.info.mimetype,
                          size: media.info.size,
                        },
                        clip.durationMs,
                        [...clip.waveform],
                      ) as never,
                      client.makeTxnId(),
                    )
                    .then(() => engineOk(null)),
                ),
              ),
            );
        }),
      );
    });
  }

  setRetention(
    accountId: string,
    roomId: string,
    hint: RetentionHint | null,
  ): Observable<null> {
    return defer(() => {
      const trimmed = this.retention.setHint(accountId, roomId, hint);
      return trimmed
        ? this.settled(trimmed, roomId, Promise.resolve(null))
        : of(null);
    });
  }

  /** Pages the live timeline back until it shows about `target` items, while `held`. */
  private refill(
    accountId: string,
    roomId: string,
    target: number,
    held: () => boolean,
  ): Observable<unknown> {
    const loaded = (): number =>
      this.clients
        .clientFor(accountId)
        ?.getRoom(roomId)
        ?.getLiveTimeline()
        .getEvents()
        .filter(
          (e) =>
            !isThreadReply(e) &&
            (isDisplayableMessage(e) || isPresentableSystemEvent(e)),
        ).length ?? 0;
    const page = (count: number): Observable<unknown> =>
      this.paginateBackwards(
        accountId,
        roomId,
        { kind: 'live' },
        SCROLLBACK,
      ).pipe(
        unwrapEngineResult(),
        takeWhile(
          ({ startReached }) =>
            !startReached &&
            loaded() < target &&
            count < MAX_REFILL_PAGES &&
            held(),
        ),
        switchMap(() => page(count + 1)),
      );
    return defer(() => (held() ? page(1) : of(null)));
  }

  /**
   * Creates the thread of `rootId` when it has none. matrix-js-sdk forms no thread from the
   * sender's own first reply: its echo would leave the room's timeline and land nowhere. Done
   * only on send, so a thread opened and abandoned leaves no empty thread behind.
   */
  private ensureThread(
    client: MatrixClient,
    room: Room,
    rootId: string | null,
  ): Observable<unknown> {
    return defer(() => {
      if (!rootId || room.getThread(rootId)) return of(null);
      const local = room.findEventById(rootId);
      if (local) return of(room.createThread(rootId, local, [], false));
      // A root out of memory (an old thread) is fetched; when that fails, nothing is sent.
      return from(client.fetchRoomEvent(room.roomId, rootId)).pipe(
        map((raw) =>
          room.createThread(rootId, new MatrixEvent(raw), [], false),
        ),
      );
    });
  }

  /** Whether `thread` has older replies left: the server's count settles a stale token. */
  private canPageThread(thread: Thread): boolean {
    // A redacted reply lowers the server count, so it does not count as loaded either.
    const loaded = thread.events.filter(
      (e) =>
        isDisplayableMessage(e) && e.getId() !== thread.id && !e.isRedacted(),
    ).length;
    return (
      !this.exhausted.has(thread) &&
      thread.liveTimeline.getPaginationToken(Direction.Backward) !== null &&
      loaded < thread.length
    );
  }

  /** A cold command: `account-not-live` without a client, a thrown error as `request-failed`. */
  private command<T>(
    accountId: string,
    run: (
      client: MatrixClient,
    ) => Promise<EngineResult<T>> | Observable<EngineResult<T>>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(localFailure('account-not-live')));
      return from(run(client)).pipe(
        catchError((error: unknown) =>
          of(engineFail(failureFrom('request-failed', error))),
        ),
      );
    });
  }

  /**
   * Runs `page` with the room marked paginating, after any page already queued for the room.
   * Open subscriptions see the start, and then the page together with the next pagination
   * state in one emission, before `page` resolves.
   */
  private paged<T>(
    client: MatrixClient,
    key: string,
    page: () => Promise<T>,
    skip: () => boolean = () => false,
  ): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      if (skip()) return undefined;
      this.setPaging(client, key, true);
      try {
        return await page();
      } finally {
        this.setPaging(client, key, false);
      }
    };
    const queues =
      this.queues.get(client) ?? new Map<string, Promise<unknown>>();
    this.queues.set(client, queues);
    const previous = queues.get(key);
    const result = previous ? previous.then(run, run) : run();
    const tail = result.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  }

  private setPaging(client: MatrixClient, key: string, on: boolean): void {
    const keys = this.paging.get(client) ?? new Set<string>();
    this.paging.set(client, keys);
    if (on) keys.add(key);
    else keys.delete(key);
    for (const feed of this.feeds) {
      if (feed.client !== client || feed.pageKey !== key) continue;
      if (on) feed.announce();
      else feed.flush();
    }
  }

  /**
   * A command on a room the account holds, `message-unavailable` when it does not. It replies
   * once its effect is in the room's open subscriptions.
   */
  private onRoom<T>(
    accountId: string,
    roomId: string,
    run: (
      client: MatrixClient,
      room: Room,
    ) => EngineResult<T> | Promise<EngineResult<T>>,
  ): Observable<EngineResult<T>> {
    return this.command(accountId, (client) => {
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      return this.settled(
        client,
        roomId,
        new Promise<EngineResult<T>>((resolve) => resolve(run(client, room))),
      );
    });
  }

  /** `result`, once the room's open subscriptions show what it did, failed or not. */
  private settled<T>(
    client: MatrixClient,
    roomId: string,
    result: Promise<T>,
  ): Observable<T> {
    return from(result.finally(() => this.settleFeeds(client, roomId)));
  }

  private settleFeeds(client: MatrixClient, roomId: string): Promise<void> {
    const settling: Promise<void>[] = [];
    for (const feed of this.feeds) {
      if (feed.client === client && feed.roomId === roomId) {
        settling.push(feed.settle());
      }
    }
    return Promise.all(settling).then(() => undefined);
  }

  private flushFeeds(client: MatrixClient, roomId: string): void {
    for (const feed of this.feeds) {
      if (feed.client === client && feed.roomId === roomId) feed.flush();
    }
  }

  private backPagination(
    client: MatrixClient,
    room: Room,
    focus: TimelineFocus,
  ): 'idle' | 'paginating' | 'start-reached' {
    if (this.paging.get(client)?.has(pageKey(room.roomId, focus))) {
      return 'paginating';
    }
    if (focus.kind === 'thread') {
      const thread = room.getThread(focus.rootEventId);
      return thread && this.canPageThread(thread) ? 'idle' : 'start-reached';
    }
    return atStart(room) ? 'start-reached' : 'idle';
  }

  /**
   * Projects the room's thread summaries into `subscriber` until the returned teardown runs.
   * A summary is rebuilt only when its fingerprint changes, and the list re-emitted only then.
   */
  private attachSummaries(
    client: MatrixClient,
    room: Room,
    subscriber: Subscriber<readonly VectorDiff<ThreadSummaryInfo>[]>,
  ): () => void {
    const roomId = room.roomId;
    const encryption = new RoomEncryptionFlags();
    const cache = new Map<
      string,
      { readonly rev: string; readonly summary: ThreadSummaryInfo }
    >();
    let emitted: readonly ThreadSummaryInfo[] | null = null;

    const refresh = (): void => {
      const encrypted = encryption.isEncrypted(room);
      const summaries = room.getThreads().map((thread) => {
        const rev = `${threadSummaryRevision(room, thread)}\x1f${encrypted}`;
        const cached = cache.get(thread.id);
        if (cached?.rev === rev) return cached.summary;
        const summary = threadSummaryInfo(room, thread, encrypted);
        cache.set(thread.id, { rev, summary });
        return summary;
      });
      const ids = new Set(summaries.map((s) => s.rootEventId));
      for (const id of [...cache.keys()]) if (!ids.has(id)) cache.delete(id);
      if (
        emitted?.length === summaries.length &&
        summaries.every((summary, i) => summary === emitted?.[i])
      ) {
        return;
      }
      emitted = summaries;
      subscriber.next([{ op: 'reset', values: summaries }]);
    };
    const onDecrypted = (event: MatrixEvent): void => {
      if (event.getRoomId() === roomId) refresh();
    };
    // The fingerprint names no participant: a member change rebuilds the summaries naming them.
    const onMember = (
      _event: MatrixEvent,
      _state: RoomState,
      member: RoomMember,
    ): void => {
      if (member.roomId !== roomId) return;
      let named = false;
      for (const [id, { summary }] of cache) {
        if (summary.participants.includes(member.userId)) {
          cache.delete(id);
          named = true;
        }
      }
      if (named) refresh();
    };
    // The room re-emits its threads' events; Receipt and UnreadNotifications move the counts.
    const roomEvents = [
      ThreadEvent.New,
      ThreadEvent.Update,
      ThreadEvent.NewReply,
      RoomEvent.Timeline,
      RoomEvent.UnreadNotifications,
      RoomEvent.Receipt,
    ] as const;
    for (const name of roomEvents) room.on(name, refresh);
    room.on(RoomStateEvent.Members, onMember);
    client.on(MatrixEventEvent.Decrypted, onDecrypted);
    let closed = false;
    void encryption.refresh(client.getCrypto?.(), roomId).then((encrypted) => {
      if (encrypted && !closed) refresh();
    });
    refresh();
    return () => {
      closed = true;
      for (const name of roomEvents) room.off(name, refresh);
      room.off(RoomStateEvent.Members, onMember);
      client.off(MatrixEventEvent.Decrypted, onDecrypted);
    };
  }

  /** Projects `room` in `focus` into `subscriber` until the returned teardown runs. */
  private attach(
    client: MatrixClient,
    room: Room,
    focus: TimelineFocus,
    subscriber: Subscriber<TimelineUpdate>,
  ): () => void {
    const roomId = room.roomId;
    const rootId = focus.kind === 'thread' ? focus.rootEventId : null;
    const rows = new TimelineRowCache<EventTimelineItem>({
      poll: (item) => item.content.kind === 'poll',
      receipts: (item) => item.readBy.length > 0,
    });
    const encryption = new RoomEncryptionFlags();
    // Captured once, so the read marker stays where it was when the subscription opened.
    // A thread has no read marker.
    const readMarker = rootId === null ? fullyReadOf(room) : null;
    let projectedTimeline: EventTimeline | null = null;
    let projectedEncryption = '';
    let relevantSenders = new Set<string>();
    let shieldsChecked = false;
    let closed = false;

    /** The open thread, bound to once it exists: a reply, or our first send, can form it. */
    let thread: Thread | null = null;
    const currentThread = (): Thread | null => {
      if (rootId === null) return null;
      const found = room.getThread(rootId) ?? null;
      if (found !== thread) bindThread(found);
      return thread;
    };
    const bindThread = (next: Thread | null): void => {
      thread?.off(ThreadEvent.Update, onThreadChanged);
      thread?.off(ThreadEvent.NewReply, onThreadChanged);
      thread?.off(RoomEvent.Timeline, onTimeline);
      thread = next;
      thread?.on(ThreadEvent.Update, onThreadChanged);
      thread?.on(ThreadEvent.NewReply, onThreadChanged);
      thread?.on(RoomEvent.Timeline, onTimeline);
    };
    /** Every event the focus holds, hidden ones included. */
    const focusEvents = (): MatrixEvent[] => {
      if (rootId === null) return room.getLiveTimeline().getEvents();
      const current = currentThread();
      const root = current?.rootEvent ?? room.findEventById(rootId);
      const events = current?.events ?? [];
      return root && !events.includes(root) ? [root, ...events] : events;
    };

    const roomState = (): TimelineRoomState => {
      const events = focusEvents();
      return {
        encryption: encryption.isEncrypted(room)
          ? 'encrypted'
          : encryption.answered(roomId)
            ? 'unencrypted'
            : 'unknown',
        hasEncryptionStateEvent: room.hasEncryptionStateEvent(),
        tombstone: tombstoneOf(room),
        latestConfirmedEventId: latestConfirmedId(events),
        oldestEventId: events[0]?.getId() ?? null,
      };
    };

    /** A message item, rebuilt only when what it shows has changed. */
    const messageItem = (
      event: MatrixEvent,
      id: string,
      shield: MessageShield | null,
      code: ShieldCode | null,
      subjectId: string,
      roomEncrypted: boolean,
    ): EventTimelineItem | null => {
      const { content, rest } = revisionOf(client, room, event, roomEncrypted);
      const revision = rest + '\x1f' + shieldKey(shield);
      const members = new Set<string>();
      collectMessageSenders(client, room, event, members);
      const previous = rows.previous(id);
      const unchanged =
        previous?.content === content && previous.rest === revision;
      const item = unchanged
        ? previous.view
        : toTimelineItem(client, room, event, code, roomEncrypted);
      rows.store(
        id,
        {
          content,
          rest: revision,
          view: item,
          shield,
          subjectId,
          members: [...members],
        },
        !unchanged,
      );
      return item;
    };

    /** A system line's item, kept while it stays equal. */
    const systemItem = (
      event: MatrixEvent,
      id: string,
      roomEncrypted: boolean,
    ): EventTimelineItem | null => {
      const reused = rows.reusable(id, undefined, null);
      if (reused) return reused.view;
      const built = toTimelineItem(client, room, event, null, roomEncrypted);
      const previous = rows.previous(id)?.view;
      const unchanged = !!previous && plainEqual(previous, built);
      // A system line shows no readers; its target's name can load late.
      const members = new Set<string>();
      collectMessageSenders(client, room, event, members, { receipts: false });
      const target = event.getStateKey();
      if (event.getType() === EventType.RoomMember && target) {
        members.add(target);
      }
      const item = unchanged ? previous : built;
      rows.store(
        id,
        {
          content: '',
          rest: '',
          view: item,
          shield: null,
          subjectId: id,
          members: [...members],
        },
        !unchanged,
      );
      return item;
    };

    const project = (): {
      readonly items: TimelineItem[];
      readonly checked: MatrixEvent[];
    } => {
      const liveTimeline =
        rootId === null
          ? room.getLiveTimeline()
          : (currentThread()?.liveTimeline ?? null);
      const events =
        rootId === null
          ? room.getLiveTimeline().getEvents()
          : this.threadEvents(room, rootId, currentThread());
      const roomEncrypted = encryption.isEncrypted(room);
      const markFor = unencryptedShieldFor(room, roomEncrypted);
      // A replaced timeline or an encryption change can change any row.
      const encryptionKey = `${roomEncrypted}:${room.hasEncryptionStateEvent()}`;
      rows.beginPass(
        liveTimeline !== projectedTimeline ||
          encryptionKey !== projectedEncryption,
      );
      projectedTimeline = liveTimeline;
      projectedEncryption = encryptionKey;
      const markerIndex = readMarker
        ? events.findIndex((e) => e.getId() === readMarker)
        : -1;
      const selfId = client.getUserId();
      const items: TimelineItem[] = [];
      const checked: MatrixEvent[] = [];
      let unreadAt = -1;
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (rootId === null && isThreadReply(event)) continue;
        const id = event.getId() ?? '';
        if (!isDisplayableMessage(event)) {
          if (!isPresentableSystemEvent(event)) continue;
          const item = systemItem(event, id, roomEncrypted);
          if (item) items.push(item);
          continue;
        }
        // Tested on the raw order: m.fully_read can name an event that renders nothing.
        if (
          markerIndex >= 0 &&
          i > markerIndex &&
          unreadAt < 0 &&
          event.getSender() !== selfId
        ) {
          unreadAt = items.length;
        }
        const shown = shownSubject(event);
        const subjectId = shown.getId() ?? '';
        const mark = markFor(event, shown);
        const code = mark ? null : shownShieldCode(shown);
        const shield = mark ?? (code && shieldText(code));
        const reused = rows.reusable(id, event.replyEventId, shield, subjectId);
        if (reused) {
          if (reused.view) items.push(reused.view);
          continue;
        }
        checked.push(event);
        const item = messageItem(
          event,
          id,
          shield,
          code,
          subjectId,
          roomEncrypted,
        );
        if (item) items.push(item);
      }
      const { pruned, rechecked } = rows.endPass();
      if (pruned || rechecked > 0) relevantSenders = rows.renderedMembers();
      if (unreadAt >= 0) items.splice(unreadAt, 0, READ_MARKER);
      if (rootId === null && atStart(room)) items.unshift(TIMELINE_START);
      return { items, checked };
    };

    const resolveShields = async (
      events: readonly MatrixEvent[],
      force = false,
    ): Promise<void> => {
      const crypto = client.getCrypto() ?? null;
      if (!crypto) return;
      // The crypto store may know the room is encrypted when its state does not say so.
      void encryption.refresh(crypto, roomId).then((encrypted) => {
        if (encrypted && !closed) flusher.schedule();
      });
      const encrypted = events
        .filter(
          (e) =>
            isDisplayableMessage(e) && (rootId !== null || !isThreadReply(e)),
        )
        .flatMap(shieldsToCheck);
      // Shields are kept per event, so the first check of a subscription asks afresh.
      const fresh = !shieldsChecked;
      shieldsChecked = true;
      const changed = await resolveShieldsInto(
        crypto,
        encrypted,
        resolvedShields,
        { force: force || fresh, isStale: () => closed },
      );
      if (changed && !closed) flusher.schedule();
    };

    const emit = (): void => {
      const { items, checked } = project();
      subscriber.next({
        kind: 'items',
        diffs: [{ op: 'reset', values: items }],
        backPagination: this.backPagination(client, room, focus),
        room: roomState(),
      });
      // Nothing new to check once the crypto store has answered: no crypto call per flush.
      if (checked.length > 0 || !encryption.answered(roomId)) {
        void resolveShields(checked);
      }
    };
    // A page shows only with the pagination state it ends in (T3): once it has landed,
    // changes wait the few microtasks until the flush that ends the page.
    let pageLanded = false;
    /** Settles waiting for the flush that ends a landed page. */
    let landedWaiters: (() => void)[] = [];
    const release = (): void => {
      const waiting = landedWaiters;
      landedWaiters = [];
      for (const resolve of waiting) resolve();
    };
    const flusher = coalesce(() => {
      if (!pageLanded) emit();
    });
    const schedule = (): void => flusher.schedule();
    const key = pageKey(roomId, focus);
    const feed: Feed = {
      client,
      roomId,
      pageKey: key,
      flush: () => {
        pageLanded = false;
        flusher.cancel();
        emit();
        release();
      },
      settle: () => {
        if (pageLanded) {
          return new Promise<void>((resolve) => landedWaiters.push(resolve));
        }
        flusher.cancel();
        emit();
        return Promise.resolve();
      },
      announce: () =>
        subscriber.next({
          kind: 'items',
          diffs: [],
          backPagination: this.backPagination(client, room, focus),
          room: roomState(),
        }),
    };

    // A removal re-checks every row: what it took away may be quoted.
    const onTimeline = (
      event?: MatrixEvent,
      _room?: Room,
      toStart?: boolean,
      removed?: boolean,
    ): void => {
      if (toStart && this.paging.get(client)?.has(key)) pageLanded = true;
      if (removed) rows.markAll();
      else rows.noteEvent(event);
      schedule();
    };
    const onLocalEcho = (
      event?: MatrixEvent,
      _room?: Room,
      oldEventId?: string,
    ): void => {
      rows.noteEvent(event, oldEventId);
      schedule();
    };
    const onReceipt = (event?: MatrixEvent): void => {
      rows.noteReceipt(event);
      schedule();
    };
    // A redaction, or a rewind or trim swapping the live timeline, can change any row.
    const onRedaction = (): void => {
      rows.markAll();
      schedule();
    };
    // Decryption, and which edit a message resolves to, change a row with no new event.
    const onEventChanged = (event: MatrixEvent): void => {
      if (event.getRoomId() !== roomId) return;
      rows.noteEvent(event);
      schedule();
    };
    // Who may end a poll follows the room's power levels.
    const onStateEvent = (event: MatrixEvent): void => {
      if (
        event.getRoomId() === roomId &&
        event.getType() === EventType.RoomPowerLevels
      ) {
        rows.notePollPermissions();
        schedule();
      }
    };
    // Gated on the rendered members, so a lazy member load re-checks only their rows.
    const onMember = (
      _event: MatrixEvent,
      _state: RoomState,
      member: RoomMember,
    ): void => {
      if (member.roomId === roomId && relevantSenders.has(member.userId)) {
        rows.noteMember(member.userId);
        schedule();
      }
    };
    // A trust change can flip any shield: re-resolve them all.
    const onTrust = (): void => {
      void resolveShields(focusEvents(), true);
    };
    // A thread's count, root or replies changed; the few rows it holds are all re-checked.
    const onThreadChanged = (): void => {
      rows.markAll();
      schedule();
    };

    room.on(RoomEvent.Timeline, onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
    room.on(RoomEvent.Receipt, onReceipt);
    room.on(RoomEvent.Redaction, onRedaction);
    room.on(RoomEvent.TimelineReset, onRedaction);
    room.on(RoomStateEvent.Members, onMember);
    room.on(RoomStateEvent.Events, onStateEvent);
    client.on(MatrixEventEvent.Decrypted, onEventChanged);
    client.on(MatrixEventEvent.Replaced, onEventChanged);
    client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
    client.on(CryptoEvent.DevicesUpdated, onTrust);
    client.on(CryptoEvent.KeysChanged, onTrust);
    // A remote reply, or our first send, can form the thread after it opened.
    if (rootId !== null) room.on(ThreadEvent.New, onThreadChanged);
    this.feeds.add(feed);
    // Members sync lazily; the senders' profiles arrive as RoomStateEvent.Members.
    void room.loadMembersIfNeeded().catch(() => undefined);

    emit();

    return () => {
      closed = true;
      release();
      flusher.cancel();
      this.feeds.delete(feed);
      room.off(RoomEvent.Timeline, onTimeline);
      room.off(RoomEvent.LocalEchoUpdated, onLocalEcho);
      room.off(RoomEvent.Receipt, onReceipt);
      room.off(RoomEvent.Redaction, onRedaction);
      room.off(RoomEvent.TimelineReset, onRedaction);
      room.off(RoomStateEvent.Members, onMember);
      room.off(RoomStateEvent.Events, onStateEvent);
      client.off(MatrixEventEvent.Decrypted, onEventChanged);
      client.off(MatrixEventEvent.Replaced, onEventChanged);
      client.off(CryptoEvent.UserTrustStatusChanged, onTrust);
      client.off(CryptoEvent.DevicesUpdated, onTrust);
      client.off(CryptoEvent.KeysChanged, onTrust);
      room.off(ThreadEvent.New, onThreadChanged);
      // As today's thread panel: closing the thread forgets that its pages ran dry.
      const closing = rootId === null ? null : room.getThread(rootId);
      if (
        closing &&
        ![...this.feeds].some((f) => f.client === client && f.pageKey === key)
      ) {
        this.exhausted.delete(closing);
      }
      bindThread(null);
    };
  }
}
