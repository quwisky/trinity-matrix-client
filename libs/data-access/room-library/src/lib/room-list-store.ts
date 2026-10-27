import {
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import {
  SESSION_ENGINE,
  type SessionAccountStatus,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import {
  type VectorDiff,
  applyVectorDiffs,
  plainEqual,
} from '@trinity/util/matrix';
import type { RoomInfo, TypingMember } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';

type TypingMap = Readonly<Record<string, readonly TypingMember[]>>;
type DirectMap = Readonly<Record<string, readonly string[]>>;

interface Feed {
  readonly generation: number;
  readonly subscription: Subscription;
  rows: readonly RoomInfo[];
  byId: ReadonlyMap<string, RoomInfo>;
  typing: TypingMap;
  directMap: DirectMap;
}

const NO_ROOMS: readonly RoomInfo[] = [];
const NO_TYPING: TypingMap = {};
const NO_DIRECT: DirectMap = {};

/** Applies `diffs`, keeping each content-equal row and, when nothing changed, the list itself. */
function fold(
  previous: readonly RoomInfo[],
  diffs: readonly VectorDiff<RoomInfo>[],
): readonly RoomInfo[] {
  const next = applyVectorDiffs(previous, diffs);
  if (next === previous) return previous;
  const old = new Map(previous.map((room) => [room.roomId, room]));
  let unchanged = next.length === previous.length;
  const rows = next.map((room, index) => {
    const kept = old.get(room.roomId);
    const row = kept && plainEqual(kept, room) ? kept : room;
    if (row !== previous[index]) unchanged = false;
    return row;
  });
  return unchanged ? previous : rows;
}

/**
 * One room list subscription per live account and generation.
 * Each read reconciles the subscriptions with the session snapshot first, so an engine that
 * emits on subscribe has filled an account's rows by the time the read that saw it go live returns.
 */
@Injectable({ providedIn: 'root' })
export class RoomListStore {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly feeds = new Map<string, Feed>();
  /** Bumped by emissions after the first, which arrive outside any reactive read. */
  private readonly version = signal(0);
  private readonly roomViews = new Map<string, Signal<readonly RoomInfo[]>>();
  private readonly typingViews = new Map<string, Signal<TypingMap>>();
  private readonly directViews = new Map<string, Signal<DirectMap>>();
  private reconciledFor: readonly SessionAccountStatus[] | null = null;
  private opening = false;

  readonly liveAccountIds: Signal<readonly string[]> = this.session.accountIds;

  constructor() {
    // Closes the feeds of accounts that left even when nothing reads the store any more.
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() =>
        untracked(() => this.reconcile(this.session.snapshot().accounts)),
      );
    inject(DestroyRef).onDestroy(() => {
      for (const feed of this.feeds.values()) feed.subscription.unsubscribe();
      this.feeds.clear();
    });
  }

  /** Empty, with one shared reference, for an account that is not live. */
  rooms(accountId: string): Signal<readonly RoomInfo[]> {
    return this.view(this.roomViews, accountId, (f) => f?.rows ?? NO_ROOMS);
  }

  room(accountId: string, roomId: string): RoomInfo | null {
    return this.read(accountId)?.byId.get(roomId) ?? null;
  }

  typing(accountId: string): Signal<TypingMap> {
    return this.view(
      this.typingViews,
      accountId,
      (f) => f?.typing ?? NO_TYPING,
    );
  }

  directMap(accountId: string): Signal<DirectMap> {
    return this.view(
      this.directViews,
      accountId,
      (f) => f?.directMap ?? NO_DIRECT,
    );
  }

  private view<T>(
    cache: Map<string, Signal<T>>,
    accountId: string,
    pick: (feed: Feed | undefined) => T,
  ): Signal<T> {
    let view = cache.get(accountId);
    if (!view) {
      view = computed(() => pick(this.read(accountId)));
      cache.set(accountId, view);
    }
    return view;
  }

  private read(accountId: string): Feed | undefined {
    const accounts = this.session.snapshot().accounts;
    this.version();
    // Subscribing inside the read lets a synchronous engine fill an account in the turn it goes live.
    untracked(() => this.reconcile(accounts));
    return this.feeds.get(accountId);
  }

  private reconcile(accounts: readonly SessionAccountStatus[]): void {
    if (accounts === this.reconciledFor) return;
    this.reconciledFor = accounts;
    const live = new Map(accounts.map((a) => [a.accountId, a.generation]));
    for (const [accountId, feed] of this.feeds) {
      if (live.get(accountId) === feed.generation) continue;
      feed.subscription.unsubscribe();
      this.feeds.delete(accountId);
    }
    this.opening = true;
    try {
      for (const [accountId, generation] of live) {
        if (!this.feeds.has(accountId)) this.open(accountId, generation);
      }
    } finally {
      this.opening = false;
    }
  }

  private open(accountId: string, generation: number): void {
    const feed: Feed = {
      generation,
      subscription: new Subscription(),
      rows: NO_ROOMS,
      byId: new Map(),
      typing: NO_TYPING,
      directMap: NO_DIRECT,
    };
    this.feeds.set(accountId, feed);
    feed.subscription.add(
      this.engine.rooms(accountId).subscribe((diffs) => {
        const rows = fold(feed.rows, diffs);
        if (rows === feed.rows) return;
        feed.rows = rows;
        feed.byId = new Map(rows.map((room) => [room.roomId, room]));
        this.changed();
      }),
    );
    feed.subscription.add(
      this.engine.typing(accountId).subscribe((typing) => {
        feed.typing = typing;
        this.changed();
      }),
    );
    feed.subscription.add(
      this.engine.directMap(accountId).subscribe((directMap) => {
        feed.directMap = directMap;
        this.changed();
      }),
    );
  }

  private changed(): void {
    if (!this.opening) this.version.update((v) => v + 1);
  }
}
