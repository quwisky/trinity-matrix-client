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
  engineOk,
} from '@trinity/util/matrix';
import type {
  ConversationContentEngine,
  LinkPreview,
  PinnedEntry,
  PinnedEvents,
  Revision,
  SearchHit,
} from '../lib/conversation-content-engine';
import type { Profile } from '../lib/timeline-engine';

type FailNextCode = Exclude<
  EngineFailureCode,
  'discovery-failed' | 'account-start-failed' | 'recovery-refused'
>;

interface FakeEvent {
  readonly eventId: string;
  readonly sender: string;
  readonly body: string;
  readonly ts: number;
  /** The event an `m.replace` edit replaces. */
  readonly replaces: string | null;
  redacted: boolean;
}

interface FakeRoom {
  readonly encrypted: boolean;
  readonly members: Set<string>;
  readonly invited: Set<string>;
  /** Oldest first. */
  readonly events: FakeEvent[];
  pinned: readonly unknown[];
}

const MAX_PINS = 100;
const NO_PINS: PinnedEvents = { eventIds: [], allEventIds: [], entries: [] };

function failure(code: FailNextCode): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function profilesOf(userId: string): Record<string, Profile> {
  return {
    [userId]: {
      displayName: userId.slice(1, userId.indexOf(':')),
      displayNameAmbiguous: false,
      avatarMxc: null,
    },
  };
}

/**
 * In-memory conversation content for `alice` (live) and `bob` (driven through `asBob`).
 * Emits synchronously; nothing is ever fetched, so every pin is loaded or unavailable.
 */
export class FakeConversationContentEngine implements ConversationContentEngine {
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly changes$ = new Subject<string>();
  private nextRoom = 0;
  private nextEvent = 0;
  private clock = 1_700_000_000_000;
  private nextFailure: FailNextCode | null = null;

  readonly serverName = 'example.org';
  readonly alice = `@alice:${this.serverName}`;
  readonly bob = `@bob:${this.serverName}`;
  readonly previewableUrl = `https://${this.serverName}/`;
  /** The preview each URL answers with; any other URL answers `null`. */
  readonly previews = new Map<string, LinkPreview>([
    [
      this.previewableUrl,
      { title: 'Example', description: null, imageMxc: null },
    ],
  ]);
  /** Link previews requested from the "homeserver". */
  previewRequests = 0;

  readonly asAlice = {
    join: async (roomId: string): Promise<void> => {
      const room = this.room(roomId);
      if (!room.invited.has(this.alice))
        throw new Error(`${this.alice} is not invited to ${roomId}`);
      room.members.add(this.alice);
      this.changes$.next(roomId);
    },
    send: async (roomId: string, body: string): Promise<string> =>
      this.send(this.alice, roomId, body, null),
    edit: async (roomId: string, eventId: string, body: string) =>
      this.send(this.alice, roomId, body, eventId),
  };

  /** Acts on the fake's rooms as `bob` would on a server. */
  readonly asBob = {
    createRoom: async (
      _name: string,
      options: { readonly encrypted?: boolean } = {},
    ): Promise<string> => {
      const roomId = `!fake-${++this.nextRoom}:${this.serverName}`;
      this.rooms.set(roomId, {
        encrypted: options.encrypted === true,
        members: new Set([this.bob]),
        invited: new Set(),
        events: [],
        pinned: [],
      });
      return roomId;
    },
    invite: async (roomId: string, userId: string): Promise<void> => {
      this.room(roomId).invited.add(userId);
    },
    // The fake checks no power levels.
    promote: async (): Promise<void> => undefined,
    send: async (roomId: string, body: string): Promise<string> =>
      this.send(this.bob, roomId, body, null),
    edit: async (roomId: string, eventId: string, body: string) =>
      this.send(this.bob, roomId, body, eventId),
    setPinned: async (roomId: string, eventIds: readonly string[]) =>
      this.setPinned(roomId, [...eventIds]),
  };

  /** Fails the next command with `code`. */
  failNext(code: FailNextCode): void {
    this.nextFailure = code;
  }

  /** Replaces a room's raw pinned list, non-string entries included. */
  setPinned(roomId: string, pinned: readonly unknown[]): void {
    this.room(roomId).pinned = pinned;
    this.changes$.next(roomId);
  }

  /** The room's raw pinned list, as a write left it. */
  pinnedList(roomId: string): readonly unknown[] {
    return this.room(roomId).pinned;
  }

  pinnedEvents(accountId: string, roomId: string): Observable<PinnedEvents> {
    return this.changes$.pipe(
      filter((changed) => changed === roomId),
      startWith(roomId),
      map(() => this.pinsOf(accountId, roomId)),
    );
  }

