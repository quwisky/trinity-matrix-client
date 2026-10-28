import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import {
  SessionStateService,
  type SessionAccountStatus,
} from '@trinity/data-access/matrix-client';
import type { Subscription } from 'rxjs';
import type { ConversationKey } from './conversation-messages';
import type { TimelineService } from './timeline.service';

export type TimelineLoadState =
  | {
      readonly kind: 'loading';
      readonly reason: 'room-pending' | 'initial-sync' | 'backfill';
      /** Displayable messages are already present (only during initial sync). */
      readonly partial: boolean;
    }
  | { readonly kind: 'ready' }
  /** Ready, with the start of the Room reached and nothing displayable. */
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'error';
      readonly reason: 'room-unavailable' | 'sync-stopped' | 'backfill-failed';
    };

export const READY_LOAD_STATE = Object.freeze({ kind: 'ready' } as const);

export type ReadinessTimeline = Pick<
  TimelineService,
  'available' | 'messages' | 'canLoadOlder' | 'loadOlder' | 'loadingOlder'
>;

/** Pages of history fetched for an empty Room before it settles `empty`. */
const BACKFILL_PAGE_CAP = 3;

type Phase =
  | { readonly kind: 'room-pending' }
  | { readonly kind: 'initial-sync' }
  | { readonly kind: 'backfill' }
  | Exclude<TimelineLoadState, { readonly kind: 'loading' }>;

type Status = SessionAccountStatus | null;

const isSynced = (status: Status): boolean =>
  status?.syncState === 'prepared' || status?.syncState === 'syncing';
/**
 * A sync from the server has completed. A `prepared` the client restored from its cache
 * (`roomsPrepared` without `serverSynced`) can predate rooms joined since.
 */
const isLiveSynced = (status: Status): boolean =>
  status?.syncState === 'syncing' ||
  (status?.syncState === 'prepared' && status.serverSynced);
const isStopped = (status: Status): boolean =>
  status?.syncState === 'stopped' || status?.syncState === 'error';

/**
 * The lifecycle-backed loading interval of one Conversation's main timeline.
 *
 * The timeline store projects whatever the engine holds, so an empty list cannot say
 * "loading". This owns the three real waits (the Room not yet available to the Account,
 * the Account's first sync, and the first backfill of a Room with nothing displayable) and
 * names every outcome from the Account's session status. One instance lives in each
 * Conversation's injector and is stopped on release, so a previous Room can never publish
 * into the focused one.
 *
 * Only an Account whose rooms were never prepared waits for sync; transient states
 * (Reconnecting, Catchup, Error) never block an Account that already synced. After
 * `sync-stopped` it keeps watching and re-runs once the Account is prepared or syncing.
 *
 * A capped `empty` does not return to `ready` if the list's own paging later loads
 * displayable messages: the rows still render, the state only stops claiming loading.
 */
@Injectable()
export class ConversationTimelineReadiness {
  private readonly session = inject(SessionStateService);
  private readonly phase = signal<Phase>(READY_LOAD_STATE);
  private readonly timelineRef = signal<ReadinessTimeline | null>(null);
  private key: ConversationKey = { accountId: '', roomId: '' };
  private backfill: Subscription | null = null;
  private page = 0;
  private visible = true;
  private stopped = false;

  constructor() {
    effect(() => {
      const timeline = this.timelineRef();
      if (!timeline) return;
      // Whichever client generation is live: its status is keyed by the account alone.
      const status = this.session.status(this.key.accountId);
      const available = timeline.available();
      timeline.loadingOlder();
      timeline.messages();
      timeline.canLoadOlder();
      untracked(() => this.react(status, available));
    });
  }

  readonly state: Signal<TimelineLoadState> = computed(() => {
    const phase = this.phase();
    switch (phase.kind) {
      case 'room-pending':
      case 'backfill':
        return { kind: 'loading', reason: phase.kind, partial: false };
      case 'initial-sync':
        return {
          kind: 'loading',
          reason: 'initial-sync',
          partial: (this.timelineRef()?.messages().length ?? 0) > 0,
        };
      default:
        return phase;
    }
  });

  /** Follows a timeline the caller has already opened for `key`. */
  start(key: ConversationKey, timeline: ReadinessTimeline): void {
    this.key = key;
    this.timelineRef.set(timeline);
    this.run();
  }

