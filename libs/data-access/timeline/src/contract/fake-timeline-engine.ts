import {
  type Observable,
  Subject,
  defer,
  filter,
  map,
  of,
  startWith,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineFailureCode,
  type EngineResult,
  engineFail,
  type VectorDiff,
  applyVectorDiffs,
  engineOk,
} from '@trinity/util/matrix';
import type {
  EventTimelineItem,
  Profile,
  ReactionDetailGroup,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  TimelineItemContent,
  TimelineRoomState,
  TimelineUpdate,
} from '../lib/timeline-engine';

type FailNextCode = Exclude<
  EngineFailureCode,
  'discovery-failed' | 'account-start-failed'
>;

interface FakeRoom {
  readonly members: Set<string>;
  /** The whole history, oldest first, as every member sees it. */
  history: readonly TimelineItem[];
  overrides: Partial<TimelineRoomState>;
  /** How many of the newest history items each member has loaded. */
  readonly loaded: Map<string, number>;
  readonly startReached: Set<string>;
  readonly fullyRead: Map<string, string>;
  /** Public `m.read` receipts by user. */
  readonly readReceipts: Map<string, string>;
  readonly invited: Set<string>;
}

function failure(code: FailNextCode): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

const MESSAGE_UNAVAILABLE = failure('message-unavailable');
const START_ITEM: TimelineItem = {
  kind: 'timelineStart',
  uniqueId: 'timeline-start',
};

function profileOf(displayName: string): Profile {
  return { displayName, displayNameAmbiguous: false, avatarMxc: null };
}

function textContent(body: string): TimelineItemContent {
  return {
    kind: 'message',
    msgtype: 'text',
    body,
    formattedBody: null,
    replyFallback: false,
    mentionsMe: false,
    mentions: [],
  };
}

/** A confirmed text message from `sender`; `patch` overrides any field. */
export function fakeEventItem(
  eventId: string,
  sender: string,
  patch: Partial<EventTimelineItem> = {},
): EventTimelineItem {
  return {
    kind: 'event',
    uniqueId: `ev:${eventId}`,
    eventId,
    transactionId: null,
    sender,
    isOwn: false,
    timestamp: 0,
    sendState: null,
    content: textContent(eventId),
    edited: false,
    inReplyTo: null,
    reactions: [],
    readBy: [],
    shield: null,
    unencryptedMark: null,
    profiles: { [sender]: profileOf(sender) },
    ...patch,
  };
}

/**
 * In-memory timelines for `alice` (live) and `bob` (driven through `asBob`). Emits synchronously
 * and resets the whole list on every change; the focus is ignored.
 */
export class FakeTimelineEngine implements TimelineEngine {
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly live = new Set<string>();
  private readonly userNames = new Map<string, string>();
  private readonly changes$ = new Subject<{
    readonly accountId: string;
    readonly roomId: string;
    readonly update: TimelineUpdate;
  }>();
  private nextRoom = 0;
  private nextEvent = 0;
  private clock = 1_700_000_000_000;
  private nextFailure: FailNextCode | null = null;

  readonly serverName = 'example.org';
  readonly alice = `@alice:${this.serverName}`;
  readonly bob = `@bob:${this.serverName}`;
  /** How many events a join shows and `paginateUntil` loads per page. */
  pageSize = 20;

  readonly asAlice = {
    join: async (roomId: string): Promise<void> => {
      const room = this.room(roomId);
      if (!room.invited.has(this.alice) && !room.members.has(this.alice))
        throw new Error(`${this.alice} is not invited to ${roomId}`);
      room.members.add(this.alice);
      room.loaded.set(this.alice, Math.min(this.pageSize, room.history.length));
      this.publish(roomId);
    },
    fullyRead: async (roomId: string): Promise<string | null> =>
      this.rooms.get(roomId)?.fullyRead.get(this.alice) ?? null,
  };

  /** Acts on the fake's rooms as `bob` would on a server. */
  readonly asBob = {
    createRoom: async (_name: string): Promise<string> => {
      this.nextRoom += 1;
      const roomId = `!fake-${this.nextRoom}:${this.serverName}`;
      this.room(roomId).members.add(this.bob);
      return roomId;
    },
    invite: async (roomId: string, userId: string): Promise<void> => {
      this.room(roomId).invited.add(userId);
    },
    send: async (roomId: string, body: string): Promise<string> => {
      this.nextEvent += 1;
      this.clock += 1;
      const eventId = `$fake-${this.nextEvent}`;
      const room = this.room(roomId);
      room.history = [
        ...room.history,
        fakeEventItem(eventId, this.bob, {
          timestamp: this.clock,
          content: textContent(body),
          profiles: { [this.bob]: this.profile(this.bob) },
        }),
      ];
      for (const [accountId, count] of room.loaded)
        room.loaded.set(accountId, count + 1);
      this.publish(roomId);
      return eventId;
    },
    react: async (roomId: string, eventId: string, key: string) =>
      this.patchEvent(roomId, eventId, (item) => ({
        reactions: item.reactions.some((g) => g.key === key)
          ? item.reactions.map((g) =>
              g.key === key
                ? {
                    ...g,
                    count: g.count + 1,
                    senders: g.senders.includes(this.bob)
                      ? g.senders
                      : [...g.senders, this.bob],
                  }
                : g,
            )
          : [
              ...item.reactions,
              { key, count: 1, reactedByMe: false, senders: [this.bob] },
            ],
        profiles: { ...item.profiles, [this.bob]: this.profile(this.bob) },
      })),
    redact: async (roomId: string, eventId: string) =>
      this.patchEvent(roomId, eventId, () => ({
        content: { kind: 'redacted', replyFallback: false },
        reactions: [],
      })),
    edit: async (roomId: string, eventId: string, body: string) =>
      this.patchEvent(roomId, eventId, () => ({
        content: textContent(body),
        edited: true,
      })),
    readReceipt: async (
      roomId: string,
      userId: string,
    ): Promise<string | null> =>
      this.rooms.get(roomId)?.readReceipts.get(userId) ?? null,
  };

