import { Injectable, computed, inject, signal } from '@angular/core';
import {
  MatrixClientService,
  isServerSync,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { RoomEncryptionFlags } from '@trinity/util/matrix';
import { latestGuard, type LatestToken } from '@trinity/util/ui';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  defer,
  finalize,
  from,
  map,
  merge,
  mergeMap,
  of,
  reduce,
  switchMap,
  takeWhile,
  tap,
  timeout,
  toArray,
  type ObservableInput,
} from 'rxjs';
import { normalizeNotificationEvent } from '../matrix-notification-event.adapter';
import { NOTIFICATION_TEXT } from '../notification-text.port';
import {
  inboxPreview,
  mergeInboxRows,
  type InboxLoadResult,
  type InboxPreview,
  type InboxRow,
  type InboxTab,
} from './inbox-rows';
import {
  checkInboxEvent,
  fetchNotificationsPage,
  lookUpIndexedEvent,
  mapInboxEvent,
  type IndexedEventLookup,
} from './matrix-inbox.adapter';
import { MentionInboxPreferences } from './mention-inbox.preferences';
import type { MentionCursor, MentionRecord } from './mention-index-store';
import { MentionIndexService, STEP_LIMIT_MS } from './mention-index.service';
import { isPlainEventId, type NotificationEntry } from './notifications-page';

const SERVER_PAGE_SIZE = 50;
const SERVER_PAGES_PER_LOAD = 3;
const MAX_CONCURRENT_DECRYPTIONS = 4;
const INDEX_PAGE_SIZE = 50;

/** One refresh or Load more, tied to the client it started on. */
interface Load {
  readonly client: MatrixClient;
  readonly accountId: string;
  readonly token: LatestToken;
  /** The record switch is off: the inbox uses the server's list only. */
  readonly useIndex: boolean;
}

interface ServerRow {
  readonly row: InboxRow;
  readonly highlighted: boolean;
  readonly undecryptable: boolean;
}

type Judged =
  | ({ readonly kind: 'shown' } & ServerRow)
  | { readonly kind: 'dropped'; readonly eventId: string }
  | { readonly kind: 'skipped' };

const shownRows = (judged: readonly Judged[]): readonly ServerRow[] =>
  judged.flatMap((result) => (result.kind === 'shown' ? [result] : []));

/**
 * The inbox's rows for the active account, in memory only. Not live: rows change on `refresh`
 * and `loadMore`. `disconnect` drops them, which also drops decrypted text.
 */
@Injectable({ providedIn: 'root' })
export class NotificationInboxService {
  private readonly matrix = inject(MatrixClientService);
  private readonly mentionIndex = inject(MentionIndexService);
  private readonly preferences = inject(MentionInboxPreferences);
  private readonly text = inject(NOTIFICATION_TEXT, { optional: true });
  private readonly guard = latestGuard();

  private readonly serverRows = signal<ReadonlyMap<string, ServerRow>>(
    new Map(),
  );
  private readonly indexRows = signal<readonly InboxRow[]>([]);
  private readonly serverToken = signal<string | null>(null);
  private readonly indexCursor = signal<MentionCursor | null>(null);
  private readonly statusState = signal<
    'idle' | 'loading' | 'ready' | 'failed'
  >('idle');
  private readonly serverFailed = signal(false);
  private readonly lastLoadState = signal<InboxLoadResult | null>(null);

  private readonly projection = projectFromClient({
    id: 'notifications.inbox',
    matrix: this.matrix,
    reset: () => this.clear(),
  });

