import { inject } from '@angular/core';
import type { EmittedEvents, MatrixClient } from 'matrix-js-sdk';
import { Observable, defer, of } from 'rxjs';
import {
  ownedProjection,
  ProjectionRuntime,
  type ProjectionLease,
  type ProjectionReconcileContext,
} from '@trinity/runtime/projection';
import { MatrixClientService } from './js-sdk/matrix-client.service';
import { reprojectOnAccountSwitch } from './reproject-on-switch';

/** What a projecting service exposes; its own `connect`/`disconnect` delegate to this. */
export interface ClientProjection {
  /** Cold owned lifetime: retain attachment demand until the final unsubscribe. */
  run(): Observable<void>;
  /** Attach listeners and do the first read. Idempotent per client. */
  connect(): void;
  /** Detach listeners, drop any queued rebuild, and reset the read model. */
  disconnect(): void;
  /** Whether listeners are currently attached to a client. */
  isConnected(): boolean;
  /**
   * The client the listeners are attached to, or null. Prefer it to `matrix.instance` in a
   * bespoke handler: during an account switch the instance may already be the next client.
   */
  client(): MatrixClient | null;
  /**
   * Trigger the (coalesced) rebuild, for a class-field handler that decides itself whether
   * an event matters and so cannot close over the argument {@link ProjectFromClientConfig.bind}
   * receives.
   */
  schedule(): void;
}

export interface ProjectFromClientConfig {
  /** Stable acknowledgement identity inside the Active Account projection scope. */
  id: string;
  matrix: MatrixClientService;

  /**
   * Rebuild the read model from this client. Called synchronously by {@link
   * ClientProjection.connect}, so consumers see the model immediately, and again on each
   * coalesced flush.
   *
   * Optional for a service that only forwards events. Omitting it with {@link events} set
   * would mean an event list that triggers nothing, so pass one or neither.
   *
   * Prefer the `client` argument over re-reading `matrix.instance`: a rebuild coalesced from
   * account A's events can drain after the active client is already B. Re-reading is benign
   * (it rebuilds from B, as the re-projection effect was about to) but the argument avoids
   * the window.
   */
  rebuild?: (
    client: MatrixClient,
    context: ProjectionReconcileContext,
  ) => void | Observable<void>;

  /**
   * Events that mean "the model changed". Bound to a coalesced rebuild; use {@link bind}
   * for a handler that needs the event's arguments or a listener group that must NOT be
   * coalesced.
   */
  events?: readonly EmittedEvents[];

  /**
   * Bind bespoke listeners. Whatever this binds, {@link unbind} must remove: the projection
   * cannot know what was attached. Call {@link ClientProjection.schedule} from a handler to
   * trigger the rebuild.
   */
  bind?: (client: MatrixClient) => void;
  /** Remove whatever {@link bind} attached. */
  unbind?: (client: MatrixClient) => void;

  /** Clear the read model on disconnect, so a detached service holds no stale projection. */
  reset?: () => void;

  /**
   * Re-project onto the newly-active account's client when the account changes, if already
   * connected. Default true. False only for a projection whose lifetime is scoped to
   * something the switch already tears down.
   */
  reprojectOnSwitch?: boolean;
}

/**
 * The client-lifecycle half of a sync projection:
 *
 * 1. **Coalescing** of a sync burst into one rebuild.
 * 2. **Client-keyed connection** — a logout→login swaps in a fresh `MatrixClient`, so
 *    listeners are keyed to the *instance*. Gating on a boolean leaves them on the
 *    discarded client and freezes the read model.
 * 3. **Re-projection on account switch** — the active client changes underneath an
 *    already-connected service.
 *
 * Call from a field initializer or constructor: {@link reprojectOnAccountSwitch}'s effect
 * needs the injection context to be owned by the root injector.
 */
export function projectFromClient(
  config: ProjectFromClientConfig,
): ClientProjection {
  const {
    id,
    matrix,
    rebuild,
    events = [],
    bind,
    unbind,
    reset,
    reprojectOnSwitch = true,
  } = config;
  const runtime = inject(ProjectionRuntime);

  // The client we currently have listeners on — the instance, not a boolean (see 2 above).
  let connectedClient: MatrixClient | null = null;
  let lease: ProjectionLease | null = null;
  let lifetimeOwners = 0;
  let invalidate = (): void => undefined;
  const onEvent = (): void => invalidate();

  const projection: ClientProjection = {
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
      if (!matrix.isInitialized) {
        return;
      }
      const client = matrix.instance;
      if (connectedClient === client) {
        return; // already wired to this client
      }
      projection.disconnect(); // drop listeners from any previous client
      lease = runtime.activate({
        id,
        scope: { kind: 'active-account' },
        attach: (nextInvalidate) => {
          invalidate = nextInvalidate;
          const client = matrix.instance;
          connectedClient = client;
          const detachClient = (): void => {
            const attachedClient = connectedClient;
            if (!attachedClient) return;
            const failures: unknown[] = [];
            for (const event of events) {
              try {
                attachedClient.off(event, onEvent);
              } catch (error: unknown) {
                failures.push(error);
              }
            }
            try {
              unbind?.(attachedClient);
            } catch (error: unknown) {
              failures.push(error);
            }
            connectedClient = null;
            invalidate = () => undefined;
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(
                failures,
                'Matrix projection listener cleanup failed.',
              );
            }
          };
          try {
            for (const event of events) {
              client.on(event, onEvent);
            }
            bind?.(client);
          } catch (error: unknown) {
            try {
              detachClient();
            } catch (cleanupError: unknown) {
              throw new AggregateError(
                [error, cleanupError],
                'Matrix projection attachment and cleanup failed.',
              );
            }
            throw error;
          }
          return detachClient;
        },
        reconcile: (context) =>
          defer(() => {
            const attachedClient = connectedClient;
            if (!attachedClient) return of(void 0);
            let result: void | Observable<void> = undefined;
            const accepted = context.publish(() => {
              result = rebuild?.(attachedClient, context);
            });
            return accepted ? (result ?? of(void 0)) : of(void 0);
          }),
        reset: () => reset?.(),
      });
    },

    disconnect(): void {
      if (!lease) {
        return;
      }
      lease.release();
      lease = null;
    },

    isConnected: () => connectedClient !== null,

    client: () => connectedClient,

    schedule: () => lease?.invalidate(),
  };

  if (reprojectOnSwitch) {
    reprojectOnAccountSwitch(
      matrix,
      () => lifetimeOwners > 0 || projection.isConnected(),
      () => projection.connect(),
      () => projection.disconnect(),
    );
  }

  return projection;
}