  /** Hidden Conversations cannot page (`loadOlder` no-ops), so backfill waits for focus. */
  setVisible(visible: boolean): void {
    if (this.visible === visible || this.stopped) return;
    this.visible = visible;
    if (this.phase().kind !== 'backfill') return;
    if (visible) {
      this.nextPage();
    } else {
      // A page cancelled by hide never completed, so it must not count toward the cap.
      if (this.backfill) this.page -= 1;
      this.backfill?.unsubscribe();
      this.backfill = null;
    }
  }

  retry(): void {
    if (!this.stopped && this.phase().kind === 'error') this.run();
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private run(): void {
    this.cancel();
    const timeline = this.timelineRef();
    if (!timeline || this.stopped) return;
    const status = this.session.status(this.key.accountId);
    if (!timeline.available()) {
      if (isStopped(status)) this.fail('sync-stopped');
      // Live-synced and still absent: the Room is not on this Account (yet). Say so now
      // rather than after the next long-poll; the error keeps watching for it to arrive.
      else if (isLiveSynced(status)) this.fail('room-unavailable');
      else this.phase.set({ kind: 'room-pending' });
      return;
    }
    if (!status?.roomsPrepared) {
      this.phase.set({ kind: 'initial-sync' });
      return;
    }
    this.settle();
  }

  /** Moves a waiting phase on from the Account's status and the Room's availability. */
  private react(status: Status, available: boolean): void {
    if (this.stopped) return;
    const phase = this.phase();
    switch (phase.kind) {
      case 'room-pending':
        if (available) this.run();
        else if (isStopped(status)) this.fail('sync-stopped');
        else if (isLiveSynced(status)) this.fail('room-unavailable');
        // Reconnecting / Catchup / a prepared restored from the cache: keep waiting.
        return;
      case 'initial-sync':
        // As in run(): an Account whose rooms are prepared has synced, whatever its state now.
        if (status?.roomsPrepared) this.settle();
        else if (isStopped(status)) this.fail('sync-stopped');
        return;
      case 'backfill':
        this.nextPage();
        return;
      case 'error':
        // The SDK keeps retrying after Error; recover when sync is running again. A Room
        // accepted elsewhere, or a late sync: open it as soon as it lands, no Retry needed.
        if (
          (phase.reason === 'sync-stopped' && isSynced(status)) ||
          (phase.reason === 'room-unavailable' && available)
        ) {
          this.run();
        }
        return;
      default:
        return;
    }
  }

  private settle(): void {
    const timeline = this.timelineRef();
    if (!timeline) return;
    if (timeline.messages().length > 0) {
      this.phase.set(READY_LOAD_STATE);
    } else if (!timeline.canLoadOlder()) {
      this.phase.set({ kind: 'empty' });
    } else {
      this.phase.set({ kind: 'backfill' });
      this.page = 0;
      this.nextPage();
    }
  }

  /**
   * Issues one backfill page when nothing is in flight. A page that completes
   * synchronously changed nothing (the service no-ops while hidden or already
   * paging), so it neither counts nor recurses; the effect in the constructor
   * re-evaluates when `loadingOlder`, `messages` or `canLoadOlder` change.
   */
  private nextPage(): void {
    const timeline = this.timelineRef();
    if (
      !timeline ||
      this.stopped ||
      !this.visible ||
      this.phase().kind !== 'backfill' ||
      this.backfill ||
      timeline.loadingOlder()
    ) {
      return;
    }
    this.page += 1;
    let sync = true;
    const sub = timeline.loadOlder().subscribe({
      complete: () => {
        if (this.stopped) return;
        this.backfill = null;
        if (timeline.messages().length > 0) this.phase.set(READY_LOAD_STATE);
        else if (!timeline.canLoadOlder()) this.phase.set({ kind: 'empty' });
        else if (sync) this.page -= 1;
        else if (this.page >= BACKFILL_PAGE_CAP)
          this.phase.set({ kind: 'empty' });
        else this.nextPage();
      },
      error: () => {
        if (!this.stopped) this.fail('backfill-failed');
      },
    });
    sync = false;
    if (!sub.closed) this.backfill = sub;
  }

  private fail(
    reason: Extract<TimelineLoadState, { kind: 'error' }>['reason'],
  ): void {
    if (this.stopped) return;
    this.cancel();
    this.phase.set({ kind: 'error', reason });
  }

  private cancel(): void {
    this.backfill?.unsubscribe();
    this.backfill = null;
  }
}
