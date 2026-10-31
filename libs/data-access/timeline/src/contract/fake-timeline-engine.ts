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
  escapeHtml,
  linkedUserIds,
  plainEqual,
  stripReplyFallbackHtml,
  stripReplyFallbackText,
  voiceMessageContent,
} from '@trinity/util/matrix';
import type { PollView } from '@trinity/util/matrix';
import type {
  EventTimelineItem,
  InReplyTo,
  OutgoingMessage,
  OutgoingText,
  Profile,
  ReactionDetailGroup,
  RetentionHint,
  ThreadSummaryInfo,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  SystemChange,
  TimelineItemContent,
  TimelineItemKey,
  TimelineRoomState,
  TimelineUpdate,
  VoiceClip,
} from '../lib/timeline-engine';

type FailNextCode = Exclude<
  EngineFailureCode,
  'discovery-failed' | 'account-start-failed' | 'recovery-refused'
>;

interface FakeRoom {
  readonly members: Set<string>;
  /** The whole history, oldest first, as every member sees it. */
  history: readonly TimelineItem[];
  overrides: Partial<TimelineRoomState>;
  /** Whether alice's writes are refused, as a server refuses a sender below the required level. */
  refusing: boolean;
  /** How many of the newest history items each member has loaded. */
  readonly loaded: Map<string, number>;
  readonly startReached: Set<string>;
  readonly fullyRead: Map<string, string>;
  /** Public `m.read` receipts by user. */
  readonly readReceipts: Map<string, string>;
  readonly invited: Set<string>;
  /** Poll responses and ends in arrival order: the poll views are derived from them. */
  readonly pollEvents: PollEvent[];
  /** Explicit power levels by user; bob, the room's creator, holds 100 unless set. */
  readonly powerUsers: Map<string, number>;
  /** The level that lets a member end another member's poll. */
  redactLevel: number;
  /** The thread root of each thread reply, by the reply's `uniqueId`. */
  readonly threads: Map<string, string>;
  /** The newest event each member has read in a thread, by `member` and root. */
  readonly threadReads: Map<string, string>;
  /** Events as a server holds them, by event id: what `eventSource` and `relations` read. */
  readonly wire: Map<string, WireEvent>;
  name: string | null;
}

interface PollEvent {
  readonly pollId: string;
  readonly kind: 'response' | 'end';
  readonly sender: string;
  readonly answers: readonly string[];
  readonly ts: number;
}

const POLL_START = 'org.matrix.msc3381.poll.start';
const POLL_RESPONSE = 'org.matrix.msc3381.poll.response';
const POLL_END = 'org.matrix.msc3381.poll.end';
const POLL_TEXT = 'org.matrix.msc1767.text';

interface WireEvent {
  readonly type: string;
  readonly sender: string;
  readonly content: Readonly<Record<string, unknown>>;
}

function failure(code: FailNextCode): EngineFailure {
  // Cast: assigning a union-typed code is checked only up to 25 union members.
  return {
    kind: 'unexpected',
    code,
    diagnostic: { kind: 'unexpected' },
  } as EngineFailure;
}

const MESSAGE_UNAVAILABLE = failure('message-unavailable');
const NOT_CANCELLABLE = failure('not-cancellable');
const REQUEST_FAILED = failure('request-failed');
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