  pin(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (room) => {
      if (!room.pinned.includes(eventId)) {
        this.setPinned(roomId, [...room.pinned, eventId]);
      }
      return null;
    });
  }

  unpin(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (room) => {
      if (room.pinned.includes(eventId)) {
        this.setPinned(
          roomId,
          room.pinned.filter((id) => id !== eventId),
        );
      }
      return null;
    });
  }

  /** Nothing is ever fetched, so no pin has failed. */
  retryFailedPins(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, () => null);
  }

  searchMessages(
    accountId: string,
    roomId: string,
    term: string,
    _nextBatch: string | null,
  ): Observable<
    EngineResult<
      | {
          readonly hits: readonly SearchHit[];
          readonly count: number;
          readonly nextBatch: string | null;
        }
      | { readonly encrypted: true }
    >
  > {
    return this.command(accountId, roomId, (room) => {
      if (room.encrypted) return { encrypted: true as const };
      const needle = term.trim().toLowerCase();
      const hits = needle
        ? room.events
            .filter(
              (e) =>
                !e.replaces &&
                !e.redacted &&
                e.body.toLowerCase().includes(needle),
            )
            .reverse()
            .map(({ eventId, sender, body, ts }) => ({
              eventId,
              sender,
              body,
              ts,
              profiles: profilesOf(sender),
            }))
        : [];
      return { hits, count: hits.length, nextBatch: null };
    });
  }

  editHistory(
    accountId: string,
    roomId: string,
    eventId: string,
    _options: { readonly maxPages: number },
  ): Observable<
    EngineResult<{
      readonly revisions: readonly Revision[];
      readonly truncated: boolean;
    }>
  > {
    return this.command(accountId, roomId, (room) => {
      const original = room.events.find((e) => e.eventId === eventId);
      if (!original) return failure('message-unavailable');
      if (original.redacted) return { revisions: [], truncated: false };
      const edits = room.events.filter(
        (e) => e.replaces === eventId && !e.redacted,
      );
      return {
        revisions: [original, ...edits].map((e) => ({
          eventId: e.eventId,
          sender: e.sender,
          ts: e.ts,
          kind: 'text' as const,
          body: e.body,
          html: null,
          shield: null,
          unencryptedMark: null,
          profiles: profilesOf(e.sender),
        })),
        truncated: false,
      };
    });
  }

  removeRevision(
    accountId: string,
    roomId: string,
    revisionEventId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (room) => {
      const event = room.events.find((e) => e.eventId === revisionEventId);
      if (!event) return failure('message-unavailable');
      event.redacted = true;
      this.changes$.next(roomId);
      return null;
    });
  }

  linkPreview(
    accountId: string,
    url: string,
    options: { readonly onlyIfUnencrypted: string | null },
  ): Observable<EngineResult<LinkPreview | null>> {
    return defer(() => {
      const failed = this.takeFailure(accountId);
      if (failed) return of(engineFail(failed));
      if (options.onlyIfUnencrypted !== null) {
        const room = this.rooms.get(options.onlyIfUnencrypted);
        if (!room || room.encrypted || !room.members.has(accountId)) {
          return of(engineOk(null));
        }
      }
      this.previewRequests++;
      return of(engineOk(this.previews.get(url) ?? null));
    });
  }

  private pinsOf(accountId: string, roomId: string): PinnedEvents {
    const room = this.rooms.get(roomId);
    if (accountId !== this.alice || !room?.members.has(accountId)) {
      return NO_PINS;
    }
    const allEventIds = room.pinned.filter(
      (id): id is string => typeof id === 'string',
    );
    const eventIds = allEventIds.slice(-MAX_PINS);
    const entries: PinnedEntry[] = [];
    for (const eventId of eventIds) {
      const event = room.events.find((e) => e.eventId === eventId);
      if (event?.redacted) continue;
      entries.push(
        event
          ? {
              eventId,
              status: 'loaded',
              sender: event.sender,
              body: event.body,
              ts: event.ts,
              shield: null,
              unencryptedMark: null,
              profiles: profilesOf(event.sender),
            }
          : {
              eventId,
              status: 'unavailable',
              sender: '',
              body: '',
              ts: 0,
              shield: null,
              unencryptedMark: null,
              profiles: {},
            },
      );
    }
    return { eventIds, allEventIds, entries };
  }

  private send(
    sender: string,
    roomId: string,
    body: string,
    replaces: string | null,
  ): string {
    const room = this.room(roomId);
    if (!room.members.has(sender))
      throw new Error(`${sender} is not in ${roomId}`);
    const eventId = `$fake-${++this.nextEvent}`;
    room.events.push({
      eventId,
      sender,
      body,
      ts: (this.clock += 1_000),
      replaces,
      redacted: false,
    });
    this.changes$.next(roomId);
    return eventId;
  }

  private room(roomId: string): FakeRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`No room ${roomId}`);
    return room;
  }

  private takeFailure(accountId: string): EngineFailure | null {
    if (accountId !== this.alice) return failure('account-not-live');
    const code = this.nextFailure;
    this.nextFailure = null;
    return code ? failure(code) : null;
  }

  /** A cold command for alice in a room she has joined; `run` may answer a failure. */
  private command<T>(
    accountId: string,
    roomId: string,
    run: (room: FakeRoom) => T | EngineFailure,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const failed = this.takeFailure(accountId);
      if (failed) return of(engineFail(failed));
      const room = this.rooms.get(roomId);
      if (!room?.members.has(accountId)) {
        return of(engineFail(failure('message-unavailable')));
      }
      const value = run(room);
      return of(isFailure(value) ? engineFail(value) : engineOk(value as T));
    });
  }
}

function isFailure(value: unknown): value is EngineFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'diagnostic' in value &&
    'code' in value
  );
}
