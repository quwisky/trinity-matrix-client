import type { EmittedEvents, MatrixClient } from 'matrix-js-sdk';
import { coalesce } from './coalesce';
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
   * Coalesce {@link events} into one rebuild per turn. Default true. Set false only where
   * the events are genuinely rare and the latency matters more than the batching — and say
   * why at the call site, because the next reader will assume it was an oversight.
   */
  coalesce?: boolean;

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
    matrix,
    rebuild,
    events = [],
    bind,
    unbind,
    reset,
    coalesce: shouldCoalesce = true,
    reprojectOnSwitch = true,
  } = config;

  // The client we currently have listeners on — the instance, not a boolean (see 2 above).
  let connectedClient: MatrixClient | null = null;

  const runRebuild = (): void => {
    if (connectedClient) {
      rebuild?.(connectedClient);
    }
  };
  const coalescer = coalesce(runRebuild);
  const scheduleRebuild = shouldCoalesce
    ? () => coalescer.schedule()
    : runRebuild;
  const onEvent = (): void => scheduleRebuild();

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
      connectedClient = client;
      for (const event of events) {
        client.on(event, onEvent);
      }
      bind?.(client);
      rebuild?.(client);
    },

    disconnect(): void {
      const client = connectedClient;
      if (!client) {
        return;
      }
      for (const event of events) {
        client.off(event, onEvent);
      }
      unbind?.(client);
      connectedClient = null;
      coalescer.cancel();
      reset?.();
    },

    isConnected: () => connectedClient !== null,

    client: () => connectedClient,

    schedule: () => scheduleRebuild(),
  };

  if (reprojectOnSwitch) {
    reprojectOnAccountSwitch(
      matrix,
      () => projection.isConnected(),
      () => projection.connect(),
    );
  }

  return projection;
}
