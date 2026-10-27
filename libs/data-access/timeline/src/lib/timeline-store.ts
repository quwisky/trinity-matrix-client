import {
  DestroyRef,
  Injectable,
  type Signal,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import {
  type PresentedMediaReference,
  MediaPipeline,
} from '@trinity/data-access/media';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import {
  type MediaPayload,
  applyVectorDiffs,
  plainEqual,
} from '@trinity/util/matrix';
import type { ConversationKey } from './conversation-messages';
import {
  type MessageView,
  presentNormalizedTimelineEvent,
} from './message-presentation';
import type {
  EventTimelineItem,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  TimelineRoomState,
  TimelineUpdate,
} from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { normalizedFromItem } from './timeline-item-presentation';

/** Items a hidden conversation keeps presented. */
export const RETAINED_EVENT_LIMIT = 100;

type BackPagination = 'idle' | 'paginating' | 'start-reached';

interface PresentedRow {
  readonly item: EventTimelineItem;
  readonly view: MessageView | null;
}

const NO_ITEMS: readonly TimelineItem[] = [];
const NO_VIEWS: readonly MessageView[] = [];

function sameElements<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * One conversation's timeline, folded from its engine stream. Built and fed by
 * {@link TimelineStores}, which follows the account's session.
 */
export class TimelineStore {
  private readonly _items = signal(NO_ITEMS);
  private readonly _messages = signal(NO_VIEWS, { equal: sameElements });
  private readonly _backPagination = signal<BackPagination>('idle');
  private readonly _room = signal<TimelineRoomState | null>(null);
  private readonly _available = signal(false);
  private readonly _firstUnreadId = signal<string | null>(null);
  private subscription: Subscription | null = null;
  private generation: number | null = null;
  private visible = true;
  private closed = false;
  private rows = new Map<string, PresentedRow>();
  private rowsEncrypted = false;
  /** Frozen at the first read marker seen, so later marker moves leave the divider put. */
  private unreadAnchor: { uniqueId: string; inclusive: boolean } | null = null;

  readonly items: Signal<readonly TimelineItem[]> = this._items.asReadonly();
  readonly messages: Signal<readonly MessageView[]> =
    this._messages.asReadonly();
  readonly backPagination: Signal<BackPagination> =
    this._backPagination.asReadonly();
  readonly room: Signal<TimelineRoomState | null> = this._room.asReadonly();
  readonly available: Signal<boolean> = this._available.asReadonly();
  readonly firstUnreadId: Signal<string | null> =
    this._firstUnreadId.asReadonly();

  constructor(
    readonly key: ConversationKey,
    readonly focus: TimelineFocus,
    private readonly engine: TimelineEngine,
    private readonly presentMedia: (
      media: MediaPayload,
    ) => PresentedMediaReference,
    private readonly onClose: (store: TimelineStore) => void,
  ) {}

  item(eventId: string): EventTimelineItem | null {
    for (const item of this._items()) {
      if (item.kind === 'event' && item.eventId === eventId) return item;
    }
    return null;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.present();
  }

  close(): void {
    if (this.closed) return;
    this.follow(null);
    this.closed = true;
    this.onClose(this);
  }

  /** Subscribes for the account's live `generation`, or closes the feed when it is `null`. */
  follow(generation: number | null): void {
    if (this.closed || generation === this.generation) return;
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.generation = generation;
    if (generation === null) {
      this.clear();
      return;
    }
    const { accountId, roomId } = this.key;
    this.subscription = this.engine
      .timeline(accountId, roomId, this.focus)
      .subscribe({
        next: (update) => this.fold(update),
        // Engine streams should not error; one that does leaves nothing stale on screen.
        error: () => this.clear(),
      });
  }

  private fold(update: TimelineUpdate): void {
    if (update.kind === 'room-unavailable') {
      this.clear();
      return;
    }
    const items = applyVectorDiffs(this._items(), update.diffs);
    this._items.set(items);
    this._room.set(update.room);
    this._backPagination.set(update.backPagination);
    this._available.set(true);
    this._firstUnreadId.set(this.firstUnread(items));
    this.present();
  }

  private clear(): void {
    this._items.set(NO_ITEMS);
    this._room.set(null);
    this._backPagination.set('idle');
    this._available.set(false);
    this._firstUnreadId.set(null);
    this.present();
  }

  /** Presents the items, keeping each row whose item is `===` or `plainEqual` to the last one. */
  private present(): void {
    const items = untracked(this._items);
    const encrypted =
      untracked(this._room)?.hasEncryptionStateEvent ?? this.rowsEncrypted;
    const previous = encrypted === this.rowsEncrypted ? this.rows : null;
    this.rowsEncrypted = encrypted;
    // Hidden, only the newest events are presented; virtual items take no slot.
    let skipped = this.visible
      ? 0
      : Math.max(
          0,
          items.filter((item) => item.kind === 'event').length -
            RETAINED_EVENT_LIMIT,
        );
    const room = {
      roomId: this.key.roomId,
      encrypted,
      viewerId: this.key.accountId,
    };
    const rows = new Map<string, PresentedRow>();
    const views: MessageView[] = [];
    for (const item of items) {
      if (item.kind !== 'event') continue;
      const kept = previous?.get(item.uniqueId);
      if (skipped > 0) {
        skipped--;
        // Keep the row so showing the window again reuses its view.
        if (kept) rows.set(item.uniqueId, kept);
        continue;
      }
      const row: PresentedRow =
        kept && (kept.item === item || plainEqual(kept.item, item))
          ? { item, view: kept.view }
          : {
              item,
              view: presentNormalizedTimelineEvent(
                normalizedFromItem(item, room),
                this.presentMedia,
              ),
            };
      rows.set(item.uniqueId, row);
      if (row.view) views.push(row.view);
    }
    this.rows = rows;
    this._messages.set(views);
  }

  /** The first message from someone else after the frozen anchor. */
  private firstUnread(items: readonly TimelineItem[]): string | null {
    if (!this.unreadAnchor) {
      const marker = items.findIndex((item) => item.kind === 'readMarker');
      if (marker < 0) return null;
      const before = items[marker - 1];
      const after = items[marker + 1];
      if (before)
        this.unreadAnchor = { uniqueId: before.uniqueId, inclusive: false };
      else if (after)
        this.unreadAnchor = { uniqueId: after.uniqueId, inclusive: true };
      else return null;
    }
    const { uniqueId, inclusive } = this.unreadAnchor;
    const anchor = items.findIndex((item) => item.uniqueId === uniqueId);
    if (anchor < 0) return null;
    for (let i = inclusive ? anchor : anchor + 1; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'event' && !item.isOwn && item.content.kind !== 'state')
        return item.eventId;
    }
    return null;
  }
}

