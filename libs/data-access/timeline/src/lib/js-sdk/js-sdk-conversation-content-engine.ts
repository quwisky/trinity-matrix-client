import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  Direction,
  EventType,
  MatrixEventEvent,
  RelationType,
  RoomEvent,
  RoomStateEvent,
  SearchOrderBy,
  SyncState,
  type ISearchRequestBody,
  type ISearchResponse,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  defer,
  from,
  map,
  of,
  switchMap,
  tap,
  type Subscriber,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  RoomEncryptionFlags,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  isRoomEncrypted,
  linkedUserIds,
  liveRoomState,
  messagePreview,
  unencryptedMarkFor,
  validReplacement,
  type EngineFailure,
  type EngineResult,
} from '@trinity/util/matrix';
import type {
  ConversationContentEngine,
  LinkPreview,
  PinnedEntry,
  PinnedEvents,
  Revision,
  SearchHit,
} from '../conversation-content-engine';
import type { Profile } from '../timeline-engine';
import { editRevisionSources } from './edit-revisions';
import { profileOf } from './timeline-item';

type PinFetch =
  | { readonly kind: 'loaded'; readonly event: MatrixEvent }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly at: number };

/** Minimum gap before a Timeline or Decrypted event retries a failed pin again. */
const AUTO_RETRY_MS = 30_000;
/** Pins read from room state; earlier ids are ignored so one event cannot fan out unbounded fetches. */
const MAX_PINS = 100;
const MAX_CONCURRENT_PIN_FETCHES = 4;
/** Edits per relations request; the endpoint's own cap is higher, this keeps a page small. */
const EDIT_PAGE_SIZE = 50;
/** 500 revisions of one message is already pathological. */
const MAX_EDIT_PAGES = 10;
/** How long a pin write waits for `/sync` to apply it before replying anyway. */
const SETTLE_TIMEOUT_MS = 15_000;

const NO_PINS: PinnedEvents = { eventIds: [], entries: [] };

