import { Injectable, computed, inject } from '@angular/core';
import {
  SearchOrderBy,
  type ISearchRequestBody,
  type ISearchResponse,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
import { InvitesService } from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { isDisplayableMessage } from '@trinity/util/matrix';
import {
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  RoomsService,
  SpacesService,
} from '@trinity/data-access/rooms';

/** What a {@link SwitcherResult} points at, driving its icon and the jump on select. */
export type SwitcherKind = 'room' | 'space' | 'dm' | 'invite' | 'user';

/** A single ranked row in the quick switcher. */
export interface SwitcherResult {
  kind: SwitcherKind;
  /** `roomId` for room/space/dm/invite; `userId` for a directory person. */
  id: string;
  title: string;
  /** Inviter / member display / userId / topic, depending on the kind. */
  subtitle?: string;
  /** Raw `mxc://` avatar; the UI resolves it (authed). */
  avatarMxc: string | null;
  /** Uppercased first character (sans sigil) for the avatar fallback. */
  initial: string;
  /** Ranking weight; higher sorts first. Directory people carry 0 (appended last). */
  score: number;
  /** Whether the underlying room is encrypted (drives the lock badge). */
  encrypted?: boolean;
  /** The signed-in account this row belongs to — the mixed-account view badges rows with
   * it, and jumping to one switches to that account first. */
  accountId?: string;
}

/** What the switcher dismisses with when a row is chosen. */
export interface SwitcherSelection {
  kind: SwitcherKind;
  id: string;
  /** Owning account, when the row came from the mixed-account corpus. */
  accountId?: string;
}

/** A single message that matched an in-room search (client- or server-side). */
export interface MessageHit {
  /** The matched event's id; used to jump to it in the timeline. */
  eventId: string;
  roomId: string;
  /** Sender MXID. */
  sender: string;
  /** Resolved display name (room member / directory profile), or the MXID. */
  senderName: string;
  /** Sender `mxc://` avatar for the result row, or null. */
  senderAvatarMxc: string | null;
  /** Full plain-text body of the matched message. */
  body: string;
  /** Origin-server timestamp (ms), for ordering + display. */
  ts: number;
  /** A single-line excerpt around the first match, for the result row. */
  snippet: string;
}

/**
 * Result of a client-side search over the active room's already-loaded, *decrypted*
 * timeline — the only reliable path for an E2EE room (the homeserver can't search
 * ciphertext). `scanned` is the size of the searchable corpus so the UI can be honest
 * about coverage; `serverAvailable` is true only for unencrypted rooms.
 */
export interface LoadedMessageSearch {
  hits: MessageHit[];
  scanned: number;
  encrypted: boolean;
  serverAvailable: boolean;
}

/** A page of server-side (full-history) search results for an unencrypted room. */
export interface ServerMessageSearch {
  hits: MessageHit[];
  /** Total server-reported match count (>= hits.length once paginated). */
  count: number;
  /** Token for the next page, or null when results are exhausted. */
  nextBatch: string | null;
}

/** Memoized, lowercased projection of a searchable source row. */
interface SwitcherEntry {
  kind: SwitcherKind;
  id: string;
  title: string;
  subtitle?: string;
  avatarMxc: string | null;
  initial: string;
  /** Pre-lowercased title; drives the exact/prefix/word-boundary buckets. */
  titleLower: string;
  /** Pre-lowercased title (+ topic for rooms); the substring fallback corpus. */
  haystack: string;
  /** Last-activity ms for the recency tiebreak (0 for spaces/invites). */
  activityTs: number;
  encrypted?: boolean;
  accountId?: string;
}

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 100;
const SCORE_WORD_BOUNDARY = 50;
const SCORE_SUBSTRING = 10;
/** Every entry matches the empty query equally so it falls back to recents. */
const SCORE_EMPTY = 1;

/** Don't hit the directory until the term is at least this long. */
const MIN_PEOPLE_LENGTH = 2;

/** Default cap on local results so a large account stays responsive per keystroke. */
const DEFAULT_LIMIT = 30;

/**
 * Read-only, client-side search aggregator for the quick switcher. Reads the live
 * synced signals from {@link RoomsService}, {@link SpacesService}, and
 * {@link InvitesService} (joined rooms/DMs, spaces, pending invites) and ranks them
 * by name — no network, no message-body access, so it is inherently E2EE-safe.
 *
 * {@link localResults} is synchronous (wrap it in a component `computed` to stay
 * reactive); {@link searchPeople} is the only networked path, a directory lookup the
 * caller debounces and appends below the local list.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly rooms = inject(RoomsService);
  private readonly spaces = inject(SpacesService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly mixedSpaces = inject(MixedSpacesService);
  private readonly scope = inject(AccountScopeService);
  private readonly invites = inject(InvitesService);
  private readonly matrix = inject(MatrixClientService);

  /**
   * The searchable corpus, recomputed only when a source signal changes — so each
   * keystroke re-filters this memoized, already-lowercased list instead of
   * re-projecting and re-casing every name.
   */
  private readonly entries = computed<SwitcherEntry[]>(() => {
    // Mirror the sidebar's scope: while mixing, the switcher searches every selected
    // account's rooms and spaces, each row tagged with the account that owns it. DMs are
    // then classified by the row's OWN account's m.direct, since the active account's
    // direct set says nothing about another account's rooms.
    const mixing = this.scope.mixing();
    const directIds = this.rooms.directRoomIds();
    const out: SwitcherEntry[] = [];

    for (const room of mixing ? this.mixedRooms.rooms() : this.rooms.rooms()) {
      const isDm = mixing ? room.directUserId != null : directIds.has(room.id);
      const topic = room.topic.trim();
      const titleLower = room.name.toLowerCase();
      out.push({
        kind: isDm ? 'dm' : 'room',
        id: room.id,
        title: room.name,
        ...(topic ? { subtitle: topic } : {}),
        avatarMxc: room.avatarMxc,
        initial: room.initial,
        titleLower,
        haystack: topic ? `${titleLower}\n${topic.toLowerCase()}` : titleLower,
        activityTs: room.activityTs,
        encrypted: room.encrypted,
        ...(mixing ? { accountId: room.accountId } : {}),
      });
    }

    for (const space of mixing
      ? this.mixedSpaces.spaces()
      : this.spaces.spaces()) {
      const titleLower = space.name.toLowerCase();
      out.push({
        kind: 'space',
        id: space.id,
        title: space.name,
        avatarMxc: space.avatarMxc,
        initial: space.initial,
        titleLower,
        haystack: titleLower,
        activityTs: 0,
        ...(mixing ? { accountId: space.accountId } : {}),
      });
    }

    // Invites stay active-account only: InvitesService projects one client, and accepting
    // one is an action on that account.
    for (const invite of this.invites.pendingInvites()) {
      const titleLower = invite.name.toLowerCase();
      out.push({
        kind: 'invite',
        id: invite.roomId,
        title: invite.name,
        subtitle: `Invited by ${invite.inviterName}`,
        avatarMxc: invite.avatarMxc,
        initial: invite.initial,
        titleLower,
        haystack: titleLower,
        activityTs: 0,
      });
    }

    return out;
  });

  /**
   * Ranked, capped local matches for `query`. Reads the live source signals (via the
   * memoized {@link entries}), so calling it from a component `computed` keeps it
   * reactive. An empty query returns recents (everything, ordered by recency).
   * Ordering: score desc, then last-activity desc, then title.
   */
  localResults(
    query: string,
    limit = DEFAULT_LIMIT,
    accountId?: string,
  ): SwitcherResult[] {
    const qLower = query.trim().toLowerCase();
    // Scope BEFORE ranking and slicing: filtering afterwards lets a busier other account
    // consume the whole cap and leaves the caller with nothing.
    const corpus = accountId
      ? this.entries().filter((e) => !e.accountId || e.accountId === accountId)
      : this.entries();
    return corpus
      .map((entry) => ({
        entry,
        score: scoreOf(entry.titleLower, entry.haystack, qLower),
      }))
      .filter((scored) => scored.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.activityTs - a.entry.activityTs ||
          a.entry.title.localeCompare(b.entry.title),
      )
      .slice(0, limit)
      .map(({ entry, score }) => ({
        kind: entry.kind,
        id: entry.id,
        title: entry.title,
        ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
        avatarMxc: entry.avatarMxc,
        initial: entry.initial,
        score,
        ...(entry.encrypted !== undefined
          ? { encrypted: entry.encrypted }
          : {}),
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
      }));
  }

  /**
   * Homeserver user-directory search, mapped to `kind: 'user'` rows the switcher
   * appends below the local list. Terms shorter than two characters resolve to `[]`
   * without a request; a failed lookup degrades to `[]` rather than erroring. The
   * caller owns debouncing.
   */
  searchPeople(term: string): Observable<SwitcherResult[]> {
    if (term.trim().length < MIN_PEOPLE_LENGTH) {
      return of<SwitcherResult[]>([]);
    }
    return this.rooms.searchUsers(term).pipe(
      map((users) =>
        users.map<SwitcherResult>((user) => ({
          kind: 'user',
          id: user.userId,
          title: user.displayName,
          subtitle: user.userId,
          avatarMxc: user.avatarMxc,
          initial: initialOf(user.displayName),
          score: 0,
        })),
      ),
      catchError(() => of<SwitcherResult[]>([])),
    );
  }

  /**
   * Search the active room's already-loaded, *decrypted* timeline for `query`. This is
   * the only reliable path for an end-to-end-encrypted room: the homeserver stores
   * only ciphertext, so server search can't see message bodies. Only loaded history is
   * covered (widen it with {@link loadMoreHistory}); undecryptable events are skipped
   * and excluded from `scanned`. Synchronous — wrap it in a component `computed` that
   * also reads the timeline signal so it recomputes on new/decrypted events.
   */
  searchLoadedMessages(roomId: string, query: string): LoadedMessageSearch {
    const empty: LoadedMessageSearch = {
      hits: [],
      scanned: 0,
      encrypted: false,
      serverAvailable: true,
    };
    if (!this.matrix.isInitialized) {
      return empty;
    }
    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    if (!room) {
      return empty;
    }
    const encrypted = room.hasEncryptionStateEvent();
    const qLower = query.trim().toLowerCase();
    const hits: MessageHit[] = [];
    let scanned = 0;
    for (const event of room.getLiveTimeline().getEvents()) {
      // Mirror the timeline's notion of a visible message (drop edits/relations),
      // and never read an event we couldn't decrypt.
      if (!isDisplayableMessage(event) || event.isDecryptionFailure()) {
        continue;
      }
      scanned++;
      const body = readBody(event);
      if (!qLower || !body.toLowerCase().includes(qLower)) {
        continue;
      }
      const sender = event.getSender() ?? '';
      const member = room.getMember(sender);
      hits.push({
        eventId: event.getId() ?? '',
        roomId,
        sender,
        senderName: member?.name ?? sender,
        senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
        body,
        ts: event.getTs(),
        snippet: buildSnippet(body, qLower),
      });
    }
    hits.sort((a, b) => b.ts - a.ts); // most-recent first
    return { hits, scanned, encrypted, serverAvailable: !encrypted };
  }

  /**
   * Full-text server search for an UNENCRYPTED room, covering its entire history.
   * Refuses (resolves empty) for an encrypted or unknown room — the homeserver can't
   * search ciphertext, so we never pretend it can. `nextBatch` pages further results.
   * Wraps the homeserver `/search` endpoint (`client.search`).
   */
  searchServerMessages(
    roomId: string,
    term: string,
    nextBatch?: string,
  ): Observable<ServerMessageSearch> {
    const empty: ServerMessageSearch = { hits: [], count: 0, nextBatch: null };
    const trimmed = term.trim();
    return defer(() => {
      if (!this.matrix.isInitialized || !trimmed) {
        return of(empty);
      }
      const client = this.matrix.instance;
      const room = client.getRoom(roomId);
      // E2EE-honest: never issue a server search for an encrypted room.
      if (!room || room.hasEncryptionStateEvent()) {
        return of(empty);
      }
      const body: ISearchRequestBody = {
        search_categories: {
          room_events: {
            search_term: trimmed,
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
      return from(
        client.search(nextBatch ? { body, next_batch: nextBatch } : { body }),
      ).pipe(map((response) => mapServerResponse(roomId, trimmed, response)));
    }).pipe(catchError(() => of(empty)));
  }

  /**
   * Page in older history for `roomId` so {@link searchLoadedMessages} can see more of
   * it (the only way to widen search in an E2EE room). Resolves the new loaded-event
   * count; the caller re-runs the client-side search afterward.
   */
  loadMoreHistory(roomId: string, count = 50): Observable<number> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return of(0);
      }
      const client = this.matrix.instance;
      const room = client.getRoom(roomId);
      if (!room) {
        return of(0);
      }
      return from(client.scrollback(room, count)).pipe(
        map((paged) => paged.getLiveTimeline().getEvents().length),
      );
    });
  }
}

