import {
  Injectable,
  InjectionToken,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { defer, map, of, type Observable, type Subscription } from 'rxjs';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import type { EngineFailure } from '@trinity/util/matrix';
import type { PinnedEntry, PinnedEvents } from './conversation-content-engine';
import { CONVERSATION_CONTENT_ENGINE } from './conversation-content-engine.token';
import type { ConversationKey } from './conversation-messages';
import type {
  ConversationPinOperation,
  ConversationPinOutcome,
  ConversationPinPolicy,
  ConversationPins,
  PinnedMessageView,
} from './conversation-pins';
import { unencryptedShield } from './shield-presentation';
import { profileName } from './timeline-item-presentation';
import { TimelineStores } from './timeline-store';

const unavailablePolicy: ConversationPinPolicy = {
  canMutate: () => false,
  authorize: () => ({
    kind: 'rejected',
    failure: 'conversation-unavailable',
  }),
};

export const CONVERSATION_PIN_POLICY =
  new InjectionToken<ConversationPinPolicy>(
    'conversation-runtime.room-administration-pin-policy',
    { providedIn: 'root', factory: () => unavailablePolicy },
  );

/**
 * Whether a failed pin write is worth retrying: a lost connection, rate limiting or a server
 * error, as `isTransientMatrixError` judged the raw error.
 */
function retryable(failure: EngineFailure): boolean {
  if (failure.code !== 'request-failed') return false;
  if (failure.kind === 'network')
    return failure.params?.cause !== 'session-refresh';
  return failure.kind === 'rate-limit' || failure.kind === 'server';
}

function viewOf(entry: PinnedEntry): PinnedMessageView {
  return Object.freeze({
    id: entry.eventId,
    status: entry.status,
    sender: entry.sender,
    senderName: entry.sender
      ? profileName(entry.sender, entry.profiles[entry.sender])
      : '',
    body: entry.body,
    ts: entry.ts,
    shield: unencryptedShield(entry.unencryptedMark),
  });
}

/** Package-internal exact-Conversation projection of the engine's pinned events. */
@Injectable()
export class ConversationPinsController implements ConversationPins {
  private readonly engine = inject(CONVERSATION_CONTENT_ENGINE);
  private readonly policy = inject(CONVERSATION_PIN_POLICY);
  private readonly session = inject(SessionStateService);
  private readonly stores = inject(TimelineStores);
  private readonly pinnedEventIds = signal<readonly string[]>([]);
  private allEventIds: readonly string[] = [];
  private readonly pinnedMessages = signal<readonly PinnedMessageView[]>([]);
  private readonly mayMutate = signal(false);
  private key: ConversationKey | null = null;
  private generation: number | null = null;
  private subscription: Subscription | null = null;
  /** Whether the feed has emitted since it opened, so `isPinned` can be trusted. */
  private loaded = false;

  readonly eventIds = this.pinnedEventIds.asReadonly();
  readonly messages = this.pinnedMessages.asReadonly();
  readonly canMutate = this.mayMutate.asReadonly();

  constructor() {
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() => untracked(() => this.follow()));
  }

  attach(key: ConversationKey): void {
    this.release();
    this.key = Object.freeze({ ...key });
    this.follow();
  }

  resources(): { listenerCount: number; retainedBytes: number } {
    return {
      // Approximate: the js-sdk feed's room-state, timeline and decryption listeners.
      listenerCount: this.subscription ? 3 : 0,
      retainedBytes:
        this.pinnedEventIds().length * 8 + this.pinnedMessages().length * 8,
    };
  }

  release(): void {
    this.key = null;
    this.generation = null;
    this.close();
  }

  /** Re-fetch pins whose fetch failed; `unavailable` pins stay final. */
  retryFailed(): void {
    const key = this.key;
    if (!key || !this.subscription) return;
    if (!this.pinnedMessages().some((view) => view.status === 'failed')) {
      return;
    }
    // Replies at once and cannot fail in a way worth showing; the feed carries the result.
    this.engine.retryFailedPins(key.accountId, key.roomId).subscribe();
  }

  isPinned(eventId: string): boolean {
    return this.allEventIds.includes(eventId);
  }

  pin(eventId: string): Observable<ConversationPinOutcome> {
    return defer(() => {
      if (!this.key) {
        return of(this.rejected('pin', 'conversation-unavailable', false));
      }
      if (this.isPinned(eventId)) return of(this.applied('pin'));
      return this.write('pin', eventId);
    });
  }

  unpin(eventId: string): Observable<ConversationPinOutcome> {
    return defer(() => {
      if (!this.key) {
        return of(this.rejected('unpin', 'conversation-unavailable', false));
      }
      // Before the list is known, "not pinned" would be a guess.
      if (!this.loaded) {
        return of(this.rejected('unpin', 'conversation-unavailable', false));
      }
      if (!this.isPinned(eventId)) return of(this.applied('unpin'));
      return this.write('unpin', eventId);
    });
  }

  private write(
    operation: ConversationPinOperation,
    eventId: string,
  ): Observable<ConversationPinOutcome> {
    const key = this.key;
    if (!key) {
      return of(this.rejected(operation, 'conversation-unavailable', false));
    }
    const senderId = this.senderOf(key, eventId);
    // Pinning must name a message this exact Conversation can resolve. Unpinning is
    // intentionally allowed for an unloaded/redacted event so stale state can still
    // be repaired instead of trapping an unremovable id in m.room.pinned_events.
    if (operation === 'pin' && senderId === null) {
      return of(this.rejected(operation, 'message-unavailable', false));
    }
    const decision = this.policy.authorize(
      { key, messageId: eventId, senderId },
      operation,
    );
    if (decision.kind === 'rejected') {
      return of(this.rejected(operation, decision.failure, false));
    }
    const { accountId, roomId } = key;
    return this.engine[operation](accountId, roomId, eventId).pipe(
      map((result) => {
        if (result.ok) return this.applied(operation);
        const { failure } = result;
        return failure.code === 'account-not-live' ||
          failure.code === 'message-unavailable'
          ? this.rejected(operation, 'conversation-unavailable', false)
          : this.rejected(operation, 'request-rejected', retryable(failure));
      }),
    );
  }

  /** The sender of `eventId` among the room's live items, or null. */
  private senderOf(key: ConversationKey, eventId: string): string | null {
    const { store, release } = this.stores.hold(key, { kind: 'live' });
    const item = untracked(store.items).find(
      (candidate) =>
        candidate.kind === 'event' && candidate.eventId === eventId,
    );
    release();
    return item?.kind === 'event' ? item.sender : null;
  }

  /** Subscribes for the account's live generation, or closes the feed when it has none. */
  private follow(): void {
    const key = this.key;
    if (!key) return;
    const generation =
      this.session
        .snapshot()
        .accounts.find((account) => account.accountId === key.accountId)
        ?.generation ?? null;
    if (generation === this.generation) return;
    this.generation = generation;
    if (generation === null) this.close();
    else this.subscribe();
  }

  private subscribe(): void {
    const key = this.key;
    if (!key) return;
    this.subscription?.unsubscribe();
    this.loaded = false;
    const subscription = this.engine
      .pinnedEvents(key.accountId, key.roomId)
      .subscribe({
        next: (pins) => this.show(key, pins),
        // Engine streams should not error; one that does leaves nothing stale on screen.
        error: () => this.close(),
      });
    // A synchronous error has already closed the feed.
    this.subscription = subscription.closed ? null : subscription;
  }

  private show(key: ConversationKey, pins: PinnedEvents): void {
    const views = pins.entries.map(viewOf);
    this.loaded = true;
    this.allEventIds = pins.allEventIds;
    this.pinnedEventIds.set(Object.freeze([...pins.eventIds]));
    this.pinnedMessages.set(Object.freeze(views));
    this.mayMutate.set(this.policy.canMutate(key));
  }

  private close(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.loaded = false;
    this.allEventIds = [];
    this.pinnedEventIds.set([]);
    this.pinnedMessages.set([]);
    this.mayMutate.set(false);
  }

  private applied(operation: ConversationPinOperation): ConversationPinOutcome {
    return { kind: 'applied', operation };
  }

  private rejected(
    operation: ConversationPinOperation,
    failure: Extract<ConversationPinOutcome, { kind: 'rejected' }>['failure'],
    retryable: boolean,
  ): ConversationPinOutcome {
    return { kind: 'rejected', operation, failure, retryable };
  }
}
