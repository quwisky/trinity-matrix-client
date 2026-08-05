import { Injectable } from '@angular/core';

/**
 * Restarts the app into a clean document.
 *
 * Exists as a service rather than a bare `window.location` call for two reasons. It is the
 * only way a spec can assert the restart did NOT happen — the blocked-wipe path depends on
 * that, and `test-setup.base.ts` filters jsdom's "Not implemented: navigation" noise, so a
 * raw call is silently untestable in both directions. And it keeps the one-line difference
 * between `reload()` and `replace()` somewhere it can be explained.
 */
@Injectable({ providedIn: 'root' })
export class AppRestartService {
  /**
   * Reload from the app root, discarding the current URL.
   *
   * `replace(origin + '/')`, not `reload()`: after a factory reset the current URL may still
   * carry `?add` or `?reauth=<userId>`, and re-entering the login page with those against an
   * empty registry produces "That account is no longer stored." for an account the user just
   * chose to erase. Replacing also leaves no history entry pointing at the pre-wipe state.
   *
   * One implementation covers every platform: web is the site origin, Electron's renderer
   * runs on the privileged `trinity://app` scheme whose `/` maps to the packaged index, and
   * Capacitor's local server serves `/` on `capacitor://localhost` / `https://localhost`.
   * Native storage is genuinely cleared by then, so a WebView reload observes the new state.
   */
  restart(): void {
    window.location.replace(new URL('/', window.location.href).toString());
  }
}
