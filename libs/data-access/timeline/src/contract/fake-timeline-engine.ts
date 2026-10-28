import {
  type Observable,
  Subject,
  defer,
  distinctUntilChanged,
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
  plainEqual,
} from '@trinity/util/matrix';
import type { PollView } from '@trinity/util/matrix';
import type {
  EventTimelineItem,
  OutgoingMessage,
  OutgoingText,
  Profile,
  ReactionDetailGroup,
  ThreadSummaryInfo,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  TimelineItemContent,
  TimelineItemKey,
  TimelineRoomState,
  TimelineUpdate,
  VoiceClip,
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
  /** Each voter's answers, per poll event id. */
  readonly votes: Map<string, Map<string, readonly string[]>>;
  /** The thread root of each thread reply, by the reply's `uniqueId`. */
  readonly threads: Map<string, string>;
}

function failure(code: FailNextCode): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

const MESSAGE_UNAVAILABLE = failure('message-unavailable');
const NOT_CANCELLABLE = failure('not-cancellable');
const NOT_FORWARDABLE = failure('not-forwardable');
/** What the fake can copy: the kinds whose content stands on its own. */
const FORWARDABLE: ReadonlySet<TimelineItemContent['kind']> = new Set([
  'message',
  'media',
  'sticker',
  'location',
]);
/** Most participants a thread summary names. */
const MAX_PARTICIPANTS = 8;
const START_ITEM: TimelineItem = {
  kind: 'timelineStart',
  uniqueId: 'timeline-start',
};

function profileOf(displayName: string): Profile {
  return { displayName, displayNameAmbiguous: false, avatarMxc: null };
}

