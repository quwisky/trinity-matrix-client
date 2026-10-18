import { Injectable } from '@angular/core';
import {
  SearchOrderBy,
  type ISearchRequestBody,
  type ISearchResponse,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
import {
  RoomEncryptionFlags,
  displayContent,
  isDisplayableMessage,
  isRoomEncrypted,
} from '@trinity/util/matrix';
import type { MessageShield } from './message-presentation';
import { unencryptedShieldFor } from './shields';
import type { ConversationKey } from './conversation-messages';
import { scrollbackLive } from './live-scrollback';

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
 * Conversation-owned message search. Loaded E2EE-safe matching is synchronous over
 * decrypted events; network search and scrollback are cold, cancellable Observables.
 */
@Injectable()
export class ConversationSearchController {
  private key: ConversationKey | null = null;
  private client: MatrixClient | null = null;
  private encryption = new RoomEncryptionFlags();

  /** Bind this controller to one immutable Conversation child. */
  attach(key: ConversationKey, client: MatrixClient): void {
    this.key = Object.freeze({ ...key });
    this.client = client;
    this.encryption = new RoomEncryptionFlags();
    void this.encryption.refresh(client.getCrypto?.(), key.roomId);
  }

  /** Retired handles fail closed rather than following the Active Account. */
  release(): void {
    this.key = null;
    this.client = null;
  }

  searchLoaded(query: string): LoadedMessageSearch {
    const empty: LoadedMessageSearch = {
      hits: [],
      scanned: 0,
      encrypted: false,
      serverAvailable: true,
    };
    const context = this.context();
    if (!context) {
      return empty;
    }
    const { key, client } = context;
    const room = client.getRoom(key.roomId);
    if (!room) {
      return empty;
    }
    const encrypted = room.hasEncryptionStateEvent();
    const qLower = query.trim().toLowerCase();
    const hits: MessageHit[] = [];
    const unencryptedShield = unencryptedShieldFor(
      room,
      this.encryption.isEncrypted(room),
    );
    let scanned = 0;
    for (const event of room.getLiveTimeline().getEvents()) {
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
        roomId: key.roomId,
        sender,
        senderName: member?.name ?? sender,
        senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
        body,
        ts: event.getTs(),
        snippet: buildSnippet(body, qLower),
        shield: unencryptedShield(event),
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
    const trimmed = term.trim();
    return defer(async () => {
      const context = this.context();
      if (!context || !trimmed) {
        return empty;
      }
      const { key, client } = context;
      const room = client.getRoom(key.roomId);
      if (!room) {
        return empty;
      }
      if (await isRoomEncrypted(room, client.getCrypto?.(), this.encryption)) {
        return { ...empty, encrypted: true };
      }
      const body: ISearchRequestBody = {
        search_categories: {
          room_events: {
            search_term: trimmed,
            keys: ['content.body'],
            filter: { rooms: [key.roomId] },
            order_by: SearchOrderBy.Recent,
            event_context: {
              before_limit: 0,
              after_limit: 0,
              include_profile: true,
            },
          },
        },
      };
      const response = await client.search(
        nextBatch ? { body, next_batch: nextBatch } : { body },
      );
      return mapServerResponse(key.roomId, trimmed, response);
    }).pipe(catchError(() => of(empty)));
  }

  loadOlder(count = 50): Observable<number> {
    return defer(() => {
      const context = this.context();
      if (!context) {
        return of(0);
      }
      const { key, client } = context;
      const room = client.getRoom(key.roomId);
      if (!room) {
        return of(0);
      }
      return from(scrollbackLive(client, room, count)).pipe(
        map(() => room.getLiveTimeline().getEvents().length),
      );
    });
  }

  private context(): {
    readonly key: ConversationKey;
    readonly client: MatrixClient;
  } | null {
    return this.key && this.client
      ? { key: this.key, client: this.client }
      : null;
  }
}

function readBody(event: MatrixEvent): string {
  const body = displayContent(event)['body'];
  return typeof body === 'string' ? body : '';
}

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
      // Server search runs only for a room that is not encrypted.
      shield: null,
    };
  });
  return {
    hits,
    count: category.count ?? hits.length,
    nextBatch: category.next_batch ?? null,
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
