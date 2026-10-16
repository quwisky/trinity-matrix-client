import { Injectable } from '@angular/core';

/**
 * Restarts the app into a clean document. A service so a spec can assert the restart did
 * not happen (the blocked-wipe path); a raw `window.location` call is untestable under jsdom.
 */
@Injectable({ providedIn: 'root' })
export class AppRestartService {
  /**
   * Reload from the app root, discarding the current URL.
   *
   * `replace(origin + '/')`, not `reload()`: after a factory reset the URL may still carry
   * `?add` or `?reauth=<userId>`, which against an empty registry shows "That account is no
   * longer stored." for an account the user just erased. It also leaves no history entry for
   * the pre-wipe state.
   *
   * Works on every platform: Electron's `trinity://app` and Capacitor's local server both
   * serve `/` as the app index.
   */
  restart(): void {
    window.location.replace(new URL('/', window.location.href).toString());
  }

  /**
   * Reload the current URL, keeping its route and query, for a session handover. Nothing was
   * wiped, so the tab waits for the session lock and lands where it was.
   */
  reload(): void {
    window.location.reload();
  }
}
