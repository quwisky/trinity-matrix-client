import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Observable,
  Subject,
  defer,
  firstValueFrom,
  startWith,
  switchMap,
  take,
} from 'rxjs';
import {
  SessionStateService,
  projectActiveAccount,
} from '@trinity/data-access/matrix-client';
import { EngineRequestError, type EngineResult } from '@trinity/util/matrix';
import type { TrustFacts } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import { recoverTrustOperation } from './trust-operation-error';
import { deriveTrustSnapshot } from './trust-snapshot';

/**
 * Where this device stands relative to the Account's encryption setup.
 * `needs-verification`: the Account has an identity published elsewhere and no recovery;
 * only verifying with a device that holds it (or an explicit reset) helps.
 */
export type TrustStatus =
  'unknown' | 'ready' | 'needs-setup' | 'needs-recovery' | 'needs-verification';

/** One coherent read of the active Account's authoritative crypto state. */
export interface TrustHealthSnapshot {
  readonly status: Exclude<TrustStatus, 'unknown'>;
  readonly keyBackupActive: boolean;
  readonly thisDeviceVerified: boolean;
  /**
   * The Account has no recovery and its published identity's private keys are on
   * another device, not this one. Local-only, like the `needs-verification` decision;
   * false whenever recovery exists or the device is ready.
   */
  readonly identityElsewhere: boolean;
}

/**
 * Current Trust availability. Stale values are separated from `current`, so consumers
 * cannot accidentally treat a retained last-known view as an authoritative decision.
 */
export type TrustHealth =
  | {
      readonly availability: 'coherent';
      readonly current: TrustHealthSnapshot;
      readonly stale: null;
    }
  | {
      readonly availability: 'stale';
      readonly current: null;
      readonly stale: TrustHealthSnapshot;
    }
  | {
      readonly availability: 'unavailable';
      readonly current: null;
      readonly stale: null;
    };

const UNAVAILABLE_TRUST_HEALTH: TrustHealth = Object.freeze({
  availability: 'unavailable',
  current: null,
  stale: null,
});

/** Internal active-Account projection behind {@link TrustService}'s health facade. */
@Injectable({ providedIn: 'root' })
export class TrustHealthService {
  private readonly engine = inject(TRUST_ENGINE);
  private readonly session = inject(SessionStateService);

  private readonly _health = signal<TrustHealth>(UNAVAILABLE_TRUST_HEALTH);
  readonly health = this._health.asReadonly();
  readonly status = computed(() => this.health().current?.status ?? 'unknown');
  readonly keyBackupActive = computed(
    () => this.health().current?.keyBackupActive ?? null,
  );
  readonly thisDeviceVerified = computed(
    () => this.health().current?.thisDeviceVerified ?? null,
  );
  /**
   * This device is verified but setup would replace the identity another device holds,
   * so recovery can only be set up there (or the identity explicitly reset).
   */
  readonly recoverySetupElsewhere = computed(() => {
    const current = this.health().current;
    return (
      current?.status === 'needs-setup' &&
      current.thisDeviceVerified &&
      current.identityElsewhere
    );
  });

  /**
   * Monotonic token so a slow status run cannot overwrite a newer one, even within one
   * projection generation.
   */
  private statusGeneration = 0;

  /** Re-subscribes the facts, so a retry reads them again rather than replaying a failure. */
  private readonly retries = new Subject<void>();

  private readonly projection = projectActiveAccount<EngineResult<TrustFacts>>({
    id: 'trust.health',
    subscribe: (accountId) =>
      this.retries.pipe(
        startWith(undefined),
        switchMap(() => this.engine.facts(accountId)),
      ),
    rebuild: (result) => {
      this.statusGeneration++;
      if (!result.ok) {
        this.publishFailure();
        // Fails the reconcile, so the session's Trust lifetime sees and retries it.
        throw new EngineRequestError(result.failure);
      }
      this.publishSnapshot(result.value);
    },
    reset: () => {
      this.statusGeneration++;
      this._health.set(UNAVAILABLE_TRUST_HEALTH);
    },
  });

  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Explicit command: unlike event reconciliation, a failed read is visible to callers. */
  refresh(): Observable<void> {
    return defer(() => this.refreshCurrent()).pipe(
      recoverTrustOperation('refresh-health'),
    );
  }

  /** Best-effort internal reconciliation after a completed Trust mutation. */
  async reconcile(): Promise<void> {
    try {
      await this.refreshCurrent();
    } catch {
      // The mutation remains authoritative. Its follow-up view is explicitly stale or
      // unavailable, while the session projection owns visible recovery.
    }
  }

  /** Retry the retained projection rather than pretending a standalone refresh reattached it. */
  retryProjection(): void {
    this.retries.next();
  }

  /** One fresh read of the active Account; an Account without crypto reads as unavailable. */
  private async refreshCurrent(): Promise<void> {
    const generation = ++this.statusGeneration;
    const accountId = this.session.activeAccountId();
    const result = accountId
      ? await firstValueFrom(this.engine.facts(accountId).pipe(take(1)))
      : null;
    const failure =
      result && !result.ok && result.failure.code === 'request-failed'
        ? result.failure
        : null;
    if (generation === this.statusGeneration) {
      if (failure) this.publishFailure();
      else this.publishSnapshot(result?.ok ? result.value : null);
    }
    if (failure) throw new EngineRequestError(failure);
  }

  private publishSnapshot(facts: TrustFacts | null): void {
    this._health.set(
      facts
        ? {
            availability: 'coherent',
            current: deriveTrustSnapshot(facts),
            stale: null,
          }
        : UNAVAILABLE_TRUST_HEALTH,
    );
  }

  private publishFailure(): void {
    const previous = this._health();
    const stale = previous.current ?? previous.stale;
    this._health.set(
      stale
        ? { availability: 'stale', current: null, stale }
        : UNAVAILABLE_TRUST_HEALTH,
    );
  }
}
