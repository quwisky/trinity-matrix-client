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
 * The last account signing out is the same event with no successor, and it must
 * `disconnect` instead: `connect()` returns immediately when no client is initialized,
 * which would leave every projection holding the stopped client's rooms, members and
 * presence in live signals for as long as the app sits on /login. Doing it here is what
 * makes "a signed-out account's data is gone" hold for all of them at once, rather than
 * at each of the call sites that happen to remember.
 *
 * Call from a service constructor (an injection context, so the effect is owned by
 * the root injector and lives for the session).
 */
export function reprojectOnAccountSwitch(
  matrix: MatrixClientService,
  isConnected: () => boolean,
  connect: () => void,
  disconnect: () => void,
): void {
  effect(() => {
    matrix.activeUserId();
    if (!isConnected()) {
      return;
    }
    if (!matrix.isInitialized) {
      disconnect();
      return;
    }
    connect();
  });
}