  readonly all = computed(() =>
    mergeInboxRows([...this.serverRows().values()].map(({ row }) => row)),
  );
  readonly mentions = computed(() => {
    const server = this.serverRows();
    return mergeInboxRows(
      [...server.values()]
        .filter(({ highlighted }) => highlighted)
        .map(({ row }) => row),
      // Rows the server also lists read as its rows do; the room answers only for the others.
      this.indexRows().map((row) => server.get(row.eventId)?.row ?? row),
    );
  });
  /** Server rows that can't be judged. One the index holds was judged when recorded. */
  readonly uncheckedCount = computed(() => {
    const held = new Set(this.indexRows().map((row) => row.eventId));
    return [...this.serverRows().values()].filter(
      ({ row, undecryptable }) => undecryptable && !held.has(row.eventId),
    ).length;
  });
  readonly status = this.statusState.asReadonly();
  readonly serverListFailed = this.serverFailed.asReadonly();
  readonly serverHasMore = computed(() => this.serverToken() !== null);
  readonly hasMore = computed(
    () => this.serverHasMore() || this.indexCursor() !== null,
  );
  readonly lastLoad = this.lastLoadState.asReadonly();

  connect(): void {
    this.projection.connect();
  }

  disconnect(): void {
    this.projection.disconnect();
  }

  /** Loads one server page and one index page. Old rows stay until each answer lands. */
  refresh(): Observable<void> {
    return defer(() => {
      const load = this.begin();
      if (!load) return of(undefined);
      if (!load.useIndex) {
        this.indexRows.set([]);
        this.indexCursor.set(null);
      }
      return this.finish(
        load,
        this.fetch(
          this.serverPage(load, null, true),
          this.indexPage(load, null, true),
        ),
      );
    });
  }

  /** Fetches until a page adds a row to `tab`, or the limit, or the end. */
  loadMore(tab: InboxTab): Observable<void> {
    return defer(() => {
      const status = this.statusState();
      // Load more would append to a list a running Refresh is about to replace.
      if (status === 'idle' || status === 'loading') return of(undefined);
      const load = this.begin();
      if (!load) return of(undefined);
      const pages = tab === 'all' ? 1 : SERVER_PAGES_PER_LOAD;
      return this.finish(
        load,
        this.takePages(load, tab, pages, 0).pipe(
          // A stale load answers null, which `begin` already set.
          tap((result) => {
            if (result) this.lastLoadState.set(result);
          }),
        ),
      );
    });
  }

  private clear(): void {
    this.guard.invalidate();
    this.serverRows.set(new Map());
    this.indexRows.set([]);
    this.serverToken.set(null);
    this.indexCursor.set(null);
    this.serverFailed.set(false);
    this.lastLoadState.set(null);
    this.statusState.set('idle');
  }

  private begin(): Load | null {
    const client = this.projection.client();
    const accountId = client?.getUserId();
    if (!client || !accountId) return null;
    this.lastLoadState.set(null);
    this.statusState.set('loading');
    return {
      client,
      accountId,
      token: this.guard.next(),
      useIndex: this.preferences.recordAllowed(),
    };
  }

  /** Settles before answering, and also when the subscriber leaves early. */
  private finish(load: Load, work: Observable<unknown>): Observable<void> {
    const settle = (): void => {
      if (this.guard.isCurrent(load.token)) {
        const nothing = !this.all().length && !this.mentions().length;
        this.statusState.set(
          this.serverFailed() && nothing ? 'failed' : 'ready',
        );
      }
    };
    return work.pipe(
      tap({ next: settle }),
      finalize(settle),
      map(() => undefined),
    );
  }

  private takePages(
    load: Load,
    tab: InboxTab,
    pagesLeft: number,
    checked: number,
  ): Observable<InboxLoadResult | null> {
    const rows = tab === 'all' ? this.all : this.mentions;
    const before = rows().length;
    const token = this.serverToken();
    const cursor = this.indexCursor();
    return this.fetch(
      token === null ? EMPTY : this.serverPage(load, token, false),
      tab === 'all' || cursor === null
        ? EMPTY
        : this.indexPage(load, cursor, false),
    ).pipe(
      switchMap((count) => {
        if (!this.guard.isCurrent(load.token)) return of(null);
        if (rows().length > before) return of({ kind: 'found' as const });
        if (this.serverFailed()) return of(null);
        const more = tab === 'all' ? this.serverHasMore() : this.hasMore();
        if (!more) return of({ kind: 'end' as const });
        const total = checked + count;
        return pagesLeft > 1
          ? this.takePages(load, tab, pagesLeft - 1, total)
          : of({ kind: 'limit' as const, checked: total });
      }),
    );
  }

