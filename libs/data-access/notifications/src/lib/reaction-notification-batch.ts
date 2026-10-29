import {
  EMPTY,
  type Observable,
  Subscription,
  catchError,
  defer,
  finalize,
  timeout,
} from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';
import type { ReactionAnnotation, ReactionTarget } from './notification-engine';
import type { ReactionNotificationEvent } from './notification-intent';

export interface ReactionNotificationBatchOptions {
  readonly accountId: string;
  readonly allowed: (roomId: string, senderId: string) => boolean;
  /** The account's `NotificationEngine.reactionTarget`. */
  readonly lookup: (
    roomId: string,
    targetEventId: string,
    reactionIds: readonly string[],
  ) => Observable<EngineResult<ReactionTarget | null>>;
  readonly present: (event: ReactionNotificationEvent) => void;
}

interface PendingReactions {
  readonly roomId: string;
  readonly roomName: string | null;
  readonly targetId: string;
  readonly started: number;
  readonly reactions: Map<string, ReactionAnnotation>;
  timer: ReturnType<typeof setTimeout> | null;
  lookup: Subscription | null;
}

const QUIET_WINDOW_MS = 2000;
const MAX_BURST_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_BATCHES = 100;
const MAX_REACTIONS_PER_BATCH = 100;
const MAX_SEEN_EVENTS = 500;

/** Transient reaction work owned by one exact account/session notification lifetime. */
export class ReactionNotificationBatch {
  private readonly pending = new Map<string, PendingReactions>();
  private readonly seen = new Set<string>();
  private disposed = false;

  constructor(private readonly options: ReactionNotificationBatchOptions) {}

  add(reaction: ReactionAnnotation): void {
    if (!this.eligible(reaction)) return;
    if (this.seen.has(reaction.eventId)) return;
    this.seen.add(reaction.eventId);
    if (this.seen.size > MAX_SEEN_EVENTS) {
      this.seen.delete(this.seen.values().next().value!);
    }

    const key = `${reaction.roomId} ${reaction.targetEventId}`;
    let batch = this.pending.get(key);
    if (!batch) {
      if (this.pending.size >= MAX_BATCHES) return;
      batch = {
        roomId: reaction.roomId,
        roomName: reaction.roomName,
        targetId: reaction.targetEventId,
        started: Date.now(),
        reactions: new Map(),
        timer: null,
        lookup: null,
      };
      this.pending.set(key, batch);
    }
    if (batch.reactions.size >= MAX_REACTIONS_PER_BATCH) return;
    batch.reactions.set(reaction.eventId, reaction);
    // A target lookup already in progress consumes the whole batch when it finishes.
    if (batch.lookup) return;
    if (batch.timer !== null) clearTimeout(batch.timer);
    const delay = Math.max(
      0,
      Math.min(QUIET_WINDOW_MS, MAX_BURST_MS - (Date.now() - batch.started)),
    );
    batch.timer = setTimeout(() => this.flush(key, batch), delay);
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.pending.values()) {
      if (batch.timer !== null) clearTimeout(batch.timer);
      batch.lookup?.unsubscribe();
    }
    this.pending.clear();
    this.seen.clear();
  }

  private eligible(reaction: ReactionAnnotation): boolean {
    try {
      return (
        !this.disposed &&
        reaction.accountId === this.options.accountId &&
        this.options.allowed(reaction.roomId, reaction.senderId)
      );
    } catch {
      return false;
    }
  }

  private flush(key: string, batch: PendingReactions): void {
    batch.timer = null;
    if (this.disposed || this.pending.get(key) !== batch) return;
    const lookup = new Subscription();
    batch.lookup = lookup;
    const asked = new Set<string>();
    lookup.add(
      defer(() => {
        for (const reaction of batch.reactions.values()) {
          if (this.eligible(reaction)) asked.add(reaction.eventId);
        }
        if (asked.size === 0) return EMPTY;
        return this.options.lookup(batch.roomId, batch.targetId, [...asked]);
      })
        .pipe(
          timeout(LOOKUP_TIMEOUT_MS),
          // A missing target or key is not a failure of the host presentation capability.
          catchError(() => EMPTY),
          finalize(() => {
            if (this.pending.get(key) === batch) this.pending.delete(key);
            batch.lookup = null;
          }),
        )
        .subscribe((result) => {
          if (result.ok && result.value) {
            this.presentBatch(batch, asked, result.value);
          }
        }),
    );
  }

  /** Reactions added during the lookup were not `asked` about; they count while eligible. */
  private presentBatch(
    batch: PendingReactions,
    asked: ReadonlySet<string>,
    target: ReactionTarget,
  ): void {
    if (this.disposed) return;
    const live = new Set(target.liveReactionIds);
    const senders = new Map<string, string>();
    const keys = new Set<string>();
    for (const reaction of batch.reactions.values()) {
      const dropped =
        asked.has(reaction.eventId) && !live.has(reaction.eventId);
      if (dropped || !this.eligible(reaction)) continue;
      senders.set(reaction.senderId, reaction.senderName);
      keys.add(reaction.key);
    }
    const first = senders.entries().next().value;
    if (!first) return;
    this.options.present(
      Object.freeze({
        kind: 'reaction',
        accountId: this.options.accountId,
        roomId: batch.roomId,
        eventId: batch.targetId,
        senderId: first[0],
        senderName: first[1],
        senderCount: senders.size,
        reactionKeys: Object.freeze([...keys]),
        roomName: batch.roomName,
        body: target.body,
      }),
    );
  }
}