function outgoingContent(message: OutgoingText): TimelineItemContent {
  return {
    kind: 'message',
    msgtype: message.msgtype,
    body: message.body,
    formattedBody: message.formattedBody,
    replyFallback: false,
    mentionsMe: false,
    mentions: [...message.mentions.userIds],
  };
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
 * and resets the whole list on every change. A thread focus shows every reply at once.
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
    send: async (roomId: string, body: string): Promise<string> =>
      this.bobSends(roomId, body, null),
    sendInThread: async (
      roomId: string,
      rootId: string,
      body: string,
    ): Promise<string> => this.bobSends(roomId, body, rootId),
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

  private bobSends(
    roomId: string,
    body: string,
    threadRootId: string | null,
  ): string {
    this.nextEvent += 1;
    this.clock += 1;
    const eventId = `$fake-${this.nextEvent}`;
    const room = this.room(roomId);
    if (threadRootId) room.threads.set(`ev:${eventId}`, threadRootId);
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
  }

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
    focus: TimelineFocus,
  ): Observable<TimelineUpdate> {
    return defer(() =>
      this.changes$.pipe(
        filter((c) => c.accountId === accountId && c.roomId === roomId),
        map((c) =>
          focus.kind === 'live'
            ? c.update
            : this.threadSnapshot(accountId, roomId, focus.rootEventId),
        ),
        startWith(
          focus.kind === 'live'
            ? this.snapshot(accountId, roomId)
            : this.threadSnapshot(accountId, roomId, focus.rootEventId),
        ),
      ),
    );
  }

  paginateBackwards(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
    count: number,
  ): Observable<EngineResult<{ readonly startReached: boolean }>> {
    return this.run(accountId, roomId, (room) =>
      engineOk({
        startReached:
          focus.kind === 'thread' ||
          this.paginate(accountId, roomId, room, count),
      }),
    );
  }

  threadSummaries(
    accountId: string,
    roomId: string,
  ): Observable<readonly VectorDiff<ThreadSummaryInfo>[]> {
    return defer(() =>
      this.changes$.pipe(
        filter((c) => c.accountId === accountId && c.roomId === roomId),
        startWith(null),
        map(() => this.summaries(accountId, roomId)),
        distinctUntilChanged((a, b) => plainEqual(a, b)),
        map((values): readonly VectorDiff<ThreadSummaryInfo>[] => [
          { op: 'reset', values },
        ]),
      ),
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
      const item = this.visible(accountId, room).find(
        (i): i is EventTimelineItem =>
          i.kind === 'event' && i.eventId === eventId,
      );
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
    return this.run(accountId, roomId, (room) => {
      const eventId = this.nextEventId();
      const transactionId =
        options.transactionId ?? `fake-txn-${this.nextEvent}`;
      if (message.kind === 'poll-response' || message.kind === 'poll-end') {
        const poll = this.event(room, message.pollId);
        if (poll?.content.kind !== 'poll')
          return engineFail(MESSAGE_UNAVAILABLE);
        if (message.kind === 'poll-end') {
          this.patchEvent(roomId, message.pollId, () => ({
            content: {
              kind: 'poll',
              poll: { ...this.pollOf(poll), ended: true },
            },
          }));
        } else {
          const votes =
            room.votes.get(message.pollId) ??
            new Map<string, readonly string[]>();
          room.votes.set(
            message.pollId,
            votes.set(accountId, message.answerIds),
          );
          this.publish(roomId);
        }
        return engineOk({ transactionId, eventId });
      }
      const target = options.replyTo ? this.event(room, options.replyTo) : null;
      if (options.threadRootId)
        room.threads.set(`txn:${transactionId}`, options.threadRootId);
      this.append(roomId, {
        ...this.own(accountId, eventId, this.contentOf(message, eventId)),
        uniqueId: `txn:${transactionId}`,
        transactionId,
        inReplyTo:
          options.replyTo && message.kind === 'text'
            ? {
                eventId: options.replyTo,
                details: target
                  ? {
                      kind: 'ready',
                      sender: target.sender,
                      body:
                        target.content.kind === 'message'
                          ? target.content.body
                          : '',
                      redacted: target.content.kind === 'redacted',
                      unencryptedMark: null,
                    }
                  : { kind: 'unavailable' },
              }
            : null,
      });
      return engineOk({ transactionId, eventId });
    });
  }

  edit(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    message: OutgoingText,
    _options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onItem(accountId, roomId, item, (found) =>
      this.patchItem(roomId, found, () => ({
        content: outgoingContent(message),
        edited: true,
      })),
    );
  }

  redact(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    _options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onItem(accountId, roomId, item, (found) =>
      this.patchItem(roomId, found, () => ({
        content: { kind: 'redacted', replyFallback: false },
        reactions: [],
      })),
    );
  }

  toggleReaction(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    key: string,
    _options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onItem(accountId, roomId, item, (found) =>
      this.patchItem(roomId, found, (current) => {
        const group = current.reactions.find((g) => g.key === key);
        if (group?.senders.includes(accountId)) {
          return {
            reactions: current.reactions.flatMap((g) => {
              if (g.key !== key) return [g];
              const senders = g.senders.filter((s) => s !== accountId);
              return senders.length
                ? [{ ...g, count: g.count - 1, reactedByMe: false, senders }]
                : [];
            }),
          };
        }
        return {
          reactions: group
            ? current.reactions.map((g) =>
                g.key === key
                  ? {
                      ...g,
                      count: g.count + 1,
                      reactedByMe: true,
                      senders: [...g.senders, accountId],
                    }
                  : g,
              )
            : [
                ...current.reactions,
                { key, count: 1, reactedByMe: true, senders: [accountId] },
              ],
          profiles: {
            ...current.profiles,
            [accountId]: this.profile(accountId),
          },
        };
      }),
    );
  }

  retrySend(
    accountId: string,
    roomId: string,
    transactionId: string,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, (room) => {
      const echo = this.unsent(room, transactionId);
      if (!echo) return engineFail(MESSAGE_UNAVAILABLE);
      this.patchItem(roomId, echo, () => ({ sendState: null }));
      return engineOk(null);
    });
  }

  cancelSend(
    accountId: string,
    roomId: string,
    transactionId: string,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, (room) => {
      const echo = this.events(room).find(
        (i) => i.transactionId === transactionId,
      );
      if (!echo) return engineFail(MESSAGE_UNAVAILABLE);
      if (!this.unsent(room, transactionId)) return engineFail(NOT_CANCELLABLE);
      room.history = room.history.filter((i) => i !== echo);
      for (const [member, count] of room.loaded)
        room.loaded.set(member, count - 1);
      this.publish(roomId);
      return engineOk(null);
    });
  }

  forward(
    accountId: string,
    sourceRoomId: string,
    eventId: string,
    targetRoomId: string,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, sourceRoomId, (room) => {
      const source = this.event(room, eventId);
      if (!source) return engineFail(MESSAGE_UNAVAILABLE);
      if (!FORWARDABLE.has(source.content.kind))
        return engineFail(NOT_FORWARDABLE);
      if (!this.rooms.get(targetRoomId)?.members.has(accountId))
        return engineFail(MESSAGE_UNAVAILABLE);
      this.append(
        targetRoomId,
        this.own(accountId, this.nextEventId(), source.content),
      );
      return engineOk(null);
    });
  }

  sendVoice(
    accountId: string,
    roomId: string,
    clip: VoiceClip,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, () => {
      const eventId = this.nextEventId();
      this.append(
        roomId,
        this.own(accountId, eventId, {
          kind: 'media',
          msgtype: 'audio',
          source: {
            kind: 'audio',
            mxc: `mxc://${this.serverName}/${eventId.slice(1)}`,
            file: null,
            filename: 'Voice message',
            mimeType: clip.mimeType,
            size: clip.blob.size,
            durationMs: clip.durationMs,
            thumbnailMxc: null,
            thumbnailFile: null,
            isVoice: true,
            waveform: [...clip.waveform],
          },
          body: 'Voice message',
          caption: null,
          formattedCaption: null,
          replyFallback: false,
          mentionsMe: false,
          mentions: [],
        }),
      );
      return engineOk(null);
    });
  }

  /** A cold command on the item `key` names, `message-unavailable` when there is none. */
  private onItem(
    accountId: string,
    roomId: string,
    key: TimelineItemKey,
    action: (item: EventTimelineItem) => void,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, (room) => {
      const item = this.events(room).find(
        (i) =>
          (key.eventId !== null && i.eventId === key.eventId) ||
          (key.transactionId !== null && i.transactionId === key.transactionId),
      );
      if (!item) return engineFail(MESSAGE_UNAVAILABLE);
      action(item);
      return engineOk(null);
    });
  }

  private unsent(
    room: FakeRoom,
    transactionId: string,
  ): EventTimelineItem | undefined {
    return this.events(room).find(
      (i) =>
        i.transactionId === transactionId &&
        (i.sendState?.kind === 'failed' || i.sendState?.kind === 'waiting'),
    );
  }

  private nextEventId(): string {
    this.nextEvent += 1;
    return `$fake-${this.nextEvent}`;
  }

  private own(
    accountId: string,
    eventId: string,
    content: TimelineItemContent,
  ): EventTimelineItem {
    this.clock += 1;
    return fakeEventItem(eventId, accountId, {
      isOwn: true,
      timestamp: this.clock,
      content,
      profiles: { [accountId]: this.profile(accountId) },
    });
  }

  private contentOf(
    message: Exclude<OutgoingMessage, { kind: 'poll-response' | 'poll-end' }>,
    eventId: string,
  ): TimelineItemContent {
    switch (message.kind) {
      case 'text':
        return outgoingContent(message);
      case 'location':
        return {
          kind: 'location',
          lat: message.lat,
          lng: message.lng,
          label: message.label ?? 'Shared location',
        };
      case 'sticker':
        return {
          kind: 'sticker',
          source: {
            kind: 'image',
            mxc: message.url,
            file: null,
            filename: message.body,
            mimeType: 'image/png',
            thumbnailMxc: null,
            thumbnailFile: null,
          },
          body: message.body,
          url: message.url,
          info: message.info,
        };
      case 'poll-start':
        return {
          kind: 'poll',
          poll: {
            id: eventId,
            question: message.question,
            options: message.answers.map((text, index) => ({
              id: `a${index}`,
              text,
              votes: 0,
              chosen: false,
            })),
            totalVotes: 0,
            maxSelections: message.maxSelections,
            ended: false,
          },
        };
    }
  }

  private pollOf(item: EventTimelineItem): PollView {
    if (item.content.kind !== 'poll') throw new Error('not a poll');
    return item.content.poll;
  }

  private tally(
    poll: PollView,
    votes: ReadonlyMap<string, readonly string[]>,
    viewer: string,
  ): PollView {
    const voters = [...votes].filter(([, answers]) => answers.length > 0);
    return {
      ...poll,
      totalVotes: voters.length,
      options: poll.options.map((option) => ({
        ...option,
        votes: voters.filter(([, answers]) => answers.includes(option.id))
          .length,
        chosen: votes.get(viewer)?.includes(option.id) ?? false,
      })),
    };
  }

  private append(roomId: string, item: EventTimelineItem): void {
    const room = this.room(roomId);
    room.history = [...room.history, item];
    for (const [member, count] of room.loaded)
      room.loaded.set(member, count + 1);
    this.publish(roomId);
  }

  private patchItem(
    roomId: string,
    target: EventTimelineItem,
    patch: (item: EventTimelineItem) => Partial<EventTimelineItem>,
  ): void {
    const room = this.room(roomId);
    room.history = room.history.map((i) =>
      i === target && i.kind === 'event' ? { ...i, ...patch(i) } : i,
    );
    this.publish(roomId);
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

  private threadSnapshot(
    accountId: string,
    roomId: string,
    rootId: string,
  ): TimelineUpdate {
    const room = this.rooms.get(roomId);
    if (!room?.members.has(accountId)) return { kind: 'room-unavailable' };
    const root = this.event(room, rootId);
    return {
      kind: 'items',
      diffs: [
        {
          op: 'reset',
          values: [...(root ? [root] : []), ...this.replies(room, rootId)],
        },
      ],
      backPagination: 'start-reached',
      room: this.roomState(accountId, room),
    };
  }

  private replies(room: FakeRoom, rootId: string): EventTimelineItem[] {
    return this.events(room).filter(
      (i) => room.threads.get(i.uniqueId) === rootId,
    );
  }

  private summaries(accountId: string, roomId: string): ThreadSummaryInfo[] {
    const room = this.rooms.get(roomId);
    if (!room?.members.has(accountId)) return [];
    const preview = (item: EventTimelineItem) =>
      item.content.kind === 'message' ? item.content.body : '…';
    return [...new Set(room.threads.values())].map((rootId) => {
      const root = this.event(room, rootId);
      const replies = this.replies(room, rootId);
      const latest = replies.at(-1);
      const participants = [
        ...new Set([
          ...(root ? [root.sender] : []),
          ...replies.map((r) => r.sender),
        ]),
      ].slice(0, MAX_PARTICIPANTS);
      return {
        rootEventId: rootId,
        replyCount: replies.length,
        latestActivityTs: latest?.timestamp ?? root?.timestamp ?? 0,
        root: root
          ? {
              sender: root.sender,
              preview: preview(root),
              unencryptedMark: null,
            }
          : null,
        latestReply: latest
          ? {
              sender: latest.sender,
              preview: preview(latest),
              ts: latest.timestamp,
              unencryptedMark: null,
            }
          : null,
        participants,
        profiles: Object.fromEntries(
          participants.map((userId) => [userId, this.profile(userId)]),
        ),
        unreadCount: 0,
        highlight: false,
      };
    });
  }

  private roomState(accountId: string, room: FakeRoom): TimelineRoomState {
    const all = this.events(room).filter((i) => i.eventId !== null);
    const loaded = this.visible(accountId, room).filter(
      (i): i is EventTimelineItem => i.kind === 'event' && i.eventId !== null,
    );
    return {
      encryption: 'unencrypted',
      hasEncryptionStateEvent: false,
      tombstone: null,
      latestConfirmedEventId: all.at(-1)?.eventId ?? null,
      oldestEventId: loaded[0]?.eventId ?? null,
      ...room.overrides,
    };
  }

  private visible(accountId: string, room: FakeRoom): readonly TimelineItem[] {
    const loaded = room.loaded.get(accountId) ?? 0;
    const shown = room.history
      .slice(room.history.length - loaded)
      .filter((item) => !room.threads.has(item.uniqueId));
    return shown.map((item) => {
      const votes =
        item.kind === 'event' && item.content.kind === 'poll'
          ? room.votes.get(item.content.poll.id)
          : undefined;
      // Tallied per viewer: `chosen` is the viewing account's own vote.
      return votes && item.kind === 'event' && item.content.kind === 'poll'
        ? {
            ...item,
            content: {
              kind: 'poll' as const,
              poll: this.tally(item.content.poll, votes, accountId),
            },
          }
        : item;
    });
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
        votes: new Map(),
        threads: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private profile(userId: string): Profile {
    return profileOf(this.userNames.get(userId) ?? userId);
  }
}
