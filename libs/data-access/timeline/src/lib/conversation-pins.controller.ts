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
  private readonly pinnedEventIds = signal<readonly string[]>([]);
  private allEventIds: readonly string[] = [];
  private readonly pinnedMessages = signal<readonly PinnedMessageView[]>([]);
  private readonly mayMutate = signal(false);
  private key: ConversationKey | null = null;
  private generation: number | null = null;
  private subscription: Subscription | null = null;
  /** Rows shown before a retry, kept while the fresh subscription loads them again. */
  private held = new Map<string, PinnedMessageView>();

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
      // The js-sdk feed's room-state, timeline and decryption listeners.
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

  /** Re-fetch pins whose fetch failed; a fresh subscription starts with fresh fetches. */
  retryFailed(): void {
    if (!this.pinnedMessages().some((view) => view.status === 'failed')) {
      return;
    }
    this.held = new Map(this.pinnedMessages().map((view) => [view.id, view]));
    this.subscribe();
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
    const decision = this.policy.authorize(key, operation, eventId);
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
    this.subscription = this.engine
      .pinnedEvents(key.accountId, key.roomId)
      .subscribe({
        next: (pins) => this.show(key, pins),
        // Engine streams should not error; one that does leaves nothing stale on screen.
        error: () => this.close(),
      });
  }

  private show(key: ConversationKey, pins: PinnedEvents): void {
    const views = pins.entries.map((entry) => {
      const held = this.held.get(entry.eventId);
      if (entry.status === 'loading' && held) return held;
      this.held.delete(entry.eventId);
      return viewOf(entry);
    });
    this.allEventIds = pins.allEventIds;
    this.pinnedEventIds.set(Object.freeze([...pins.eventIds]));
    this.pinnedMessages.set(Object.freeze(views));
    this.mayMutate.set(this.policy.canMutate(key));
  }

  private close(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.held = new Map();
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