/**
 * Rank a row against `qLower` (already lowercased+trimmed): exact > prefix >
 * word-boundary prefix on the title, then a substring fallback over `haystack` (which
 * also covers a room's topic). `0` means no match (dropped); an empty query matches
 * everything equally so the list falls back to recents. `titleLower`/`haystack` are
 * pre-lowercased.
 */
function scoreOf(titleLower: string, haystack: string, qLower: string): number {
  if (!qLower) {
    return SCORE_EMPTY;
  }
  if (titleLower === qLower) {
    return SCORE_EXACT;
  }
  if (titleLower.startsWith(qLower)) {
    return SCORE_PREFIX;
  }
  if (new RegExp(`\\b${escapeRegExp(qLower)}`).test(titleLower)) {
    return SCORE_WORD_BOUNDARY;
  }
  if (haystack.includes(qLower)) {
    return SCORE_SUBSTRING;
  }
  return 0;
}

/** Escape a user-typed term so it is safe to embed in the word-boundary RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First visible character (sans sigil), uppercased, for the avatar fallback. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}

/** Plain-text body of a message event, or '' when absent. */
function readBody(event: MatrixEvent): string {
  const body = event.getContent()['body'];
  return typeof body === 'string' ? body : '';
}

/** Flatten a homeserver `/search` response into our {@link MessageHit} list. */
function mapServerResponse(
  roomId: string,
  term: string,
  response: ISearchResponse,
): ServerMessageSearch {
  const category = response.search_categories.room_events;
  const qLower = term.toLowerCase();
  const hits = (category.results ?? []).map<MessageHit>((entry) => {
    const event = entry.result;
    const sender = event.sender;
    const profile = entry.context?.profile_info?.[sender];
    const raw = event.content['body'];
    const body = typeof raw === 'string' ? raw : '';
    return {
      eventId: event.event_id,
      roomId,
      sender,
      senderName: profile?.displayname ?? sender,
      senderAvatarMxc: profile?.avatar_url ?? null,
      body,
      ts: event.origin_server_ts,
      snippet: buildSnippet(body, qLower),
    };
  });
  return {
    hits,
    count: category.count ?? hits.length,
    nextBatch: category.next_batch ?? null,
  };
}

/** Characters of context to keep on each side of the first match in a snippet. */
const SNIPPET_RADIUS = 60;

/** A single-line excerpt around the first occurrence of `qLower` in `body`. */
function buildSnippet(body: string, qLower: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!qLower) {
    return flat.length > SNIPPET_RADIUS * 2
      ? `${flat.slice(0, SNIPPET_RADIUS * 2)}…`
      : flat;
  }
  const at = flat.toLowerCase().indexOf(qLower);
  if (at < 0) {
    return flat;
  }
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + qLower.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${
    end < flat.length ? '…' : ''
  }`;
}