  /**
   * Each source lands as soon as it's judged, so neither waits for the other's answer. Judging
   * one page at a time keeps the decryption limit across the two. Emits how many were checked.
   */
  private fetch(
    ...pages: readonly Observable<Observable<number>>[]
  ): Observable<number> {
    return merge(...pages).pipe(
      concatMap((judgeAndLand) => judgeAndLand),
      reduce((sum, count) => sum + count, 0),
    );
  }

  private serverPage(
    load: Load,
    token: string | null,
    replace: boolean,
  ): Observable<Observable<number>> {
    return defer(() =>
      fetchNotificationsPage(load.client, token, SERVER_PAGE_SIZE),
    ).pipe(
      map(({ entries, nextToken }) =>
        this.judgeAll(load, entries, (entry, flags) =>
          this.judgeEntry(load, flags, entry),
        ).pipe(
          map((judged) => {
            if (this.guard.isCurrent(load.token)) {
              this.forgetDropped(load, judged);
              const rows = shownRows(judged).map(
                (shown) => [shown.row.eventId, shown] as const,
              );
              this.serverRows.update(
                (current) => new Map([...(replace ? [] : current), ...rows]),
              );
              this.serverToken.set(nextToken);
              this.serverFailed.set(false);
            }
            return entries.length;
          }),
        ),
      ),
      catchError(() => {
        if (this.guard.isCurrent(load.token)) this.serverFailed.set(true);
        return EMPTY;
      }),
    );
  }

  private indexPage(
    load: Load,
    before: MentionCursor | null,
    replace: boolean,
  ): Observable<Observable<number>> {
    if (!load.useIndex) return EMPTY;
    return this.mentionIndex.page(load.accountId, before, INDEX_PAGE_SIZE).pipe(
      // A hung store reads as a failed one, and the inbox falls back to the server's list.
      timeout(STEP_LIMIT_MS),
      map((records) =>
        this.judgeAll(load, records, (record, flags) =>
          this.judgeRecord(load, flags, record),
        ).pipe(
          map((judged) => {
            if (this.guard.isCurrent(load.token)) {
              this.forgetDropped(load, judged);
              const rows = shownRows(judged).map(({ row }) => row);
              this.indexRows.update((current) =>
                replace ? rows : [...current, ...rows],
              );
              const last = records.at(-1);
              this.indexCursor.set(
                last && records.length >= INDEX_PAGE_SIZE ? last : null,
              );
            }
            return records.length;
          }),
        ),
      ),
      catchError(() => {
        if (this.guard.isCurrent(load.token)) this.indexCursor.set(null);
        return EMPTY;
      }),
    );
  }

  /** Stops starting work once the load is stale; unsubscribing cancels it outright. */
  private judgeAll<T extends { readonly roomId: string }>(
    load: Load,
    items: readonly T[],
    judge: (item: T, flags: RoomEncryptionFlags) => ObservableInput<Judged>,
  ): Observable<readonly Judged[]> {
    return defer(() => this.encryptionFlags(load, items)).pipe(
      switchMap((flags) =>
        from(items).pipe(
          mergeMap((item) => judge(item, flags), MAX_CONCURRENT_DECRYPTIONS),
          takeWhile(() => this.guard.isCurrent(load.token)),
          toArray(),
        ),
      ),
    );
  }

  /** Asked up front: a concurrent `refresh` for the same room answers without waiting. */
  private async encryptionFlags(
    load: Load,
    items: readonly { readonly roomId: string }[],
  ): Promise<RoomEncryptionFlags> {
    const flags = new RoomEncryptionFlags();
    const crypto = load.client.getCrypto();
    const rooms = new Set(items.map((item) => item.roomId));
    await Promise.all([...rooms].map((id) => flags.refresh(crypto, id)));
    return flags;
  }