  constructor() {
    this.userNames.set(this.alice, 'Alice');
    this.userNames.set(this.bob, 'Bob');
    this.live.add(this.alice);
  }

  /** Makes `accountId` live and a member of `roomId`, with exactly `items` loaded. */
  seed(
    accountId: string,
    roomId: string,
    items: readonly TimelineItem[],
    room: Partial<TimelineRoomState> = {},
  ): void {
    this.live.add(accountId);
    const fake = this.room(roomId);
    fake.members.add(accountId);
    fake.history = items;
    fake.overrides = room;
    fake.loaded.set(accountId, items.length);
    fake.startReached.delete(accountId);
    this.publish(roomId);
  }

  /** Pushes `update` to open subscriptions as-is; the fake's own state is unchanged. */
  emit(accountId: string, roomId: string, update: TimelineUpdate): void {
    this.changes$.next({ accountId, roomId, update });
  }

  /**
   * Applies `diffs` to the account's loaded items and emits them as one update, for granular
   * changes and virtual items such as `{ kind: 'readMarker' }` that the fake never makes itself.
   */
  emitDiffs(
    accountId: string,
    roomId: string,
    diffs: readonly VectorDiff<TimelineItem>[],
  ): void {
    const room = this.room(roomId);
    const current = this.snapshot(accountId, roomId);
    const shown =
      current.kind === 'items' && current.diffs[0]?.op === 'reset'
        ? current.diffs[0].values
        : [];
    const next = applyVectorDiffs(shown, diffs).filter(
      (item) => item.uniqueId !== START_ITEM.uniqueId,
    );
    const hidden = room.history.slice(
      0,
      room.history.length - (room.loaded.get(accountId) ?? 0),
    );
    room.history = [...hidden, ...next];
    room.loaded.set(accountId, next.length);
    this.emit(accountId, roomId, {
      kind: 'items',
      diffs,
      backPagination: room.startReached.has(accountId)
        ? 'start-reached'
        : 'idle',
      room: this.roomState(accountId, room),
    });
  }

  failNext(code: FailNextCode): void {
    this.nextFailure = code;
  }

  timeline(
    accountId: string,
    roomId: string,
    _focus: TimelineFocus,
  ): Observable<TimelineUpdate> {
    return defer(() =>
      this.changes$.pipe(
        filter((c) => c.accountId === accountId && c.roomId === roomId),
        map((c) => c.update),
        startWith(this.snapshot(accountId, roomId)),
      ),
    );
  }

  paginateBackwards(
    accountId: string,
    roomId: string,
    _focus: TimelineFocus,
    count: number,
  ): Observable<EngineResult<{ readonly startReached: boolean }>> {
    return this.run(accountId, roomId, (room) =>
      engineOk({ startReached: this.paginate(accountId, roomId, room, count) }),
    );
  }

  paginateUntil(
    accountId: string,
    roomId: string,
    eventId: string,
    maxPages: number,
  ): Observable<EngineResult<{ readonly found: boolean }>> {
    return this.run(accountId, roomId, (room) => {
      const found = () =>
        this.visible(accountId, room).some(
          (i) => i.kind === 'event' && i.eventId === eventId,
        );
      for (let page = 0; page < maxPages && !found(); page++)
        this.paginate(accountId, roomId, room, this.pageSize);
      return engineOk({ found: found() });
    });
  }

  eventAt(
    accountId: string,
    roomId: string,
    timestamp: number,
  ): Observable<EngineResult<{ readonly eventId: string } | null>> {
    return this.run(accountId, roomId, (room) => {
      const item = this.events(room).find(
        (i) => i.eventId !== null && i.timestamp >= timestamp,
      );
      return engineOk(item?.eventId ? { eventId: item.eventId } : null);
    });
  }

