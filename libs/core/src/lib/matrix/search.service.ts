import { Injectable, computed, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { InvitesService } from './invites.service';
import { RoomsService } from './rooms.service';
import { SpacesService } from './spaces.service';

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
}

/** What the switcher dismisses with when a row is chosen. */
export interface SwitcherSelection {
  kind: SwitcherKind;
  id: string;
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
  private readonly invites = inject(InvitesService);

  /**
   * The searchable corpus, recomputed only when a source signal changes — so each
   * keystroke re-filters this memoized, already-lowercased list instead of
   * re-projecting and re-casing every name.
   */
  private readonly entries = computed<SwitcherEntry[]>(() => {
    const directIds = this.rooms.directRoomIds();
    const out: SwitcherEntry[] = [];

    for (const room of this.rooms.rooms()) {
      const isDm = directIds.has(room.id);
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
      });
    }

    for (const space of this.spaces.spaces()) {
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
      });
    }

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
  localResults(query: string, limit = DEFAULT_LIMIT): SwitcherResult[] {
    const qLower = query.trim().toLowerCase();
    return this.entries()
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
