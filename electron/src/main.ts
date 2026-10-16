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
import { registerLifecycleIpc } from './lifecycle-ipc';
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
 * Electron main process: a thin bootstrap that owns the app lifecycle and wires the
 * modules together. The desktop app is the Angular `www/` build in a hardened shell, with
 * no Capacitor desktop bridge; the renderer detects desktop via the `trinityDesktop`
 * marker `preload.ts` exposes.
 */

// A release build launched with a remote debugging switch shows an error box and exits.
// Then an unpackaged run takes its channel's app name and user-data folder before anything
// reads that folder or takes the single-instance lock, which lives in it. A
// `--user-data-dir=<path>` switch (the E2E isolated profile) keeps its own. An unknown
// version shape, packaged or not, shows an error box and exits instead.
const mayStart = checkRemoteDebuggingOrExit() && alignDevelopmentNameOrExit();

// Custom schemes must be registered as privileged before the app is ready.
registerPrivilegedScheme();

if (!mayStart) {
  // app.exit(1) is under way; register nothing that reads the unknown identity.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Become the OS handler for this channel's URL scheme (the SSO callback). Only the
  // lock-holding instance registers; safe to call before `ready`.
  registerDeepLinkProtocol();

  // macOS delivers protocol opens via `open-url`. Register it early: on a cold protocol
  // launch it can fire at or before `ready`, so it funnels through deliverDeepLink(),
  // which buffers until the window and renderer exist.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  // A second launch reveals the existing window, even if hidden to the tray. On
  // Windows/Linux a protocol activation re-launches us, so the callback URL rides in on the
  // new instance's argv.
  app.on('second-instance', (_event, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) {
      deliverDeepLink(url);
    } else {
      focusMainWindow();
    }
  });

  // Any quit path (tray "Quit", app menu / Cmd+Q, OS shutdown) must stop the window `close`
  // handler hiding to the tray.
  app.on('before-quit', () => {
    setQuitting();
  });

  app.whenReady().then(() => {
    // Windows toast identity: set before any window or notification so toasts are
    // attributed to this channel's app, not "Electron". It must match the AppUserModelID
    // the installer gave the Start menu shortcut (the appId). No-op on macOS/Linux.
    app.setAppUserModelId(appIdentity().appId);

    registerAppProtocol();
    // Before the window loads its URL. The main window uses no `partition`, so it runs on
    // session.defaultSession, the session registerAppProtocol() serves `trinity://app` from.
    // See cors.ts for the scope.
    installMatrixCors(session.defaultSession);
    // Electron would otherwise auto-approve every powerful permission; allow only app
    // media, geolocation and sanitized clipboard writes.
    installPermissionPolicy(session.defaultSession);
    buildMenu({ packaged: app.isPackaged });
    registerHostCapabilityHandshake();
    registerTitleBarIpc();
    registerUserPresenceIpc();
    registerDockBadge();
    createWindow();
    // After createWindow so the first window's hide and show are watched from the start.
    // Its menu rebuilds keep the initial build's packaged flag.
    registerLockIntegration({
      buildMenu,
      packaged: app.isPackaged,
      powerMonitor,
      getMainWindow,
    });
    createTray();
    // Packaged builds only; see update-check.ts.
    startUpdateChecks();
    registerNotificationIpc();
    registerSecureStoreIpc();
    registerCorsIpc();
    registerGeolocationIpc();
    registerLifecycleIpc();
    maybeSendStartupTestNotification(); // dev-only, gated on TRINITY_NOTIFY_TEST

    // Block any extra web contents (e.g. a webview) at creation.
    app.on('web-contents-created', (_event, contents) =>
      hardenContents(contents),
    );

    // macOS dock click: the window may be hidden in the tray rather than closed, so a
    // "create if none" check would do nothing.
    app.on('activate', () => focusMainWindow());

    // Cold start via protocol on Windows/Linux: the callback URL is in argv. Then flush
    // anything buffered from an `open-url` that fired before `ready`.
    deliverDeepLink(deepLinkFromArgv(process.argv));
    processDeepLinkQueue();
  });

  // Intentionally does not quit: the window is only hidden to the tray on close, so the
  // app keeps running (renderer and `/sync` alive). Exit happens solely via the explicit
  // Quit path (tray "Quit" / app menu / `before-quit`).
  app.on('window-all-closed', () => {
    // no-op
  });
}
