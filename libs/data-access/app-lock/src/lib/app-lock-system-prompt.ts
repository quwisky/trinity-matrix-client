import { computed, signal } from '@angular/core';
import type {
  HostPresenceOutcome,
  HostSystemPresenceUnavailableReason,
  HostUserPresenceService,
} from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  ignoreElements,
  map,
  of,
  shareReplay,
  take,
} from 'rxjs';
import { waitSecondsAfter } from './pin-policy';

/** Which prompt is open: the lock screen's, setup's or a guarded change's. */
export type SystemPromptKind = 'unlock' | 'enable' | 'change';

export interface SystemPromptHooks {
  readonly presence: HostUserPresenceService;
  readonly now: () => number;
  /** Counts locks; an answer to a prompt opened before the latest lock is stale. */
  readonly locks: () => number;
  /**
   * A current verification (no lock since the prompt opened), applied once whether or not
   * anyone still waits: an `unlock` prompt unlocks; a Settings prompt opens the guard window,
   * only if it took effect.
   */
  readonly verified: (kind: SystemPromptKind) => void;
  /** The host says the system prompt cannot run now. */
  readonly unavailable: (reason: HostSystemPresenceUnavailableReason) => void;
}

interface OpenPrompt {
  readonly kind: SystemPromptKind;
  readonly locks: number;
  readonly outcome: Observable<HostPresenceOutcome>;
}

const CANCELLED: HostPresenceOutcome = { kind: 'cancelled' };
const BROKE: HostPresenceOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'app-lock-prompt-failed' },
};

/**
 * App lock's system prompt (internal to `AppLockService`). Never two at once: a call joins
 * an open prompt of the same kind from the same lock, and otherwise waits for it to settle
 * and opens its own. An open prompt stays alive, and holds the away timer through
 * `HostSystemUiService`, while the OS sheet is up, even when every caller has gone. An answer
 * is recorded once; a `verified` from before the latest lock reads as `cancelled`.
 */
export class AppLockSystemPrompt {
  private readonly failures = signal(0);
  private readonly failedAt = signal<number | null>(null);
  /** The deadline the wait timer saw pass; that wait reads as over. */
  private readonly passed = signal<number | null>(null);
  private open: OpenPrompt | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  /** End of Trinity's wait after consecutive failed unlock prompts, or null once it passes. */
  readonly waitUntil = computed(() => {
    const until = this.deadline();
    return until !== null && until !== this.passed() ? until : null;
  });

  constructor(private readonly hooks: SystemPromptHooks) {}

  prompt(
    reason: string,
    kind: SystemPromptKind,
  ): Observable<HostPresenceOutcome> {
    return defer((): Observable<HostPresenceOutcome> => {
      const open = this.open;
      if (!open) return this.start(reason, kind);
      if (open.kind === kind && open.locks === this.hooks.locks()) {
        return open.outcome;
      }
      return concat(
        open.outcome.pipe(
          ignoreElements(),
          catchError(() => EMPTY),
        ),
        this.prompt(reason, kind),
      );
    });
  }

  private start(
    reason: string,
    kind: SystemPromptKind,
  ): Observable<HostPresenceOutcome> {
    const locks = this.hooks.locks();
    const record: { current: OpenPrompt | null } = { current: null };
    const outcome = this.hooks.presence.verify({ reason }).pipe(
      take(1),
      catchError(() => of(BROKE)),
      defaultIfEmpty(CANCELLED),
      map((answer) => {
        // Closed before anyone hears the answer, so a waiting caller opens its own.
        if (this.open === record.current) this.open = null;
        return this.record(answer, kind, locks);
      }),
      // Finite (`take(1)`), so it may outlive its callers: the sheet is still up.
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    record.current = { kind, locks, outcome };
    this.open = record.current;
    return outcome;
  }

  private record(
    outcome: HostPresenceOutcome,
    kind: SystemPromptKind,
    locks: number,
  ): HostPresenceOutcome {
    switch (outcome.kind) {
      case 'verified':
        if (locks !== this.hooks.locks()) return CANCELLED;
        this.failures.set(0);
        this.failedAt.set(null);
        this.hooks.verified(kind);
        return outcome;
      case 'failed':
        // Only the lock screen's prompt feeds Trinity's delay.
        if (kind === 'unlock') {
          this.failures.update((count) => count + 1);
          this.failedAt.set(this.hooks.now());
          this.watchWait();
        }
        return outcome;
      case 'unavailable':
        this.hooks.unavailable(outcome.reason);
        return outcome;
      case 'cancelled':
      case 'locked-out':
      case 'rejected':
        return outcome;
      default: {
        const unhandled: never = outcome;
        void unhandled;
        return outcome;
      }
    }
  }

  private deadline(): number | null {
    const wait = waitSecondsAfter(this.failures());
    const at = this.failedAt();
    return wait > 0 && at !== null ? at + wait * 1000 : null;
  }

  private watchWait(): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const until = this.deadline();
    if (until === null) return;
    this.waitTimer = setTimeout(
      () => {
        this.waitTimer = null;
        this.passed.set(until);
      },
      Math.max(0, until - this.hooks.now()),
    );
  }
}
