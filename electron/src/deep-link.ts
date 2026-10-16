import { app } from 'electron';
import * as path from 'node:path';
import { appIdentity } from './app-identity';
import { focusMainWindow, getMainWindow } from './window';

// OS-level deep-link scheme for the SSO callback and app links: this release channel's own
// (see release-channel.ts). The IdP redirects the system browser to
// `<scheme>://sso-callback?loginToken=…&sso_state=…`; the OS forwards it to us and the raw
// URL goes to the renderer over the `deep-link` channel. Each app registers and accepts
// only its own scheme, so a callback never reaches the other app.
//
// Distinct from the in-session `trinity://app` scheme (scheme.ts), which is not registered
// with the OS. This one must be a real OS protocol client (app.setAsDefaultProtocolClient)
// for the browser redirect to route back into the app.
export const DEEP_LINK_CHANNEL = 'deep-link';

// URLs that arrived before the renderer could receive them (cold start, or a navigation or
// reload in flight); flushed on `did-finish-load` / once the app is ready.
const pendingDeepLinks: string[] = [];

/**
 * Scheme-only prefix, so both callback shapes route: legacy SSO redirects to the `//`
 * form, while OIDC uses the RFC 8252 §7.1 form (`<scheme>:/sso-callback`) which has no
 * authority; matching on `://` would silently drop every OIDC callback. The colon also
 * keeps stable's `dev.trinityproject.trinity:` from matching Trinity Next's scheme.
 */
function deepLinkPrefix(): string {
  return `${appIdentity().deepLinkScheme}:`;
}

/** First entry in a process argv array on this app's own scheme, if any. */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  const prefix = deepLinkPrefix();
  return argv.find((arg) => arg.startsWith(prefix));
}

/**
 * Reveal the window and forward buffered deep links over the `deep-link` channel.
 *
 * - No-op when the queue is empty, so it never steals focus on a normal load.
 * - Defers (URLs stay buffered) while the app isn't ready (macOS `open-url` can fire before
 *   `ready`) or the renderer is mid-load; `whenReady` / `did-finish-load` retry.
 */
export function processDeepLinkQueue(): void {
  if (pendingDeepLinks.length === 0 || !app.isReady()) {
    return;
  }
  focusMainWindow(); // also creates the window on cold start
  const contents = getMainWindow()?.webContents;
  if (!contents || contents.isLoading()) {
    return; // renderer not up yet — `did-finish-load` retries the flush
  }
  for (const url of pendingDeepLinks.splice(0)) {
    contents.send(DEEP_LINK_CHANNEL, url);
  }
}

/**
 * Validate, buffer and deliver an inbound OS deep link; anything not on this app's own
 * scheme is ignored. The single funnel for all OS sources (macOS `open-url`, Windows/Linux
 * argv on cold start and via `second-instance`).
 */
export function deliverDeepLink(url: string | undefined): void {
  if (!url || !url.startsWith(deepLinkPrefix())) {
    return;
  }
  pendingDeepLinks.push(url);
  processDeepLinkQueue();
}

/**
 * Register this app as the OS handler for its own scheme. An unpackaged dev run
 * (`process.defaultApp`) must register the Electron binary plus the resolved path to our
 * entry point so the OS re-launches us with the right arguments; a packaged build
 * registers itself with a plain call. Safe to call before `app.whenReady()`.
 */
export function registerDeepLinkProtocol(): void {
  const scheme = appIdentity().deepLinkScheme;
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(scheme);
  }
}