const FAKE_READ_MARKER_ID = 'fake-read-marker';
const MEDIA_MSGTYPES: ReadonlySet<unknown> = new Set([
  'm.image',
  'm.file',
  'm.audio',
  'm.video',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function mentionsUser(
  content: Readonly<Record<string, unknown>> | undefined,
  userId: string,
): boolean {
  const ids = asRecord(content?.['m.mentions'])['user_ids'];
  return Array.isArray(ids) && ids.includes(userId);
}

function mentionsBlock(userIds: readonly string[], room: boolean) {
  const ids = [...new Set(userIds)].filter(Boolean);
  return {
    'm.mentions': {
      ...(ids.length > 0 ? { user_ids: ids } : {}),
      ...(room ? { room: true } : {}),
    },
  };
}

function textWire(message: OutgoingText): Record<string, unknown> {
  return {
    msgtype: `m.${message.msgtype}`,
    body: message.body,
    ...(message.formattedBody !== null
      ? {
          format: 'org.matrix.custom.html',
          formatted_body: message.formattedBody,
        }
      : {}),
    ...mentionsBlock(message.mentions.userIds, message.mentions.room),
  };
}

function editWire(
  eventId: string,
  message: OutgoingText,
): Record<string, unknown> {
  return {
    msgtype: `m.${message.msgtype}`,
    body: `* ${message.body}`,
    ...mentionsBlock(message.mentions.userIds, message.mentions.room),
    ...(message.formattedBody !== null
      ? {
          format: 'org.matrix.custom.html',
          formatted_body: `* ${message.formattedBody}`,
        }
      : {}),
    'm.new_content': textWire(message),
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  };
}

/** A text send as the wire carries it: a reply quotes `target`, a thread layers its relation. */
function sendWire(
  message: OutgoingText,
  reply: string | null,
  quote: WireTarget | null,
  threadRootId: string | null,
): Record<string, unknown> {
  const html =
    message.formattedBody ??
    escapeHtml(message.body).replace(/\r\n?|\n/g, '<br>');
  const firstLine = stripReplyFallbackText(quote?.body ?? '').split('\n')[0];
  const base = reply
    ? {
        msgtype: `m.${message.msgtype}`,
        body: quote
          ? `> <${quote.sender}> ${firstLine}\n\n${message.body}`
          : message.body,
        format: 'org.matrix.custom.html',
        formatted_body: `${
          quote
            ? `<mx-reply><blockquote>${escapeHtml(firstLine)}</blockquote></mx-reply>`
            : ''
        }${html}`,
        ...mentionsBlock(
          [quote?.sender ?? '', ...message.mentions.userIds],
          message.mentions.room,
        ),
      }
    : textWire(message);
  const relation = {
    ...(reply ? { 'm.in_reply_to': { event_id: reply } } : {}),
    ...(threadRootId
      ? {
          rel_type: 'm.thread',
          event_id: threadRootId,
          is_falling_back: !reply,
          'm.in_reply_to': { event_id: reply ?? threadRootId },
        }
      : {}),
  };
  return Object.keys(relation).length > 0
    ? { ...base, 'm.relates_to': relation }
    : base;
}

interface WireTarget {
  readonly sender: string;
  readonly body: string;
}

/** A forward is the forwarder's own message: no relation, no mentions, no reply quote. */
function forwardedWire(
  content: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of ['msgtype', 'body', 'format', 'formatted_body'])
    if (Object.hasOwn(content, key)) kept[key] = content[key];
  const relation = asRecord(content['m.relates_to']);
  if ('m.in_reply_to' in relation && relation['is_falling_back'] !== true) {
    if (typeof kept['body'] === 'string')
      kept['body'] = stripReplyFallbackText(kept['body']);
    if (typeof kept['formatted_body'] === 'string')
      kept['formatted_body'] = stripReplyFallbackHtml(kept['formatted_body']);
  }
  return { ...kept, 'm.mentions': {} };
}

/** A poll start as matrix-js-sdk reads it: one option per answer, `max_selections` cut to a whole number in range. */
function pollFromWire(
  content: Readonly<Record<string, unknown>>,
): TimelineItemContent {
  const start = asRecord(content[POLL_START]);
  const answers = Array.isArray(start['answers']) ? start['answers'] : [];
  const max = start['max_selections'];
  return {
    kind: 'poll',
    poll: {
      id: '',
      question: String(asRecord(start['question'])[POLL_TEXT] ?? ''),
      options: answers.map((answer) => ({
        id: String(asRecord(answer)['id'] ?? ''),
        text: String(asRecord(answer)[POLL_TEXT] ?? ''),
        votes: 0,
        chosen: false,
      })),
      totalVotes: 0,
      maxSelections:
        Number.isInteger(max) && (max as number) > 0
          ? Math.min(max as number, Math.max(answers.length, 1))
          : 1,
      ended: false,
    },
  };
}

/** The item content an event of `type` shows, for `viewer`. */
function contentFromWire(
  type: string,
  content: Readonly<Record<string, unknown>>,
  viewer: string,
): TimelineItemContent {
  const body = typeof content['body'] === 'string' ? content['body'] : '';
  const info = asRecord(content['info']);
  const mxc = typeof content['url'] === 'string' ? content['url'] : null;
  const relation = asRecord(content['m.relates_to']);
  const replyFallback =
    'm.in_reply_to' in relation && relation['is_falling_back'] !== true;
  const mentionsMe = mentionsUser(content, viewer);
  const mimeType =
    typeof info['mimetype'] === 'string' ? info['mimetype'] : 'image/png';
  const source = (
    kind: 'image' | 'file' | 'audio' | 'video',
    filename: string,
  ) => ({
    kind,
    mxc,
    file: null,
    filename,
    mimeType,
    thumbnailMxc: null,
    thumbnailFile: null,
    ...(typeof info['size'] === 'number' && { size: info['size'] }),
    ...(typeof info['w'] === 'number' && { width: info['w'] }),
    ...(typeof info['h'] === 'number' && { height: info['h'] }),
  });
  if (type === POLL_START) return pollFromWire(content);
  if (type === 'm.sticker') {
    return {
      kind: 'sticker',
      source: source('image', body),
      body,
      url: mxc,
      info: asRecord(content['info']),
    };
  }
  const msgtype = String(content['msgtype']).replace('m.', '');
  if (MEDIA_MSGTYPES.has(content['msgtype'])) {
    const filename =
      typeof content['filename'] === 'string' ? content['filename'] : body;
    return {
      kind: 'media',
      msgtype: msgtype as 'image' | 'file' | 'video' | 'audio',
      source: source(msgtype as 'image' | 'file' | 'video' | 'audio', filename),
      body: filename,
      caption: filename !== body ? body : null,
      formattedCaption: null,
      replyFallback,
      mentionsMe,
      mentions: [],
    };
  }
  const formattedBody =
    content['format'] === 'org.matrix.custom.html' &&
    typeof content['formatted_body'] === 'string'
      ? content['formatted_body']
      : null;
  return {
    kind: 'message',
    msgtype: msgtype as 'text' | 'emote' | 'notice',
    body,
    formattedBody,
    replyFallback,
    mentionsMe,
    mentions: linkedUserIds(formattedBody),
  };
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
    createRoom: async (name: string): Promise<string> => {
      this.nextRoom += 1;
      const roomId = `!fake-${this.nextRoom}:${this.serverName}`;
      const room = this.room(roomId);
      room.members.add(this.bob);
      room.name = name;
      return roomId;
    },
    invite: async (roomId: string, userId: string): Promise<void> => {
      this.room(roomId).invited.add(userId);
      this.publish(roomId);
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
    // Writes are refused when `events_default` (or a per-type level) is above 0; `users` and
    // `redact` decide who may end another member's poll.
    setPowerLevels: async (
      roomId: string,
      patch: {
        readonly events_default?: number;
        readonly events?: Readonly<Record<string, number>>;
        readonly users?: Readonly<Record<string, number>>;
        readonly redact?: number;
      },
    ): Promise<void> => {
      const room = this.room(roomId);
      for (const [user, level] of Object.entries(patch.users ?? {}))
        room.powerUsers.set(user, level);
      if (patch.redact !== undefined) room.redactLevel = patch.redact;
      this.publish(roomId);
      const levels = [
        patch.events_default,
        ...Object.values(patch.events ?? {}),
      ];
      this.room(roomId).refusing = levels.some((level) => (level ?? 0) > 0);
    },
    sendEvent: async (
      roomId: string,
      type: string,
      content: object,
    ): Promise<string> => {
      const wire = content as Record<string, unknown>;
      const eventId = this.nextEventId();
      const room = this.room(roomId);
      room.wire.set(eventId, { type, sender: this.bob, content: wire });
      const relation = asRecord(wire['m.relates_to']);
      if (relation['rel_type'] === 'm.thread')
        room.threads.set(`ev:${eventId}`, String(relation['event_id']));
      const quoted = asRecord(relation['m.in_reply_to'])['event_id'];
      this.clock += 1;
      if (type === POLL_RESPONSE || type === POLL_END) {
        const answers = asRecord(wire[POLL_RESPONSE])['answers'];
        room.pollEvents.push({
          pollId: String(relation['event_id']),
          kind: type === POLL_END ? 'end' : 'response',
          sender: this.bob,
          answers: Array.isArray(answers) ? answers.map(String) : [],
          ts: this.clock,
        });
        this.publish(roomId);
        return eventId;
      }
      const shown = contentFromWire(type, wire, this.alice);
      this.append(
        roomId,
        fakeEventItem(eventId, this.bob, {
          timestamp: this.clock,
          content:
            shown.kind === 'poll'
              ? { kind: 'poll', poll: { ...shown.poll, id: eventId } }
              : shown,
          inReplyTo:
            typeof quoted === 'string' && relation['is_falling_back'] !== true
              ? this.inReplyTo(room, quoted)
              : null,
          profiles: { [this.bob]: this.profile(this.bob) },
        }),
      );
      return eventId;
    },
    sendState: async (
      roomId: string,
      type: string,
      stateKey: string,
      content: object,
    ): Promise<string> => {
      const room = this.room(roomId);
      const eventId = this.nextEventId();
      const wire = content as Record<string, unknown>;
      room.wire.set(eventId, { type, sender: this.bob, content: wire });
      const change = this.stateChange(room, type, stateKey, wire);
      if (change) {
        this.clock += 1;
        this.append(
          roomId,
          fakeEventItem(eventId, this.bob, {
            timestamp: this.clock,
            content: { kind: 'state', change },
            profiles: { [this.bob]: this.profile(this.bob) },
          }),
        );
      } else {
        this.publish(roomId);
      }
      return eventId;
    },
    markRead: async (roomId: string, eventId: string): Promise<void> => {
      this.room(roomId).readReceipts.set(this.bob, eventId);
      this.publish(roomId);
    },
    relations: async (
      roomId: string,
      eventId: string,
      relType: string,
    ): Promise<readonly string[]> =>
      [...this.room(roomId).wire]
        .filter(([, { content }]) => {
          const relation = asRecord(content['m.relates_to']);
          return (
            relation['rel_type'] === relType && relation['event_id'] === eventId
          );
        })
        .map(([id]) => id),
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
      (item) =>
        item.uniqueId !== START_ITEM.uniqueId &&
        item.uniqueId !== FAKE_READ_MARKER_ID,
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
      const wire = room.wire.get(eventId);
      if (wire && (item || wire.type === 'm.room.message')) {
        return engineOk({
          event_id: eventId,
          room_id: roomId,
          sender: wire.sender,
          origin_server_ts: item?.timestamp ?? 0,
          type: wire.type,
          content: wire.content,
        });
      }
      if (!item) return engineFail(MESSAGE_UNAVAILABLE);
      const { content } = item;
      const rootId = room.threads.get(item.uniqueId);
      return engineOk({
        event_id: eventId,
        room_id: roomId,
        sender: item.sender,
        origin_server_ts: item.timestamp,
        type: 'm.room.message',
        content: {
          ...(content.kind === 'message'
            ? { msgtype: `m.${content.msgtype}`, body: content.body }
            : {}),
          // As the SDK sends a thread reply, with its fallback for thread-unaware clients.
          ...(rootId
            ? {
                'm.relates_to': {
                  rel_type: 'm.thread',
                  event_id: rootId,
                  is_falling_back: true,
                  'm.in_reply_to': { event_id: rootId },
                },
              }
            : {}),
        },
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
      readonly threadRootId: string | null;
      readonly visibility: 'public' | 'private';
      readonly fullyRead: boolean;
    },
  ): Observable<EngineResult<null>> {
    return this.run(accountId, roomId, (room) => {
      if (!this.event(room, eventId)) return engineFail(MESSAGE_UNAVAILABLE);
      if (options.threadRootId) {
        room.threadReads.set(`${accountId}\n${options.threadRootId}`, eventId);
        this.publish(roomId);
      } else if (options.fullyRead) {
        room.fullyRead.set(accountId, eventId);
      }
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
        this.clock += 1;
        room.pollEvents.push({
          pollId: message.pollId,
          kind: message.kind === 'poll-end' ? 'end' : 'response',
          sender: accountId,
          answers: message.kind === 'poll-end' ? [] : message.answerIds,
          ts: this.clock,
        });
        this.publish(roomId);
        return engineOk({ transactionId, eventId });
      }
      if (options.threadRootId)
        room.threads.set(`txn:${transactionId}`, options.threadRootId);
      if (message.kind === 'text' && !room.refusing) {
        const target = options.replyTo
          ? this.event(room, options.replyTo)
          : undefined;
        room.wire.set(eventId, {
          type: 'm.room.message',
          sender: accountId,
          content: sendWire(
            message,
            options.replyTo,
            target?.content.kind === 'message'
              ? { sender: target.sender, body: target.content.body }
              : null,
            options.threadRootId,
          ),
        });
      }
      this.append(roomId, {
        ...this.own(accountId, eventId, this.contentOf(message, eventId)),
        ...(room.refusing && {
          eventId: null,
          sendState: { kind: 'failed', recoverable: false } as const,
        }),
        uniqueId: `txn:${transactionId}`,
        transactionId,
        inReplyTo:
          options.replyTo && message.kind === 'text'
            ? this.inReplyTo(room, options.replyTo)
            : null,
      });
      return engineOk({
        transactionId,
        eventId: room.refusing ? null : eventId,
      });
    });
  }

  edit(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    message: OutgoingText,
    _options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>> {
    return this.onItem(accountId, roomId, item, (found) => {
      if (found.eventId)
        this.room(roomId).wire.set(this.nextEventId(), {
          type: 'm.room.message',
          sender: accountId,
          content: editWire(found.eventId, message),
        });
      this.patchItem(roomId, found, () => ({
        content: outgoingContent(message),
        edited: true,
      }));
    });
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
      if (room.refusing) return engineFail(REQUEST_FAILED);
      this.patchItem(roomId, echo, () => ({
        eventId: this.nextEventId(),
        sendState: null,
      }));
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
      const forwardedId = this.nextEventId();
      const sourceContent =
        room.wire.get(eventId)?.content ??
        (source.content.kind === 'message'
          ? {
              msgtype: `m.${source.content.msgtype}`,
              body: source.content.body,
            }
          : {});
      this.room(targetRoomId).wire.set(forwardedId, {
        type: 'm.room.message',
        sender: accountId,
        content: forwardedWire(sourceContent),
      });
      this.append(
        targetRoomId,
        this.own(accountId, forwardedId, source.content),
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
      this.room(roomId).wire.set(eventId, {
        type: 'm.room.message',
        sender: accountId,
        content: voiceMessageContent(
          {
            mxc: `mxc://${this.serverName}/${eventId.slice(1)}`,
            file: null,
            mimeType: clip.mimeType,
            size: clip.blob.size,
          },
          clip.durationMs,
          [...clip.waveform],
        ),
      });
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

  /** Holds every event in memory, so it has nothing to free. */
  setRetention(
    _accountId: string,
    _roomId: string,
    _hint: RetentionHint | null,
  ): Observable<null> {
    return of(null);
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
      if (room.refusing) return engineFail(REQUEST_FAILED);
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

  /**
   * The poll as matrix-js-sdk tallies it: each voter's latest response cast before the earliest
   * valid end counts, a response naming an unknown answer or none withdraws the vote, and one
   * is de-duplicated and cut to `max_selections`. Only the poll's sender, or a member who may
   * redact, can end it.
   */
  private pollView(
    room: FakeRoom,
    start: EventTimelineItem,
    poll: PollView,
    viewer: string,
  ): PollView {
    const events = room.pollEvents.filter((e) => e.pollId === poll.id);
    const endTs = Math.min(
      Number.POSITIVE_INFINITY,
      ...events
        .filter(
          (e) =>
            e.kind === 'end' &&
            (e.sender === start.sender ||
              this.powerOf(room, e.sender) >= room.redactLevel),
        )
        .map((e) => e.ts),
    );
    const latest = new Map<string, readonly string[]>();
    for (const e of events)
      if (e.kind === 'response' && e.ts <= endTs)
        latest.set(e.sender, e.answers);
    const known = new Set(poll.options.map((option) => option.id));
    const chosenBy = new Map<string, ReadonlySet<string>>();
    for (const [voter, answers] of latest)
      if (answers.length > 0 && answers.every((id) => known.has(id)))
        chosenBy.set(
          voter,
          new Set([...new Set(answers)].slice(0, poll.maxSelections)),
        );
    return {
      ...poll,
      ended: endTs !== Number.POSITIVE_INFINITY,
      totalVotes: chosenBy.size,
      options: poll.options.map((option) => ({
        ...option,
        votes: [...chosenBy.values()].filter((c) => c.has(option.id)).length,
        chosen: chosenBy.get(viewer)?.has(option.id) ?? false,
      })),
    };
  }

  private powerOf(room: FakeRoom, userId: string): number {
    return room.powerUsers.get(userId) ?? (userId === this.bob ? 100 : 0);
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
    if (!room?.members.has(accountId) && !room?.invited.has(accountId))
      return { kind: 'room-unavailable' };
    const startReached = room.startReached.has(accountId);
    const items = this.withReadMarker(
      accountId,
      room,
      this.visible(accountId, room),
    );
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
    const items = [...(root ? [root] : []), ...this.replies(room, rootId)];
    const confirmed = items.filter((i) => i.eventId !== null);
    return {
      kind: 'items',
      diffs: [{ op: 'reset', values: items }],
      backPagination: 'start-reached',
      // What a thread receipt acknowledges: the thread's own newest event.
      room: {
        ...this.roomState(accountId, room),
        latestConfirmedEventId: confirmed.at(-1)?.eventId ?? null,
        oldestEventId: confirmed[0]?.eventId ?? null,
      },
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
      const readUpTo = room.threadReads.get(`${accountId}\n${rootId}`);
      const unread = replies
        .slice(replies.findIndex((r) => r.eventId === readUpTo) + 1)
        .filter((r) => r.sender !== accountId);
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
        unreadCount: unread.length,
        highlight: unread.some((r) =>
          mentionsUser(room.wire.get(r.eventId ?? '')?.content, accountId),
        ),
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
    return shown.map((shownItem) => {
      const item = this.withReaders(accountId, room, shownItem);
      // Tallied per viewer: `chosen` is the viewing account's own vote.
      return item.kind === 'event' && item.content.kind === 'poll'
        ? {
            ...item,
            content: {
              kind: 'poll' as const,
              poll: this.pollView(room, item, item.content.poll, accountId),
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
    const room = this.room(roomId);
    for (const accountId of new Set([...room.members, ...room.invited]))
      this.emit(accountId, roomId, this.snapshot(accountId, roomId));
  }

  private inReplyTo(room: FakeRoom, eventId: string): InReplyTo {
    const target = this.event(room, eventId);
    return {
      eventId,
      details: target
        ? {
            kind: 'ready',
            sender: target.sender,
            body: target.content.kind === 'message' ? target.content.body : '',
            redacted: target.content.kind === 'redacted',
            unencryptedMark: null,
          }
        : { kind: 'unavailable' },
    };
  }

  /** The state item bob's `type` event makes, applying the room state it sets. */
  private stateChange(
    room: FakeRoom,
    type: string,
    stateKey: string,
    content: Readonly<Record<string, unknown>>,
  ): SystemChange | null {
    const actorId = this.bob;
    switch (type) {
      case 'm.room.name': {
        const name =
          typeof content['name'] === 'string' ? content['name'] : null;
        const change: SystemChange = {
          kind: 'room-name',
          actorId,
          previousName: room.name,
          name,
        };
        room.name = name;
        return change;
      }
      case 'm.room.member':
        return {
          kind: 'membership',
          actorId,
          membership: String(content['membership']),
          previousMembership: 'join',
          actorIsTarget: stateKey === actorId,
          targetId: stateKey,
          previousDisplayName: null,
          displayName: null,
          avatarChanged: false,
          reason: null,
        };
      case 'm.room.encryption':
        room.overrides = {
          ...room.overrides,
          encryption: 'encrypted',
          hasEncryptionStateEvent: true,
        };
        return null;
      case 'm.room.tombstone':
        room.overrides = {
          ...room.overrides,
          tombstone: {
            replacementRoomId: String(content['replacement_room']),
            body: String(content['body'] ?? ''),
          },
        };
        return null;
      default:
        throw new Error(`The fake does not model ${type} state`);
    }
  }

  /** `item` with the other members whose public receipt sits on it. */
  private withReaders(
    accountId: string,
    room: FakeRoom,
    item: TimelineItem,
  ): TimelineItem {
    if (item.kind !== 'event' || item.eventId === null) return item;
    const readBy = [...room.readReceipts]
      .filter(
        ([user, id]) =>
          id === item.eventId && user !== accountId && user !== item.sender,
      )
      .map(([user]) => user);
    return readBy.length === 0
      ? item
      : {
          ...item,
          readBy,
          profiles: {
            ...item.profiles,
            ...Object.fromEntries(
              readBy.map((user) => [user, this.profile(user)]),
            ),
          },
        };
  }

  /** The marker goes before the first event of someone else after the fully-read one. */
  private withReadMarker(
    accountId: string,
    room: FakeRoom,
    items: readonly TimelineItem[],
  ): readonly TimelineItem[] {
    const readId = room.fullyRead.get(accountId);
    const read = items.findIndex(
      (item) => item.kind === 'event' && item.eventId === readId,
    );
    const next = items.findIndex(
      (item, index) =>
        index > read &&
        item.kind === 'event' &&
        item.sender !== accountId &&
        item.content.kind !== 'state',
    );
    return read < 0 || next < 0
      ? items
      : [
          ...items.slice(0, next),
          { kind: 'readMarker', uniqueId: FAKE_READ_MARKER_ID },
          ...items.slice(next),
        ];
  }

  private room(roomId: string): FakeRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        members: new Set(),
        history: [],
        overrides: {},
        refusing: false,
        loaded: new Map(),
        startReached: new Set(),
        fullyRead: new Map(),
        readReceipts: new Map(),
        invited: new Set(),
        pollEvents: [],
        powerUsers: new Map(),
        redactLevel: 50,
        threads: new Map(),
        threadReads: new Map(),
        wire: new Map(),
        name: null,
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private profile(userId: string): Profile {
    return profileOf(this.userNames.get(userId) ?? userId);
  }
}