  eventSource(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<Readonly<Record<string, unknown>> | null>> {
    return this.run(accountId, roomId, (room) => {
      const item = this.event(room, eventId);
      if (!item) return engineFail(MESSAGE_UNAVAILABLE);
      const { content } = item;
      return engineOk({
        event_id: eventId,
        room_id: roomId,
        sender: item.sender,
        origin_server_ts: item.timestamp,
        type: 'm.room.message',
        content:
          content.kind === 'message'
            ? { msgtype: `m.${content.msgtype}`, body: content.body }
            : {},
      });
    });
  }

  reactionDetails(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<readonly ReactionDetailGroup[]>> {
    return this.run(accountId, roomId, (room) => {
      const item = this.event(room, eventId);
      if (!item) return engineFail(MESSAGE_UNAVAILABLE);
      return engineOk(
        item.reactions.map((group) => ({
          key: group.key,
          senders: group.senders,
          profiles: Object.fromEntries(
            group.senders.map((sender) => [
              sender,
              item.profiles[sender] ?? this.profile(sender),
            ]),
          ),
        })),
      );
    });
  }

  sendReceipt(
    accountId: string,
    roomId: string,
    eventId: string,
    options: {
      readonly visibility: 'public' | 'private';
      readonly fullyRead: boolean;
    },
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, (room) => {
      if (options.fullyRead) room.fullyRead.set(accountId, eventId);
      if (options.visibility === 'public')
        room.readReceipts.set(accountId, eventId);
      return engineOk(null);
    });
  }

  setTyping(
    accountId: string,
    roomId: string,
    _typing: boolean,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, () => engineOk(null));
  }

  /** A cold command: scripted failure, then the live-account and membership checks, then `action`. */
  private run<T>(
    accountId: string,
    roomId: string,
    action: (room: FakeRoom) => EngineResult<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const scripted = this.nextFailure;
      this.nextFailure = null;
      if (scripted) return of(engineFail(failure(scripted)));
      if (!this.live.has(accountId))
        return of(engineFail(failure('account-not-live')));
      const room = this.rooms.get(roomId);
      if (!room?.members.has(accountId))
        return of(engineFail(MESSAGE_UNAVAILABLE));
      return of(action(room));
    });
  }

  /** Loads up to `count` older items in one update after a `paginating` one; returns start-reached. */
  private paginate(
    accountId: string,
    roomId: string,
    room: FakeRoom,
    count: number,
  ): boolean {
    this.emit(accountId, roomId, {
      kind: 'items',
      diffs: [],
      backPagination: 'paginating',
      room: this.roomState(accountId, room),
    });
    const loaded = room.loaded.get(accountId) ?? 0;
    room.loaded.set(accountId, Math.min(loaded + count, room.history.length));
    if (loaded + count >= room.history.length) room.startReached.add(accountId);
    this.emit(accountId, roomId, this.snapshot(accountId, roomId));
    return room.startReached.has(accountId);
  }

  private snapshot(accountId: string, roomId: string): TimelineUpdate {
    const room = this.rooms.get(roomId);
    if (!room?.members.has(accountId)) return { kind: 'room-unavailable' };
    const startReached = room.startReached.has(accountId);
    const items = this.visible(accountId, room);
    return {
      kind: 'items',
      diffs: [
        { op: 'reset', values: startReached ? [START_ITEM, ...items] : items },
      ],
      backPagination: startReached ? 'start-reached' : 'idle',
      room: this.roomState(accountId, room),
    };
  }

  private roomState(accountId: string, room: FakeRoom): TimelineRoomState {
    const all = this.events(room).filter((i) => i.eventId !== null);
    const loaded = this.visible(accountId, room).filter(
      (i): i is EventTimelineItem => i.kind === 'event' && i.eventId !== null,
    );
    return {
      encryption: 'unencrypted',
      tombstone: null,
      latestConfirmedEventId: all.at(-1)?.eventId ?? null,
      oldestEventId: loaded[0]?.eventId ?? null,
      ...room.overrides,
    };
  }

  private visible(accountId: string, room: FakeRoom): readonly TimelineItem[] {
    const loaded = room.loaded.get(accountId) ?? 0;
    return room.history.slice(room.history.length - loaded);
  }

  private events(room: FakeRoom): readonly EventTimelineItem[] {
    return room.history.filter(
      (i): i is EventTimelineItem => i.kind === 'event',
    );
  }

  private event(
    room: FakeRoom,
    eventId: string,
  ): EventTimelineItem | undefined {
    return this.events(room).find((i) => i.eventId === eventId);
  }

  private patchEvent(
    roomId: string,
    eventId: string,
    patch: (item: EventTimelineItem) => Partial<EventTimelineItem>,
  ): void {
    const room = this.room(roomId);
    room.history = room.history.map((i) =>
      i.kind === 'event' && i.eventId === eventId ? { ...i, ...patch(i) } : i,
    );
    this.publish(roomId);
  }

  private publish(roomId: string): void {
    for (const accountId of this.room(roomId).members)
      this.emit(accountId, roomId, this.snapshot(accountId, roomId));
  }

  private room(roomId: string): FakeRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        members: new Set(),
        history: [],
        overrides: {},
        loaded: new Map(),
        startReached: new Set(),
        fullyRead: new Map(),
        readReceipts: new Map(),
        invited: new Set(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private profile(userId: string): Profile {
    return profileOf(this.userNames.get(userId) ?? userId);
  }
}