  private judgeEntry(
    load: Load,
    flags: RoomEncryptionFlags,
    entry: NotificationEntry,
  ): Promise<Judged> {
    return this.judge(
      load,
      flags,
      entry,
      () => !entry.read,
      () =>
        Promise.resolve({
          kind: 'found',
          event: mapInboxEvent(load.client, entry.raw, entry.roomId),
        }),
    );
  }

  private judgeRecord(
    load: Load,
    flags: RoomEncryptionFlags,
    record: MentionRecord,
  ): Promise<Judged> {
    // Live sync recorded this, and the view puts event IDs in a CSS selector.
    if (!isPlainEventId(record.eventId)) {
      return Promise.resolve({ kind: 'skipped' });
    }
    return this.judge(
      load,
      flags,
      record,
      (room) => !room?.hasUserReadEvent(load.accountId, record.eventId),
      () => lookUpIndexedEvent(load.client, record.roomId, record.eventId),
    );
  }

  private async judge(
    load: Load,
    flags: RoomEncryptionFlags,
    at: {
      readonly eventId: string;
      readonly roomId: string;
      readonly ts: number;
    },
    unread: (room: Room | null) => boolean,
    read: () => Promise<IndexedEventLookup>,
  ): Promise<Judged> {
    const { client, accountId } = load;
    const { eventId, roomId, ts } = at;
    const shown = (
      preview: InboxPreview,
      room: Room | null,
      senderName: string | null = null,
      threadRootId: string | null = null,
      highlighted = false,
      undecryptable = false,
    ): Judged => ({
      kind: 'shown',
      highlighted,
      undecryptable,
      row: {
        accountId,
        eventId,
        roomId,
        roomName: room?.name || roomId,
        senderName,
        ts,
        preview,
        unread: unread(room),
        threadRootId,
      },
    });
    const unavailable = (): Judged =>
      shown({ kind: 'unavailable' }, client.getRoom(roomId));
    const synced = (): boolean =>
      isServerSync(client.getSyncState(), client.getSyncStateData());
    // Before a sync with the server a room can merely look absent, so nothing is deleted yet.
    const gone = (): Judged =>
      synced() ? { kind: 'dropped', eventId } : unavailable();

    try {
      if (synced() && client.getRoom(roomId)?.getMyMembership() !== 'join') {
        return gone();
      }
      const found = await read();
      if (found.kind === 'gone') return gone();
      if (found.kind === 'unreachable') return unavailable();

      const senderId = found.event.getSender() ?? '';
      if (client.isUserIgnored(senderId)) return { kind: 'skipped' };

      const check = await checkInboxEvent(client, found.event);
      if (check.kind === 'dropped') return gone();

      const { event } = check;
      const room = client.getRoom(roomId);
      const rootId = event.threadRootId;
      const threadRootId =
        rootId !== eventId && isPlainEventId(rootId) ? rootId : null;
      const senderName = room?.getMember(senderId)?.name ?? (senderId || null);
      if (check.kind === 'undecryptable') {
        return shown(
          { kind: 'encrypted' },
          room,
          senderName,
          threadRootId,
          false,
          true,
        );
      }
      return shown(
        room
          ? inboxPreview(
              this.text?.mode() ?? 'show',
              normalizeNotificationEvent(
                accountId,
                event,
                room,
                // A store that couldn't answer may mean encrypted, and this load won't re-ask.
                flags.isEncrypted(room) || !flags.answered(roomId),
              ).body,
            )
          : { kind: 'unavailable' },
        room,
        senderName,
        threadRootId,
        check.highlighted,
      );
    } catch {
      return unavailable();
    }
  }

  /** Not waited for: the view must not depend on the store's answer. */
  private forgetDropped(load: Load, judged: readonly Judged[]): void {
    const eventIds = judged.flatMap((result) =>
      result.kind === 'dropped' ? [result.eventId] : [],
    );
    if (load.useIndex && eventIds.length) {
      this.mentionIndex
        .forget(load.accountId, eventIds)
        .subscribe({ error: () => undefined });
    }
  }
}
