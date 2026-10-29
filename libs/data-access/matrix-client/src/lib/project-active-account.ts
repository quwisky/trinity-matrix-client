import { computed, effect, inject, untracked } from '@angular/core';
import { BehaviorSubject, type Observable, defer, first, map, of } from 'rxjs';
import {
  ownedProjection,
  ProjectionRuntime,
  type ProjectionLease,
} from '@trinity/runtime/projection';
import { plainEqual } from '@trinity/util/matrix';
import { SessionStateService } from './session-state.service';

/** What a projecting service exposes; its own `run`/`connect`/`disconnect` delegate to this. */
export interface ActiveAccountProjection {
  /** Cold owned lifetime: retain the subscription until the final unsubscribe. */
  run(): Observable<void>;
  /** Subscribe for the Active Account and publish its first value. Idempotent per account and session generation. */
  connect(): void;
  /** Unsubscribe, drop any queued rebuild, and reset the read model. */
  disconnect(): void;
  /** Rebuild the latest value again, keeping the lease and subscription; a no-op while detached. */
  invalidate(): void;
  isConnected(): boolean;
  /** The account the subscription follows, or null. */
  accountId(): string | null;
}

export interface ProjectActiveAccountConfig<T> {
  /** Stable acknowledgement identity inside the Active Account projection scope. */
  id: string;
  /**
   * The account's source; its first value completes a reconcile, later ones are coalesced.
   * It must emit a snapshot first: a feed with no initial value never becomes ready. Report
   * expected failures as values and error only on a fatal fault: an error ends the
   * subscription and leaves the projection failed until an account switch, a session
   * generation change or a runtime transition.
   */
  subscribe: (accountId: string) => Observable<T>;
  /** Publish a value into the read model; called synchronously on connect when the source emits on subscribe. */
  rebuild: (value: T, accountId: string) => void;
  /** Clear the read model on disconnect and before following another account. */
  reset?: () => void;
}

type Latest<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown };

interface Attachment<T> {
  readonly accountId: string;
  readonly generation: number;
  readonly latest: BehaviorSubject<Latest<T>>;
  readonly invalidate: () => void;
}

/**
 * The SDK-free counterpart of `projectFromClient`: the Active Account's lease in
 * {@link ProjectionRuntime} over an engine subscription. Coalesces bursts, resets and
 * re-subscribes on an account switch or a new session generation, and disconnects when the
 * last account signs out. Call from an injection context.
 */
export function projectActiveAccount<T>(
  config: ProjectActiveAccountConfig<T>,
): ActiveAccountProjection {
  const { id, subscribe, rebuild, reset } = config;
  const runtime = inject(ProjectionRuntime);
  const session = inject(SessionStateService);
  const active = computed(
    () => {
      const status = session.active();
      return status
        ? { accountId: status.accountId, generation: status.generation }
        : null;
    },
    { equal: plainEqual },
  );

  let attached: Attachment<T> | null = null;
  let lease: ProjectionLease | null = null;
  let lifetimeOwners = 0;

  const projection: ActiveAccountProjection = {
    run(): Observable<void> {
      return ownedProjection(
        () => {
          lifetimeOwners += 1;
          projection.connect();
        },
        () => {
          lifetimeOwners -= 1;
          if (lifetimeOwners === 0) projection.disconnect();
        },
      );
    },

    connect(): void {
      const target = untracked(active);
      if (!target) return;
      if (
        attached?.accountId === target.accountId &&
        attached.generation === target.generation
      ) {
        return;
      }
      projection.disconnect();
      lease = runtime.activate({
        id,
        scope: { kind: 'active-account' },
        // Resolved at attach time, so a runtime transition follows the newly active account.
        attach: (invalidate) => {
          const current = untracked(active);
          if (!current) return;
          const latest = new BehaviorSubject<Latest<T>>({ kind: 'pending' });
          let subscribed = false;
          // Invalidate before storing, so a reconcile waiting on the first value is replaced
          // rather than publishing the same value twice.
          const settle = (next: Latest<T>): void => {
            if (subscribed) invalidate();
            latest.next(next);
          };
          const subscription = subscribe(current.accountId).subscribe({
            next: (value) => settle({ kind: 'value', value }),
            error: (error: unknown) => settle({ kind: 'error', error }),
          });
          subscribed = true;
          const attachment: Attachment<T> = { ...current, latest, invalidate };
          attached = attachment;
          return () => {
            subscription.unsubscribe();
            if (attached === attachment) attached = null;
          };
        },
        reconcile: (context) =>
          defer(() => {
            const attachment = attached;
            if (!attachment) return of(void 0);
            return attachment.latest.pipe(
              first((state) => state.kind !== 'pending'),
              map((state) => {
                if (state.kind === 'error') throw state.error;
                if (state.kind === 'value') {
                  context.publish(() =>
                    rebuild(state.value, attachment.accountId),
                  );
                }
              }),
            );
          }),
        reset: () => reset?.(),
      });
    },

    disconnect(): void {
      if (!lease) return;
      lease.release();
      lease = null;
    },

    invalidate: () => attached?.invalidate(),

    isConnected: () => attached !== null,

    accountId: () => attached?.accountId ?? null,
  };

  effect(() => {
    const target = active();
    if (!(lifetimeOwners > 0 || projection.isConnected())) return;
    // Untracked: the source and the read model are the caller's, not this effect's dependencies.
    untracked(() => (target ? projection.connect() : projection.disconnect()));
  });

  return projection;
}
