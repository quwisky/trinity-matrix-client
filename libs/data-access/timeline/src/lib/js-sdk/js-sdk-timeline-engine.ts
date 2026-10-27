import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  Direction,
  EventType,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
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
  type Subscriber,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  RoomEncryptionFlags,
  TYPING_TIMEOUT_MS,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  liveRoomState,
  plainEqual,
  type EngineFailure,
  type EngineResult,
} from '@trinity/util/matrix';
import type { MessageShield } from '../message-presentation';
import { shieldCodeOf, shieldKey } from '../shield-presentation';
import type {
  EventTimelineItem,
  Profile,
  ReactionDetailGroup,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  TimelineRoomState,
  TimelineUpdate,
} from '../timeline-engine';
import {
  collectMessageSenders,
  isDisplayableMessage,
  reactionSendersFor,
} from './event-reads';
import { revisionOf } from './event-revision';
import { scrollbackLive } from './live-scrollback';
import { isPresentableSystemEvent } from './normalize-timeline-event';
import {
  resolveShieldsInto,
  resolvedShields,
  shieldsToCheck,
  shownShield,
  shownSubject,
  unencryptedShieldFor,
} from './shields';
import { profileOf, toTimelineItem } from './timeline-item';
import { TimelineRowCache } from './timeline-row-cache';

/** Events per page while paging back to a target event. */
const SCROLLBACK = 30;

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
  code: 'account-not-live' | 'message-unavailable' | 'unsupported',
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

/** An open `timeline()` subscription, which commands bring up to date before replying. */
interface Feed {
  readonly client: MatrixClient;
  readonly roomId: string;
  /** Emits the current items now, dropping a queued emission. */
  flush(): void;
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
  private readonly feeds = new Set<Feed>();
  /** The rooms with a page in flight, per client. */
  private readonly paging = new WeakMap<MatrixClient, Set<string>>();
  /** The last page queued per room, per client: a room pages one page at a time. */
  private readonly queues = new WeakMap<
    MatrixClient,
    Map<string, Promise<unknown>>
  >();

