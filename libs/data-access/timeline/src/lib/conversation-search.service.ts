import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, of } from 'rxjs';
import { unwrapEngineResult } from '@trinity/util/matrix';
import type { SearchHit } from './conversation-content-engine';
import { CONVERSATION_CONTENT_ENGINE } from './conversation-content-engine.token';
import type { MessageShield } from './message-presentation';
import type { ConversationKey } from './conversation-messages';
import { unencryptedShield } from './shield-presentation';
import type { EventTimelineItem } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { profileName } from './timeline-item-presentation';
import { TimelineService } from './timeline.service';

/** A single message that matched an in-conversation search. */
export interface MessageHit {
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly senderName: string;
  readonly senderAvatarMxc: string | null;
  readonly body: string;
  readonly ts: number;
  readonly snippet: string;
  /** The unencrypted mark for the message's text, as its timeline row carries it. */
  readonly shield: MessageShield | null;
}

/** Search result over the active conversation's loaded, decrypted timeline. */
export interface LoadedMessageSearch {
  readonly hits: readonly MessageHit[];
  readonly scanned: number;
  readonly encrypted: boolean;
  readonly serverAvailable: boolean;
}

/** One server-side full-history page for an unencrypted conversation. */
export interface ServerMessageSearch {
  readonly hits: readonly MessageHit[];
  readonly count: number;
  readonly nextBatch: string | null;
  /** True when nothing was searched because the room counts as encrypted. */
  readonly encrypted?: boolean;
}

/**
 * Conversation-owned message search. Loaded E2EE-safe matching is synchronous over the main
 * timeline's items; network search and scrollback are cold, cancellable Observables.
 */
@Injectable()
export class ConversationSearchController {
  private readonly timeline = inject(TimelineService);
  private readonly timelineEngine = inject(TIMELINE_ENGINE);
  private readonly content = inject(CONVERSATION_CONTENT_ENGINE);
  private key: ConversationKey | null = null;

  /** Bind this controller to one immutable Conversation child. */
  attach(key: ConversationKey): void {
    this.key = Object.freeze({ ...key });
  }

  /** Retired handles fail closed rather than following the Active Account. */
  release(): void {
    this.key = null;
  }

  searchLoaded(query: string): LoadedMessageSearch {
    const empty: LoadedMessageSearch = {
      hits: [],
      scanned: 0,
      encrypted: false,
      serverAvailable: true,
    };
    const key = this.key;
    const store = this.timeline.mainStore();
    const room = store?.room();
    if (!key || !store || !room) {
      return empty;
    }
    const encrypted = room.hasEncryptionStateEvent;
    const qLower = query.trim().toLowerCase();
    const hits: MessageHit[] = [];
    let scanned = 0;
    for (const item of store.items()) {
      const body = item.kind === 'event' ? searchableBody(item) : null;
      // Local echoes are skipped: a hit must name an event to jump to.
      if (body === null || item.kind !== 'event' || !item.eventId) continue;
      scanned++;
      if (!qLower || !body.toLowerCase().includes(qLower)) {
        continue;
      }
      const profile = item.profiles[item.sender];
      hits.push({
        eventId: item.eventId,
        roomId: key.roomId,
        sender: item.sender,
        senderName: profileName(item.sender, profile),
        senderAvatarMxc: profile?.avatarMxc ?? null,
        body,
        ts: item.timestamp,
        snippet: buildSnippet(body, qLower),
        shield: unencryptedShield(item.unencryptedMark),
      });
    }
    hits.sort((a, b) => b.ts - a.ts);
    return { hits, scanned, encrypted, serverAvailable: !encrypted };
  }

  searchServer(
    term: string,
    nextBatch?: string,
  ): Observable<ServerMessageSearch> {
    const empty: ServerMessageSearch = { hits: [], count: 0, nextBatch: null };
    return defer(() => {
      const key = this.key;
      const trimmed = term.trim();
      if (!key || !trimmed) {
        return of(empty);
      }
      return this.content
        .searchMessages(key.accountId, key.roomId, trimmed, nextBatch ?? null)
        .pipe(
          map((result): ServerMessageSearch => {
            // Any failure, an unknown room included, reads as no results.
            if (!result.ok) return empty;
            const page = result.value;
            if ('encrypted' in page) return { ...empty, encrypted: true };
            const qLower = trimmed.toLowerCase();
            return {
              hits: page.hits.map((hit) => serverHit(key.roomId, hit, qLower)),
              count: page.count,
              nextBatch: page.nextBatch,
            };
          }),
        );
    });
  }

  loadOlder(count = 50): Observable<number> {
    return defer(() => {
      const key = this.key;
      const store = this.timeline.mainStore();
      if (!key || !store?.available()) {
        return of(0);
      }
      return this.timelineEngine
        .paginateBackwards(key.accountId, key.roomId, { kind: 'live' }, count)
        .pipe(
          unwrapEngineResult(),
          map(
            () => store.items().filter((item) => item.kind === 'event').length,
          ),
        );
    });
  }
}

/**
 * The `body` a displayable message's content carries, or null for an item the old event
 * filter skipped: state, an undecryptable message.
 */
function searchableBody(item: EventTimelineItem): string | null {
  const content = item.content;
  switch (content.kind) {
    case 'message':
    case 'unsupported':
      return content.body;
    case 'media':
      return content.caption ?? content.body;
    case 'sticker':
      return content.body ?? '';
    case 'location':
      return content.label;
    case 'poll':
    case 'redacted':
      return '';
    case 'unableToDecrypt':
    case 'state':
      return null;
  }
}

function serverHit(roomId: string, hit: SearchHit, qLower: string): MessageHit {
  const profile = hit.profiles[hit.sender];
  return {
    eventId: hit.eventId,
    roomId,
    sender: hit.sender,
    senderName: profile?.displayName ?? hit.sender,
    senderAvatarMxc: profile?.avatarMxc ?? null,
    body: hit.body,
    ts: hit.ts,
    snippet: buildSnippet(hit.body, qLower),
    // Server search runs only for a room that is not encrypted.
    shield: null,
  };
}

const SNIPPET_RADIUS = 60;

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
