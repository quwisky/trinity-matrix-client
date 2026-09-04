import { Injectable, computed, inject } from '@angular/core';
import { SelectedRoomLibraryService } from './selected-room-library.service';

/** A local Room Library destination that can appear in application search. */
export type RoomLibrarySearchKind = 'room' | 'space' | 'dm' | 'invite';

/** Fields shared by every ranked quick-switcher row. */
interface RoomLibrarySearchResultBase {
  /** Matrix Room ID for the room, space, DM, or invite. */
  id: string;
  title: string;
  /** Inviter / member display / userId / topic, depending on the kind. */
  subtitle?: string;
  /** Raw `mxc://` avatar; the UI resolves it (authed). */
  avatarMxc: string | null;
  /** Uppercased first character (sans sigil) for the avatar fallback. */
  initial: string;
  /** Ranking weight; higher sorts first. */
  score: number;
  /** Whether the underlying room is encrypted (drives the lock badge). */
  encrypted?: boolean;
  /** The signed-in account this row belongs to — the mixed-account view badges rows with
   * it, and jumping to one switches to that account first. */
  accountId: string;
  /** Present only for mixed-account presentation; semantic Account identity is separate. */
  accountBadgeId?: string;
}

/**
 * A single ranked row in the quick switcher. Invite rows require their direct-message
 * classification so consumers cannot silently guess the avatar's identity geometry.
 */
export type RoomLibrarySearchResult =
  | (RoomLibrarySearchResultBase & {
      kind: 'invite';
      isDirect: boolean;
      isSpace: boolean;
    })
  | (RoomLibrarySearchResultBase & {
      kind: Exclude<RoomLibrarySearchKind, 'invite'>;
      isDirect?: never;
    });

/** Fields shared by every memoized, lowercased searchable source row. */
interface SwitcherEntryBase {
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
  accountId: string;
  accountBadgeId?: string;
}

/** Invite entries carry the same required classification as their public result. */
type SwitcherEntry =
  | (SwitcherEntryBase & {
      kind: 'invite';
      isDirect: boolean;
      isSpace: boolean;
    })
  | (SwitcherEntryBase & {
      kind: Exclude<RoomLibrarySearchKind, 'invite'>;
      isDirect?: never;
    });

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 100;
const SCORE_WORD_BOUNDARY = 50;
const SCORE_SUBSTRING = 10;
/** Every entry matches the empty query equally so it falls back to recents. */
const SCORE_EMPTY = 1;

/** Default cap on local results so a large account stays responsive per keystroke. */
const DEFAULT_LIMIT = 30;

/**
 * Read-only, client-side search aggregator for the quick switcher. Reads the live
 * selected Room Library view (joined rooms/DMs, spaces, pending invites) and ranks
 * them by name — no network, no message-body access, so it is inherently E2EE-safe.
 *
 * {@link search} is synchronous so application orchestration can wrap it in a
 * `computed` and preserve signal reactivity without making Room Library know about
 * remote Discovery.
 */
@Injectable({ providedIn: 'root' })
export class RoomLibrarySearchService {
  private readonly selected = inject(SelectedRoomLibraryService);

  /**
   * The searchable corpus, recomputed only when a source signal changes — so each
   * keystroke re-filters this memoized, already-lowercased list instead of
   * re-projecting and re-casing every name.
   */
  private readonly entries = computed<SwitcherEntry[]>(() => {
    const view = this.selected.view();
    const out: SwitcherEntry[] = [];

    for (const room of view.rooms) {
      const isDm = room.directUserId != null;
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
        accountId: room.accountId,
        ...(view.mode === 'mixed' ? { accountBadgeId: room.accountId } : {}),
      });
    }

    for (const space of view.spaces) {
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
        accountId: space.accountId,
        ...(view.mode === 'mixed' ? { accountBadgeId: space.accountId } : {}),
      });
    }

    for (const invite of view.invitations) {
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
        isDirect: invite.isDirect,
        isSpace: invite.isSpace,
        accountId: invite.accountId,
        ...(view.mode === 'mixed' ? { accountBadgeId: invite.accountId } : {}),
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
  search(
    query: string,
    limit = DEFAULT_LIMIT,
    accountId?: string,
  ): RoomLibrarySearchResult[] {
    const qLower = query.trim().toLowerCase();
    // Scope BEFORE ranking and slicing: filtering afterwards lets a busier other account
    // consume the whole cap and leaves the caller with nothing.
    const corpus = accountId
      ? this.entries().filter((entry) => entry.accountId === accountId)
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
      .map(({ entry, score }): RoomLibrarySearchResult => {
        const common: RoomLibrarySearchResultBase = {
          id: entry.id,
          title: entry.title,
          ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
          avatarMxc: entry.avatarMxc,
          initial: entry.initial,
          score,
          ...(entry.encrypted !== undefined
            ? { encrypted: entry.encrypted }
            : {}),
          accountId: entry.accountId,
          ...(entry.accountBadgeId
            ? { accountBadgeId: entry.accountBadgeId }
            : {}),
        };
        return entry.kind === 'invite'
          ? {
              ...common,
              kind: 'invite',
              isDirect: entry.isDirect,
              isSpace: entry.isSpace,
            }
          : { ...common, kind: entry.kind };
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
