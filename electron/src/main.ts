import { app, powerMonitor, session } from 'electron';
import { registerAppProtocol, registerPrivilegedScheme } from './scheme';
import { installMatrixCors } from './cors';
import { buildMenu } from './menu';
import {
  createWindow,
  focusMainWindow,
  getMainWindow,
  hardenContents,
  installPermissionPolicy,
  setQuitting,
} from './window';
import { createTray } from './tray';
import {
  maybeSendStartupTestNotification,
  registerNotificationIpc,
} from './notifications';
import { registerSecureStoreIpc } from './secure-store-ipc';
import { registerCorsIpc } from './cors-ipc';
import { registerGeolocationIpc } from './geolocation-ipc';
import { registerDockBadge } from './dock-badge';
import { registerHostCapabilityHandshake } from './host-capabilities';
import { registerTitleBarIpc } from './title-bar-ipc';
import { registerUserPresenceIpc } from './user-presence-ipc';
import { registerLockIntegration } from './lock-integration';
import { startUpdateChecks } from './update-check';
import {
  deepLinkFromArgv,
  deliverDeepLink,
  processDeepLinkQueue,
  registerDeepLinkProtocol,
} from './deep-link';
import { alignDevelopmentNameOrExit, appIdentity } from './app-identity';
import { checkRemoteDebuggingOrExit } from './remote-debugging';

/**
 * Hand-rolled Electron main process for Trinity — thin bootstrap.
 *
 * Design: the desktop app is the existing Angular `www/` web build wrapped in a
 * hardened Electron shell. There is NO Capacitor desktop bridge — on desktop the
 * Angular app runs its existing web fallbacks. The renderer detects desktop via
 * the `trinityDesktop` marker exposed by `preload.ts`.
 *
 * This file only owns the app lifecycle and wires the pieces together; each
 * concern now lives in its own module: the privileged `trinity://app` scheme +
 * www/ file server (`scheme.ts`), the window + quit-flag (`window.ts`), the
 * native menu (`menu.ts`) and tray (`tray.ts`), the deep-link funnel
 * (`deep-link.ts`), and the notification + secure-store IPC (`notifications.ts`,
 * `secure-store-ipc.ts`).
 */

// A release build launched with a remote debugging switch shows an error box and exits.
// Then an unpackaged run takes its channel's app name and user-data folder (e.g. "Trinity
// Next") before anything reads that folder or takes the single-instance lock, which lives
// in it. A `--user-data-dir=<path>` switch (the E2E launcher's isolated profile) keeps its
// own. An unknown version shape, packaged or not, shows an error box and exits instead.
const mayStart = checkRemoteDebuggingOrExit() && alignDevelopmentNameOrExit();

// Custom schemes must be registered as privileged BEFORE the app is ready.
registerPrivilegedScheme();

if (!mayStart) {
  // app.exit(1) is under way; register nothing that would read the unknown identity or
  // start the app.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Become the OS handler for this channel's URL scheme (the SSO callback). Only the
  // lock-holding instance registers; safe to call before `ready`.
  registerDeepLinkProtocol();

  // macOS delivers protocol launches/opens via `open-url`. Register it EARLY:
  // on a cold protocol launch it can fire at (or before) app `ready`, so we
  // funnel through deliverDeepLink(), which buffers until the window + renderer
  // exist and then flushes.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  // A second launch reveals the existing window, even if hidden to the tray. On
  // Windows/Linux a protocol activation re-launches us, so the callback URL
  // rides in on the new instance's argv — extract + forward it (which also
  // focuses), otherwise just focus.
  app.on('second-instance', (_event, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) {
      deliverDeepLink(url);
    } else {
      focusMainWindow();
    }
  });

  // Any quit path (tray "Quit", app menu / Cmd+Q, OS shutdown) flips this so the
  // window `close` handler stops hiding-to-tray and lets the process exit.
  app.on('before-quit', () => {
    setQuitting();
  });

  app.whenReady().then(() => {
    // Windows toast identity: set before any window/notification so OS notifications are
    // attributed to this channel's app ("Trinity" or "Trinity Next") rather than
    // "Electron". It matches the AppUserModelID the installer gave the Start menu
    // shortcut (the appId). No-op on macOS/Linux.
    app.setAppUserModelId(appIdentity().appId);

    registerAppProtocol();
    // Inject permissive CORS headers on the renderer's outbound homeserver
    // traffic BEFORE the window loads its URL. The main window uses no
    // `partition`, so it runs on session.defaultSession — the same session
    // registerAppProtocol() serves `trinity://app` from. Scoped to remote
    // http(s) only; see cors.ts (does not weaken webSecurity/sandbox/isolation).
    installMatrixCors(session.defaultSession);
    // Restrict renderer permission requests (app media, geolocation, and sanitized
    // clipboard writes only); Electron would otherwise auto-approve every powerful
    // permission.
    installPermissionPolicy(session.defaultSession);
    buildMenu({ packaged: app.isPackaged });
    registerHostCapabilityHandshake();
    registerTitleBarIpc();
    registerUserPresenceIpc();
    registerDockBadge();
    createWindow();
    // After createWindow so the first window's hide and show are watched from the start.
    // Its menu rebuilds keep the packaged flag of the initial build above.
    registerLockIntegration({
      buildMenu,
      packaged: app.isPackaged,
      powerMonitor,
      getMainWindow,
    });
    createTray();
    // "A new version is available" notices (packaged builds only; see update-check.ts).
    startUpdateChecks();
    registerNotificationIpc();
    registerSecureStoreIpc();
    registerCorsIpc();
    // Approximate (IP-based) location lookup for the desktop location-share dialog;
    // Chromium's navigator.geolocation can't resolve without an embedded Google key.
    registerGeolocationIpc();
    // Dock/launcher unread badge: the renderer pushes its unread total, which
    // main validates + clamps before app.setBadgeCount. Drives the macOS dock
    // (and Linux launcher); a no-op on Windows without an overlay icon.
    maybeSendStartupTestNotification(); // dev-only, gated on TRINITY_NOTIFY_TEST

    // Block any extra web contents (e.g. from a future webview) at creation.
    app.on('web-contents-created', (_event, contents) =>
      hardenContents(contents),
    );

    // macOS dock click: reveal the window (it may be hidden in the tray rather
    // than closed, so a plain "create if none" check would do nothing).
    app.on('activate', () => focusMainWindow());

    // Cold start via protocol on Windows/Linux: the callback URL is one of our
    // own argv entries (macOS uses `open-url`, handled above). Forward it, then
    // flush anything buffered from an `open-url` that fired before `ready`.
    deliverDeepLink(deepLinkFromArgv(process.argv));
    processDeepLinkQueue();
  });

  // Intentionally does NOT quit. The window is only ever *hidden* to the tray on
  // close (it is never destroyed except during an explicit Quit, at which point
  // the app is already quitting), so this event firing means the app should keep
  // running in the background. Exit happens solely via the explicit Quit path
  // (tray "Quit" / app menu / `before-quit`).
  app.on('window-all-closed', () => {
    // no-op: keep the process + renderer + `/sync` alive in the background.
  });
}
