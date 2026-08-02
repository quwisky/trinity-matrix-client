import { effect } from '@angular/core';
import { MatrixClientService } from './matrix-client.service';

/**
 * Re-run `connect` whenever the active account changes — but only while the service
 * is already wired to a client. A viewing service (rooms, spaces, invites, crypto
 * status, …) connects on demand and re-wires onto `matrix.instance` via its own
 * `connectedClient` guard; this makes it re-project onto the newly-active account on
 * a switch, without eagerly connecting idle / page-scoped services that nothing is
 * displaying yet.
 *
 * Call from a service constructor (an injection context, so the effect is owned by
 * the root injector and lives for the session).
 */
export function reprojectOnAccountSwitch(
  matrix: MatrixClientService,
  isConnected: () => boolean,
  connect: () => void,
): void {
  effect(() => {
    matrix.activeUserId();
    if (isConnected()) {
      connect();
    }
  });
}
