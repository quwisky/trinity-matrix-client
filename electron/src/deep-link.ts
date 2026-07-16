import { app } from 'electron';
import * as path from 'node:path';
import { focusMainWindow, getMainWindow } from './window';

// OS-level deep-link scheme for the SSO callback. The IdP redirects the system
// browser to `eu.qwky.trinity://sso-callback?loginToken=…&sso_state=…`; the OS
// re-launches/forwards to us and we hand the raw URL to the renderer over the
// `deep-link` IPC channel.
//
// NOTE: this is DISTINCT from the in-session `trinity://app` scheme (see
// scheme.ts). That one is an Electron-session-only privileged scheme that serves
// `www/` and is NOT registered with the OS. `eu.qwky.trinity` MUST be a real OS
// protocol client (app.setAsDefaultProtocolClient) for the browser redirect to
// route back into the app.
export const DEEP_LINK_SCHEME = 'eu.qwky.trinity';
// Scheme-only, so both callback shapes route: legacy SSO redirects to the `//` form,
// while OIDC uses the RFC 8252 §7.1 form (`eu.qwky.trinity:/sso-callback`) which has
// no authority. Matching on `://` would silently drop every OIDC callback.
export const DEEP_LINK_PREFIX = `${DEEP_LINK_SCHEME}:`;
export const DEEP_LINK_CHANNEL = 'deep-link';

// Deep-link URLs that arrived before the renderer was ready to receive them
// (cold start, or while a navigation/reload was in flight). Flushed to the
// renderer on `did-finish-load` / once the app is ready. See deliverDeepLink().
const pendingDeepLinks: string[] = [];

/** First `eu.qwky.trinity:…` entry in a process argv array, if any. */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(DEEP_LINK_PREFIX));
}

/**
 * Reveal/focus the window and forward any buffered deep links to the renderer
 * over the `deep-link` channel.
 *
 * - No-op when the queue is empty, so it never steals focus on a normal load.
 * - Defers (leaving URLs buffered) when the app isn't ready yet — macOS
 *   `open-url` can fire before `ready` — or when the renderer is mid-load. In
 *   both cases the flush is retried from `whenReady` / `did-finish-load`.
 */
export function processDeepLinkQueue(): void {
  if (pendingDeepLinks.length === 0 || !app.isReady()) {
    return;
  }
  focusMainWindow(); // reveal/focus; creates the window on cold start
  const contents = getMainWindow()?.webContents;
  if (!contents || contents.isLoading()) {
    return; // renderer not up yet — `did-finish-load` retries the flush
  }
  for (const url of pendingDeepLinks.splice(0)) {
    contents.send(DEEP_LINK_CHANNEL, url);
  }
}

/**
 * Validate, buffer, and attempt to deliver an inbound OS deep link. Anything
 * that isn't our `eu.qwky.trinity:` scheme is ignored. This is the single
 * funnel for all OS sources (macOS `open-url`, Windows/Linux argv on cold start
 * and via `second-instance`).
 */
export function deliverDeepLink(url: string | undefined): void {
  if (!url || !url.startsWith(DEEP_LINK_PREFIX)) {
    return;
  }
  pendingDeepLinks.push(url);
  processDeepLinkQueue();
}

/**
 * Register Trinity as the OS handler for `eu.qwky.trinity://`. Per the Electron
 * docs, an unpackaged dev run (`process.defaultApp`) must register the Electron
 * binary plus the resolved path to our entry point so the OS re-launches us
 * with the correct arguments; a packaged build registers itself with a plain
 * call. Safe to call before `app.whenReady()`.
 */
export function registerDeepLinkProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}
