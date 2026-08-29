import { inject } from '@angular/core';
import type { EmittedEvents, MatrixClient } from 'matrix-js-sdk';
import { defer, of } from 'rxjs';
import {
  ProjectionRuntime,
  type ProjectionLease,
} from '@trinity/runtime/projection';
import { MatrixClientService } from './matrix-client.service';
import { reprojectOnAccountSwitch } from './reproject-on-switch';

/** What a projecting service exposes; its own `connect`/`disconnect` delegate to this. */
export interface ClientProjection {
  /** Attach listeners and do the first read. Idempotent per client. */
  connect(): void;
  /** Detach listeners, drop any queued rebuild, and reset the read model. */
  disconnect(): void;
  /** Whether listeners are currently attached to a client. */
  isConnected(): boolean;
  /**
   * The client the listeners are attached to, or null. For a bespoke handler that needs
   * to ask something of the client it is bound to — rather than of `matrix.instance`,
   * which during an account switch may already be the next one.
   */
  client(): MatrixClient | null;
  /**
   * Trigger the (coalesced) rebuild. For a service whose own handler decides whether an
   * event is interesting — a state event filtered by type, say — and which is declared as
   * a class field, so it cannot close over the argument {@link ProjectFromClientConfig.bind}
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
   * ClientProjection.connect} — so consumers see the model immediately — and again on each
   * coalesced flush.
   *
   * Optional, because a projection need not have a read model of its own: a service that
   * only forwards events (and does no initial read) still wants the client-keyed listeners
   * and the account-switch re-projection. Omitting it with {@link events} set would mean an
   * event list that triggers nothing, so pass one or neither.
   *
   * Prefer the `client` argument over re-reading `matrix.instance`. Most services here
   * still do the latter inside their own `refresh()`, which is what they did before this
   * primitive existed and is benign — a rebuild coalesced from account A's events can
   * drain after the active client is already B, and it then rebuilds from B, which the
   * re-projection effect was about to do anyway. New code should take the argument and
   * avoid the window entirely.
   */
  rebuild?: (client: MatrixClient) => void;

  /**
   * Events that mean "the model changed". Bound to a coalesced rebuild.
   *
   * Use {@link bind} instead when a handler needs the event's arguments, or when a service
   * has a second listener group that must NOT be coalesced.
   */
  events?: readonly EmittedEvents[];

  /**
   * Bind bespoke listeners — a handler that needs the event's arguments, or a second group
   * that must not be coalesced. Whatever this binds, {@link unbind} must remove: the
   * projection cannot know what was attached. Use {@link ClientProjection.schedule} from
   * such a handler to trigger the rebuild.
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
 * The client-lifecycle half of a sync projection, so each service stops re-deriving it.
 *
 * Three things every projection has to get right, decided here once:
 *
 * 1. **Coalescing** — a sync burst emits many events; rebuilding per event is waste.
 * 2. **Client-keyed connection** — a logout→login swaps in a fresh `MatrixClient`, so
 *    listeners are keyed to the *instance*. Gating on a boolean instead leaves them on the
 *    discarded client and freezes the read model.
 * 3. **Re-projection on account switch** — in multi-account the active client changes
 *    underneath a service that is already connected.
 *
 * Call from a service's field initializer or constructor: it is an injection context, which
 * {@link reprojectOnAccountSwitch}'s effect needs in order to be owned by the root injector
 * and live for the session.
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
  let invalidate = (): void => undefined;
  const onEvent = (): void => invalidate();

  const projection: ClientProjection = {
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
          connectedClient = matrix.instance;
          for (const event of events) {
            connectedClient.on(event, onEvent);
          }
          bind?.(connectedClient);
          return () => {
            const attachedClient = connectedClient;
            if (!attachedClient) return;
            for (const event of events) {
              attachedClient.off(event, onEvent);
            }
            unbind?.(attachedClient);
            connectedClient = null;
            invalidate = () => undefined;
          };
        },
        reconcile: ({ publish }) =>
          defer(() => {
            const attachedClient = connectedClient;
            if (attachedClient) {
              publish(() => rebuild?.(attachedClient));
            }
            return of(void 0);
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
      () => projection.isConnected(),
      () => projection.connect(),
      () => projection.disconnect(),
    );
  }

  return projection;
}