  timeline(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
  ): Observable<TimelineUpdate> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      // shortcut: a thread focus reads as unavailable until threads move here (PR 3, T23).
      if (!client || focus.kind !== 'live') {
        return concat(of(UNAVAILABLE), NEVER);
      }
      return new Observable<TimelineUpdate>((subscriber) => {
        let detach: (() => void) | null = null;
        const onRoom = (room: Room): void => {
          if (room.roomId !== roomId || detach) return;
          client.off(ClientEvent.Room, onRoom);
          detach = this.attach(client, room, subscriber);
        };
        const room = client.getRoom(roomId);
        if (room) {
          detach = this.attach(client, room, subscriber);
        } else {
          subscriber.next(UNAVAILABLE);
          client.on(ClientEvent.Room, onRoom);
        }
        return () => {
          client.off(ClientEvent.Room, onRoom);
          detach?.();
        };
      });
    });
  }

  paginateBackwards(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
    count: number,
  ): Observable<EngineResult<{ readonly startReached: boolean }>> {
    return this.command(accountId, (client) => {
      if (focus.kind !== 'live') {
        return of(engineFail(localFailure('unsupported')));
      }
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      let stopped = false;
      return from(
        // Skipped when unsubscribed while it waited behind another page.
        this.paged(client, room, async () => {
          if (!stopped) await scrollbackLive(client, room, count);
        }),
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
        this.paged(client, room, async () => {
          for (let page = 0; page < maxPages && !stopped; page++) {
            if (atStart(room)) break;
            // Show the previous page before the next request, so live changes keep flowing.
            if (page > 0) this.flushFeeds(client, roomId);
            await scrollbackLive(client, room, SCROLLBACK);
            if (loaded()) return true;
          }
          return false;
        }),
      ).pipe(
        map((found) => engineOk({ found })),
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
    room: Room,
    page: () => Promise<T>,
  ): Promise<T> {
    const roomId = room.roomId;
    const run = async (): Promise<T> => {
      this.setPaging(client, roomId, true);
      try {
        return await page();
      } finally {
        this.setPaging(client, roomId, false);
      }
    };
    const queues =
      this.queues.get(client) ?? new Map<string, Promise<unknown>>();
    this.queues.set(client, queues);
    const previous = queues.get(roomId);
    const result = previous ? previous.then(run, run) : run();
    const tail = result.catch(() => undefined);
    queues.set(roomId, tail);
    void tail.then(() => {
      if (queues.get(roomId) === tail) queues.delete(roomId);
    });
    return result;
  }

  private setPaging(client: MatrixClient, roomId: string, on: boolean): void {
    const rooms = this.paging.get(client) ?? new Set<string>();
    this.paging.set(client, rooms);
    if (on) rooms.add(roomId);
    else rooms.delete(roomId);
    for (const feed of this.feeds) {
      if (feed.client !== client || feed.roomId !== roomId) continue;
      if (on) feed.announce();
      else feed.flush();
    }
  }

  private flushFeeds(client: MatrixClient, roomId: string): void {
    for (const feed of this.feeds) {
      if (feed.client === client && feed.roomId === roomId) feed.flush();
    }
  }

  private backPagination(
    client: MatrixClient,
    room: Room,
  ): 'idle' | 'paginating' | 'start-reached' {
    if (this.paging.get(client)?.has(room.roomId)) return 'paginating';
    return atStart(room) ? 'start-reached' : 'idle';
  }

  /** Projects `room` into `subscriber` until the returned teardown runs. */
  private attach(
    client: MatrixClient,
    room: Room,
    subscriber: Subscriber<TimelineUpdate>,
  ): () => void {
    const roomId = room.roomId;
    const rows = new TimelineRowCache<EventTimelineItem>({
      poll: (item) => item.content.kind === 'poll',
      receipts: (item) => item.readBy.length > 0,
    });
    const encryption = new RoomEncryptionFlags();
    // Captured once, so the read marker stays where it was when the subscription opened.
    const readMarker = fullyReadOf(room);
    let projectedTimeline: EventTimeline | null = null;
    let projectedEncryption = '';
    let relevantSenders = new Set<string>();
    let shieldsChecked = false;
    let closed = false;

    const roomState = (): TimelineRoomState => {
      const events = room.getLiveTimeline().getEvents();
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
        : toTimelineItem(
            client,
            room,
            event,
            shield && shieldCodeOf(shield),
            roomEncrypted,
          );
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
      const liveTimeline = room.getLiveTimeline();
      const events = liveTimeline.getEvents();
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
        if (isThreadReply(event)) continue;
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
        const shield = markFor(event, shown) ?? shownShield(shown);
        const reused = rows.reusable(id, event.replyEventId, shield, subjectId);
        if (reused) {
          if (reused.view) items.push(reused.view);
          continue;
        }
        checked.push(event);
        const item = messageItem(event, id, shield, subjectId, roomEncrypted);
        if (item) items.push(item);
      }
      const { pruned, rechecked } = rows.endPass();
      if (pruned || rechecked > 0) relevantSenders = rows.renderedMembers();
      if (unreadAt >= 0) items.splice(unreadAt, 0, READ_MARKER);
      if (atStart(room)) items.unshift(TIMELINE_START);
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
        .filter((e) => isDisplayableMessage(e) && !isThreadReply(e))
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
        backPagination: this.backPagination(client, room),
        room: roomState(),
      });
      void resolveShields(checked);
    };
    // A page shows only with the pagination state it ends in (T3): once it has landed,
    // changes wait the few microtasks until the flush that ends the page.
    let pageLanded = false;
    const flusher = coalesce(() => {
      if (!pageLanded) emit();
    });
    const schedule = (): void => flusher.schedule();
    const feed: Feed = {
      client,
      roomId,
      flush: () => {
        pageLanded = false;
        flusher.cancel();
        emit();
      },
      announce: () =>
        subscriber.next({
          kind: 'items',
          diffs: [],
          backPagination: this.backPagination(client, room),
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
      if (toStart && this.paging.get(client)?.has(roomId)) pageLanded = true;
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
      void resolveShields(room.getLiveTimeline().getEvents(), true);
    };

    room.on(RoomEvent.Timeline, onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
    room.on(RoomEvent.Receipt, onReceipt);
    room.on(RoomEvent.Redaction, onRedaction);
    room.on(RoomStateEvent.Members, onMember);
    room.on(RoomStateEvent.Events, onStateEvent);
    client.on(MatrixEventEvent.Decrypted, onEventChanged);
    client.on(MatrixEventEvent.Replaced, onEventChanged);
    client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
    client.on(CryptoEvent.DevicesUpdated, onTrust);
    client.on(CryptoEvent.KeysChanged, onTrust);
    this.feeds.add(feed);
    // Members sync lazily; the senders' profiles arrive as RoomStateEvent.Members.
    void room.loadMembersIfNeeded().catch(() => undefined);

    emit();

    return () => {
      closed = true;
      flusher.cancel();
      this.feeds.delete(feed);
      room.off(RoomEvent.Timeline, onTimeline);
      room.off(RoomEvent.LocalEchoUpdated, onLocalEcho);
      room.off(RoomEvent.Receipt, onReceipt);
      room.off(RoomEvent.Redaction, onRedaction);
      room.off(RoomStateEvent.Members, onMember);
      room.off(RoomStateEvent.Events, onStateEvent);
      client.off(MatrixEventEvent.Decrypted, onEventChanged);
      client.off(MatrixEventEvent.Replaced, onEventChanged);
      client.off(CryptoEvent.UserTrustStatusChanged, onTrust);
      client.off(CryptoEvent.DevicesUpdated, onTrust);
      client.off(CryptoEvent.KeysChanged, onTrust);
    };
  }
}
