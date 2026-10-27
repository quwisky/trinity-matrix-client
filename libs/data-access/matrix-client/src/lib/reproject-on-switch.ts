import { effect } from '@angular/core';
import { MatrixClientService } from './js-sdk/matrix-client.service';

/**
 * Re-run `connect` whenever the active account changes, but only while the service is
 * already wired to a client, so idle or page-scoped services are not connected eagerly.
 *
 * The last account signing out has no successor and must `disconnect` instead: `connect()`
 * returns immediately when no client is initialized, which would leave every projection
 * holding the stopped client's rooms, members and presence while the app sits on /login.
 * Doing it here makes "a signed-out account's data is gone" hold for all of them at once.
 *
 * Call from a service constructor (an injection context); the effect then lives for the
 * session.
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
