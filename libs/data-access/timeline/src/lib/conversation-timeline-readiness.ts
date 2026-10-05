import {
  Injectable,
  computed,
  effect,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { ClientEvent, SyncState, type MatrixClient } from 'matrix-js-sdk';
import type { Subscription } from 'rxjs';
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
  | 'open'
  | 'setVisible'
  | 'messages'
  | 'canLoadOlder'
  | 'loadOlder'
  | 'loadingOlder'
>;

/** Pages of history fetched for an empty Room before it settles `empty`. */
const BACKFILL_PAGE_CAP = 3;

type Phase =
  | { readonly kind: 'room-pending' }
  | { readonly kind: 'initial-sync' }
  | { readonly kind: 'backfill' }
  | Exclude<TimelineLoadState, { readonly kind: 'loading' }>;

const isSynced = (state: SyncState | null): boolean =>
  state === SyncState.Prepared || state === SyncState.Syncing;
const isStopped = (state: SyncState | null): boolean =>
  state === SyncState.Stopped || state === SyncState.Error;

/**
 * The lifecycle-backed loading interval of one Conversation's main timeline (#545).
 *
 * `TimelineService.open()` projects whatever the SDK holds, synchronously, so an empty
 * list cannot say "loading". This owns the three real waits — the Room not yet in the
 * Account's client, the Account's first sync, and the first backfill of a Room with
 * nothing displayable — and names every outcome. One instance lives in each
 * Conversation's injector and is stopped on release, so a previous Room can never
 * publish into the focused one.
 *
 * Only a never-synced Account (`getSyncState() === null`) waits for sync; transient
 * states (Reconnecting, Catchup, Error) never block an Account that already synced.
 * After `sync-stopped` a listener stays attached and re-runs on Prepared/Syncing.
 *
 * A capped `empty` does not return to `ready` if the list's own paging later loads
 * displayable messages: the rows still render, the state only stops claiming loading.
 */
@Injectable()
export class ConversationTimelineReadiness {
  private readonly phase = signal<Phase>(READY_LOAD_STATE);
  private readonly timelineRef = signal<ReadinessTimeline | null>(null);
  private roomId = '';
  private client: MatrixClient | null = null;
  private detach: (() => void) | null = null;
  private backfill: Subscription | null = null;
  private page = 0;
  private visible = true;
  private stopped = false;

  constructor() {
    effect(() => {
      const timeline = this.timelineRef();
      timeline?.loadingOlder();
      timeline?.messages();
      timeline?.canLoadOlder();
      untracked(() => this.nextPage());
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

  start(
    roomId: string,
    client: MatrixClient,
    timeline: ReadinessTimeline,
  ): void {
    this.roomId = roomId;
    this.client = client;
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
    const client = this.client;
    const timeline = this.timelineRef();
    if (!client || !timeline || this.stopped) return;
    if (!client.getRoom(this.roomId)) {
      this.waitForRoom(client);
      return;
    }
    timeline.open(this.roomId, client);
    // open() forces visible; a hidden Conversation must not mark read or bypass compaction.
    if (!this.visible) timeline.setVisible(false);
    if (client.getSyncState() === null) {
      this.waitForSync(client);
      return;
    }
    this.settle();
  }

  private waitForRoom(client: MatrixClient): void {
    if (isStopped(client.getSyncState())) {
      this.fail('sync-stopped');
      return;
    }
    this.phase.set({ kind: 'room-pending' });
    const onRoom = (): void => {
      if (client.getRoom(this.roomId)) this.run();
    };
    const onSync = (state: SyncState): void => {
      if (isStopped(state)) this.fail('sync-stopped');
      else if (isSynced(state) && !client.getRoom(this.roomId))
        this.fail('room-unavailable');
      // Reconnecting / Catchup: keep waiting.
    };
    this.listen(client, onRoom, onSync);
  }

  private waitForSync(client: MatrixClient): void {
    this.phase.set({ kind: 'initial-sync' });
    const onSync = (state: SyncState): void => {
      if (isStopped(state)) this.fail('sync-stopped');
      else if (isSynced(state)) {
        this.cancel();
        this.settle();
      }
    };
    this.listen(client, null, onSync);
  }

  private listen(
    client: MatrixClient,
    onRoom: (() => void) | null,
    onSync: (state: SyncState) => void,
  ): void {
    if (onRoom) client.on(ClientEvent.Room, onRoom);
    client.on(ClientEvent.Sync, onSync);
    this.detach = () => {
      if (onRoom) client.off(ClientEvent.Room, onRoom);
      client.off(ClientEvent.Sync, onSync);
    };
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
    const client = this.client;
    if (reason === 'sync-stopped' && client) {
      // The SDK keeps retrying after Error; recover when sync is running again.
      this.listen(client, null, (state) => {
        if (isSynced(state)) this.run();
      });
    }
  }

  private cancel(): void {
    this.detach?.();
    this.detach = null;
    this.backfill?.unsubscribe();
    this.backfill = null;
  }
}