function localFailure(
  code: 'account-not-live' | 'message-unavailable',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function failureFrom(
  code: 'request-failed' | 'unsupported',
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

/** The room's `pinned` list exactly as stored, non-string entries included. */
function rawPinned(room: Room): readonly unknown[] {
  const raw = liveRoomState(room)
    ?.getStateEvents(EventType.RoomPinnedEvents, '')
    ?.getContent<{ pinned?: unknown }>().pinned;
  return Array.isArray(raw) ? raw : [];
}

function profilesOf(
  room: Room | null,
  userIds: Iterable<string>,
): Record<string, Profile> {
  const profiles: Record<string, Profile> = {};
  for (const userId of userIds) {
    if (!userId || userId in profiles) continue;
    const profile = profileOf(userId, room?.getMember(userId));
    if (profile) profiles[userId] = profile;
  }
  return profiles;
}

function placeholder(
  eventId: string,
  status: 'loading' | 'unavailable' | 'failed',
): PinnedEntry {
  return {
    eventId,
    status,
    sender: '',
    body: '',
    ts: 0,
    shield: null,
    unencryptedMark: null,
    profiles: {},
  };
}

function searchBody(roomId: string, term: string): ISearchRequestBody {
  return {
    search_categories: {
      room_events: {
        search_term: term,
        keys: ['content.body'],
        filter: { rooms: [roomId] },
        order_by: SearchOrderBy.Recent,
        event_context: {
          before_limit: 0,
          after_limit: 0,
          include_profile: true,
        },
      },
    },
  };
}

function searchPage(response: ISearchResponse): {
  readonly hits: readonly SearchHit[];
  readonly count: number;
  readonly nextBatch: string | null;
} {
  const category = response.search_categories.room_events;
  const hits = (category.results ?? []).map<SearchHit>((entry) => {
    const event = entry.result;
    const sender = event.sender;
    const profile = entry.context?.profile_info?.[sender];
    const raw = event.content['body'];
    return {
      eventId: event.event_id,
      sender,
      body: typeof raw === 'string' ? raw : '',
      ts: event.origin_server_ts,
      profiles: profile
        ? {
            [sender]: {
              displayName: profile.displayname ?? null,
              displayNameAmbiguous: false,
              avatarMxc: profile.avatar_url ?? null,
            },
          }
        : {},
    };
  });
  return {
    hits,
    count: category.count ?? hits.length,
    nextBatch: category.next_batch ?? null,
  };
}

function str(value: string | number | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** The Open Graph fields the preview card shows, or null when there are none. */
function toPreview(
  res: Record<string, string | number | undefined>,
): LinkPreview | null {
  const title = str(res['og:title']);
  const description = str(res['og:description']);
  const imageMxc = str(res['og:image']);
  return title || description || imageMxc
    ? { title, description, imageMxc }
    : null;
}

/**
 * Whether the homeserver has no URL-preview endpoint (disabled or unrecognised): Synapse
 * answers `M_UNRECOGNIZED`, or a bare 404, when `url_preview_enabled` is off.
 */
function isPreviewEndpointUnavailable(error: unknown): boolean {
  const matrixError = error as {
    errcode?: unknown;
    httpStatus?: unknown;
  } | null;
  return (
    matrixError?.errcode === 'M_UNRECOGNIZED' || matrixError?.httpStatus === 404
  );
}

/**
 * Points the room's own copy of the message at the newest surviving edit.
 *
 * Redacting an edit leaves matrix-js-sdk's in-memory aggregation wrong: it re-resolves the
 * message against a timestamp from the ORIGINAL event's bundle, which the redaction never
 * refreshes, so the message falls back to its first wording and stops counting as edited.
 * `makeReplaced` is what the SDK's own relation handling calls, and it emits
 * `MatrixEventEvent.Replaced`, which the timeline listens for.
 */
function repairAggregation(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  edits: readonly MatrixEvent[],
): void {
  const target = client.getRoom(roomId)?.findEventById(eventId);
  if (!target) return; // not in a loaded timeline: nothing on screen to correct
  const newest = edits
    .filter(
      (edit) =>
        !edit.isRedacted() &&
        edit.status === null &&
        validReplacement(target, edit) !== undefined,
    )
    .reduce<MatrixEvent | null>(
      (latest, edit) =>
        !latest || edit.getTs() > latest.getTs() ? edit : latest,
      null,
    );
  if (
    (target.replacingEvent()?.getId() ?? null) === (newest?.getId() ?? null)
  ) {
    return; // already correct; don't emit a pointless re-render
  }
  target.makeReplaced(newest ?? undefined);
}

/**
 * Emits once and completes when the room's live state holds the pinned-events state event
 * `eventId`, sync stops, or {@link SETTLE_TIMEOUT_MS} passes.
 */
function pinsApplied(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    const finish = (): void => {
      subscriber.next();
      subscriber.complete();
    };
    const check = (): void => {
      const room = client.getRoom(roomId);
      const id = room
        ? liveRoomState(room)
            ?.getStateEvents(EventType.RoomPinnedEvents, '')
            ?.getId()
        : undefined;
      if (id === eventId) finish();
    };
    const onSync = (state: SyncState): void => {
      if (state === SyncState.Stopped) finish();
    };
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
    client.on(RoomStateEvent.Events, check);
    client.on(ClientEvent.Sync, onSync);
    check();
    return () => {
      clearTimeout(timer);
      client.off(RoomStateEvent.Events, check);
      client.off(ClientEvent.Sync, onSync);
    };
  });
}

/** An open `pinnedEvents` subscription, which pin writes bring up to date before replying. */
interface PinsFeed {
  readonly client: MatrixClient;
  readonly roomId: string;
  /** Re-reads the list and emits now, dropping a queued emission. */
  flush(): void;
}

/** {@link ConversationContentEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkConversationContentEngine implements ConversationContentEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  private readonly pinFeeds = new Set<PinsFeed>();

  pinnedEvents(accountId: string, roomId: string): Observable<PinnedEvents> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(NO_PINS), NEVER);
      return new Observable<PinnedEvents>((subscriber) => {
        let detach: (() => void) | null = null;
        const onRoom = (room: Room): void => {
          if (room.roomId !== roomId || detach) return;
          client.off(ClientEvent.Room, onRoom);
          detach = this.attachPins(client, room, subscriber);
        };
        const room = client.getRoom(roomId);
        if (room) {
          detach = this.attachPins(client, room, subscriber);
        } else {
          subscriber.next(NO_PINS);
          client.on(ClientEvent.Room, onRoom);
        }
        return () => {
          client.off(ClientEvent.Room, onRoom);
          detach?.();
        };
      });
    });
  }

  pin(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>> {
    return this.writePins(accountId, roomId, (pinned) =>
      pinned.includes(eventId) ? null : [...pinned, eventId],
    );
  }

  unpin(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>> {
    return this.writePins(accountId, roomId, (pinned) =>
      pinned.includes(eventId) ? pinned.filter((id) => id !== eventId) : null,
    );
  }

  searchMessages(
    accountId: string,
    roomId: string,
    term: string,
    nextBatch: string | null,
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
    return this.command<
      ReturnType<typeof searchPage> | { readonly encrypted: true }
    >(accountId, async (client) => {
      const room = client.getRoom(roomId);
      if (!room) return engineFail(localFailure('message-unavailable'));
      const trimmed = term.trim();
      if (!trimmed) return engineOk({ hits: [], count: 0, nextBatch: null });
      if (await isRoomEncrypted(room, client.getCrypto?.())) {
        return engineOk({ encrypted: true as const });
      }
      const body = searchBody(roomId, trimmed);
      const response = await client.search(
        nextBatch ? { body, next_batch: nextBatch } : { body },
      );
      return engineOk(searchPage(response));
    });
  }

  editHistory(
    accountId: string,
    roomId: string,
    eventId: string,
    options: { readonly maxPages: number },
  ): Observable<
    EngineResult<{
      readonly revisions: readonly Revision[];
      readonly truncated: boolean;
    }>
  > {
    return this.command(accountId, async (client) => {
      const maxPages = Math.min(options.maxPages, MAX_EDIT_PAGES);
      const edits: MatrixEvent[] = [];
      let original: MatrixEvent | null = null;
      let next: string | undefined;
      let pages = 0;
      do {
        // EventType.RoomMessage is load-bearing: the SDK decrypts the relation chunk only
        // when asked for a specific event type (m.room.encrypted in an encrypted room).
        const page = await client.relations(
          roomId,
          eventId,
          RelationType.Replace,
          EventType.RoomMessage,
          { dir: Direction.Backward, limit: EDIT_PAGE_SIZE, from: next },
        );
        original ??= page.originalEvent ?? null;
        edits.push(...page.events);
        next = page.nextBatch ?? undefined;
        pages++;
      } while (next && pages < maxPages);

      const room = client.getRoom(roomId);
      // The SDK resolves the original through a /event round trip that can come back
      // empty; fall back to the copy already in the timeline.
      original ??= room?.findEventById(eventId) ?? null;
      if (!original) return engineFail(localFailure('message-unavailable'));
      // Deleting a message leaves its edits on the server; listing them would undo it.
      if (original.isRedacted()) {
        return engineOk({ revisions: [], truncated: false });
      }
      repairAggregation(client, roomId, eventId, edits);

      const encryption = new RoomEncryptionFlags();
      await encryption.refresh(client.getCrypto?.(), roomId);
      const markFor = room
        ? unencryptedMarkFor(room, encryption.isEncrypted(room))
        : () => null;
      return engineOk({
        revisions: editRevisionSources(original, edits).map(
          ({ event, content }): Revision => {
            const sender = event.getSender() ?? '';
            const body = content?.['body'];
            const html =
              content?.['format'] === 'org.matrix.custom.html' &&
              typeof content['formatted_body'] === 'string'
                ? content['formatted_body']
                : null;
            return {
              eventId: event.getId() ?? '',
              sender,
              ts: event.getTs(),
              kind: content ? 'text' : 'undecryptable',
              body: typeof body === 'string' ? body : '',
              html,
              shield: null,
              unencryptedMark: markFor(event, event),
              profiles: profilesOf(room, [sender, ...linkedUserIds(html)]),
            };
          },
        ),
        truncated: !!next,
      });
    });
  }

  removeRevision(
    accountId: string,
    roomId: string,
    revisionEventId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      await client.redactEvent(roomId, revisionEventId);
      return engineOk(null);
    });
  }

  linkPreview(
    accountId: string,
    url: string,
    options: { readonly onlyIfUnencrypted: string | null },
  ): Observable<EngineResult<LinkPreview | null>> {
    return this.command(accountId, async (client) => {
      const gate = options.onlyIfUnencrypted;
      if (gate !== null) {
        // Asking would show the homeserver a URL from an encrypted message.
        const room = client.getRoom(gate);
        if (!room || (await isRoomEncrypted(room, client.getCrypto?.()))) {
          return engineOk(null);
        }
      }
      try {
        return engineOk(toPreview(await client.getUrlPreview(url, Date.now())));
      } catch (error) {
        if (isPreviewEndpointUnavailable(error)) {
          return engineFail(failureFrom('unsupported', error));
        }
        throw error;
      }
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
   * Writes `change(list)` back as the room's pinned list, every entry of the list as read
   * included; `null` means nothing to change. Replies once open subscriptions show it.
   */
  private writePins(
    accountId: string,
    roomId: string,
    change: (pinned: readonly unknown[]) => readonly unknown[] | null,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) => {
      const room = client.getRoom(roomId);
      if (!room) return of(engineFail(localFailure('message-unavailable')));
      const pinned = change(rawPinned(room));
      if (!pinned) return of(engineOk(null));
      return from(
        client.sendStateEvent(
          roomId,
          EventType.RoomPinnedEvents,
          // The cast only satisfies the SDK's `string[]`; non-strings are written back on purpose.
          { pinned: [...pinned] as string[] },
          '',
        ),
      ).pipe(
        switchMap(({ event_id }) => pinsApplied(client, roomId, event_id)),
        tap(() => {
          for (const feed of this.pinFeeds) {
            if (feed.client === client && feed.roomId === roomId) feed.flush();
          }
        }),
        map(() => engineOk(null)),
      );
    });
  }

  /** Projects the room's pins into `subscriber` until the returned teardown runs. */
  private attachPins(
    client: MatrixClient,
    room: Room,
    subscriber: Subscriber<PinnedEvents>,
  ): () => void {
    const roomId = room.roomId;
    const encryption = new RoomEncryptionFlags();
    let eventIds: readonly string[] = [];
    /** Pins fetched because the loaded timeline lacks them. */
    let fetched = new Map<string, PinFetch>();
    let loading = new Set<string>();
    /** Pins waiting for a free fetch slot; `loading` already holds them. */
    let queued: string[] = [];
    let activeFetches = 0;
    /** Bumped when the list changes or the subscription closes, so stale fetches drop out. */
    let generation = 0;
    let closed = false;

    /** Re-reads the list; true when it changed, which drops every fetch for the old one. */
    const readIds = (): boolean => {
      // Clients append, so the newest pins are the last ones.
      const next = rawPinned(room)
        .filter((id): id is string => typeof id === 'string')
        .slice(-MAX_PINS);
      const changed =
        next.length !== eventIds.length ||
        next.some((id, i) => id !== eventIds[i]);
      eventIds = next;
      if (changed) {
        generation++;
        fetched = new Map();
        loading = new Set();
        queued = [];
      }
      return changed;
    };

    const fetchPinned = (id: string): void => {
      loading.add(id);
      if (activeFetches >= MAX_CONCURRENT_PIN_FETCHES) {
        queued.push(id);
        return;
      }
      runFetch(id);
    };

    /** Fetches (and decrypts) a pin the loaded timeline lacks; one request per pin list. */
    const runFetch = (id: string): void => {
      const token = generation;
      activeFetches++;
      void (async () => {
        let result: PinFetch;
        try {
          const raw = await client.fetchRoomEvent(roomId, id);
          if (raw.room_id && raw.room_id !== roomId) {
            result = { kind: 'missing' };
          } else {
            const event = client.getEventMapper({ decrypt: false })({
              ...raw,
              room_id: roomId,
            });
            if (event.isEncrypted()) await client.decryptEventIfNeeded(event);
            result = { kind: 'loaded', event };
          }
        } catch (error) {
          // The server's "no" (not found / not allowed) is final; anything else is a
          // failure that the next invalidation retries.
          const status = (error as { httpStatus?: number } | null)?.httpStatus;
          result =
            status === 404 || status === 403
              ? { kind: 'missing' }
              : { kind: 'failed', at: Date.now() };
        }
        activeFetches--;
        const next = queued.shift();
        if (next !== undefined && !closed) runFetch(next);
        if (token !== generation) return;
        loading.delete(id);
        fetched.set(id, result);
        flusher.schedule();
      })();
    };

    /**
     * Re-fetches failed pins that failed at least `minAgeMs` ago. The failed entry stays
     * until the re-fetch resolves, so the row never flickers back to loading.
     */
    const retryFailed = (minAgeMs: number): void => {
      const now = Date.now();
      for (const [id, f] of fetched) {
        if (f.kind === 'failed' && !loading.has(id) && now - f.at >= minAgeMs) {
          fetchPinned(id);
        }
      }
    };

    const project = (): PinnedEvents => {
      const markFor = unencryptedMarkFor(room, encryption.isEncrypted(room));
      const entries: PinnedEntry[] = [];
      for (const id of eventIds) {
        let event = room.findEventById(id);
        if (!event && !fetched.has(id)) {
          if (!loading.has(id)) fetchPinned(id);
          entries.push(placeholder(id, 'loading'));
          continue;
        }
        if (!event) {
          const fetch = fetched.get(id);
          if (fetch?.kind !== 'loaded') {
            entries.push(
              placeholder(
                id,
                fetch?.kind === 'failed' ? 'failed' : 'unavailable',
              ),
            );
            continue;
          }
          event = fetch.event;
        }
        if (event.isRedacted()) continue;
        const sender = event.getSender() ?? '';
        entries.push({
          eventId: id,
          status: 'loaded',
          sender,
          // The mark flags unencrypted text, so the text itself stays readable.
          body: messagePreview(event),
          ts: event.getTs(),
          shield: null,
          unencryptedMark: markFor(event),
          profiles: profilesOf(room, [sender]),
        });
      }
      return { eventIds: [...eventIds], entries };
    };

    const emit = (): void => subscriber.next(project());
    const flusher = coalesce(emit);
    const feed: PinsFeed = {
      client,
      roomId,
      flush: () => {
        readIds();
        flusher.cancel();
        emit();
      },
    };

    const onStateEvent = (event: MatrixEvent): void => {
      const type = event.getType();
      if (
        type === EventType.RoomPinnedEvents ||
        type === EventType.RoomPowerLevels
      ) {
        if (!readIds()) retryFailed(0);
        flusher.schedule();
      }
    };
    const onTimeline = (): void => {
      retryFailed(AUTO_RETRY_MS);
      flusher.schedule();
    };
    const onDecrypted = (event: MatrixEvent): void => {
      if (event.getRoomId() !== roomId) return;
      retryFailed(AUTO_RETRY_MS);
      flusher.schedule();
    };

    room.on(RoomStateEvent.Events, onStateEvent);
    room.on(RoomEvent.Timeline, onTimeline);
    client.on(MatrixEventEvent.Decrypted, onDecrypted);
    this.pinFeeds.add(feed);
    void encryption.refresh(client.getCrypto?.(), roomId).then((encrypted) => {
      if (encrypted && !closed) flusher.schedule();
    });

    readIds();
    emit();

    return () => {
      closed = true;
      generation++;
      flusher.cancel();
      this.pinFeeds.delete(feed);
      room.off(RoomStateEvent.Events, onStateEvent);
      room.off(RoomEvent.Timeline, onTimeline);
      client.off(MatrixEventEvent.Decrypted, onDecrypted);
    };
  }
}