/**
 * Builds a {@link TimelineStore} per opened conversation and keeps each one subscribed for its
 * account's live generation: a new generation resubscribes, and an account that leaves closes
 * the feed.
 */
@Injectable({ providedIn: 'root' })
export class TimelineStores {
  private readonly engine = inject(TIMELINE_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly media = inject(MediaPipeline);
  private readonly stores = new Set<TimelineStore>();

  constructor() {
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() => untracked(() => this.reconcile()));
    inject(DestroyRef).onDestroy(() => {
      for (const store of [...this.stores]) store.close();
    });
  }

  /** Fills the store before returning when the engine emits on subscribe. */
  open(key: ConversationKey, focus: TimelineFocus): TimelineStore {
    const store = new TimelineStore(
      key,
      focus,
      this.engine,
      (media) => this.media.present(media, key.accountId),
      (closed) => this.stores.delete(closed),
    );
    this.stores.add(store);
    untracked(() => store.follow(this.generationOf(key.accountId)));
    return store;
  }

  private reconcile(): void {
    for (const store of this.stores) {
      store.follow(this.generationOf(store.key.accountId));
    }
  }

  private generationOf(accountId: string): number | null {
    return (
      this.session
        .snapshot()
        .accounts.find((account) => account.accountId === accountId)
        ?.generation ?? null
    );
  }
}
