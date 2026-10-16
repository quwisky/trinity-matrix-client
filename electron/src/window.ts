import { app, BrowserWindow, shell } from 'electron';
import * as path from 'node:path';
import { isAppUrl, START_URL } from './scheme';
import { processDeepLinkQueue } from './deep-link';
import { windowIconOptions } from './icons';
import { watchRendererRecovery } from './renderer-recovery';
import { releaseChannelArgument } from './app-identity';
import {
  GRAPHITE_DARK_SURFACE_APP,
  readWindowPrefs,
  titleBarArgument,
  titleBarOptions,
} from './window-prefs';

// preload.ts mirrors this by string value.
const CLOSE_WINDOW_CHANNEL = 'trinity:window:close';

let mainWindow: BrowserWindow | null = null;
// The mode the current window was created with; the saved pref applies only after a relaunch.
let systemTitleBarActive = false;

// Set only on the explicit Quit path (tray "Quit", app menu / Cmd+Q, or any app.quit()).
// Until then, closing the window hides it to the tray, so the renderer and `/sync` stay
// alive and notifications keep firing.
let isQuitting = false;

/** The shared main window (also used for IPC sender validation), or `null` while none exists. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Whether the running window uses the OS title bar (no Trinity row, no overlay). */
export function isSystemTitleBarActive(): boolean {
  return systemTitleBarActive;
}

/**
 * Arm the explicit-quit flag without quitting. Wired to `before-quit`, so any quit path
 * (app menu / Cmd+Q, OS shutdown) lets the window `close` handler stop hiding to the tray.
 */
export function setQuitting(): void {
  isQuitting = true;
}

/** Explicit quit, for the tray "Quit" item. */
export function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

/** Block in-app navigation and popups to anything that isn't our app origin. */
export function hardenContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });

  // Defense in depth: never attach a webview.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Electron emits persistent-storage at runtime but omits it from its permission union. */
function isAllowedAppPermission(permission: string): boolean {
  return (
    permission === 'persistent-storage' ||
    permission === 'media' ||
    permission === 'geolocation' ||
    permission === 'clipboard-sanitized-write' ||
    permission === 'fullscreen'
  );
}

/**
 * Restrict renderer permission requests to what the app uses: media (microphone for voice
 * messages, camera for QR verification), geolocation (location sharing), persistent
 * storage, sanitized clipboard writes for explicit copy actions, and element fullscreen
 * (the video player). Without a handler Electron would auto-approve every other powerful
 * permission. Clipboard reads remain denied.
 */
export function installPermissionPolicy(session: Electron.Session): void {
  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (
        !details.isMainFrame ||
        !isAppUrl(contents.getURL()) ||
        !isAppUrl(details.requestingUrl)
      ) {
        callback(false);
        return;
      }
      callback(isAllowedAppPermission(permission));
    },
  );
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      Boolean(
        contents &&
        details.isMainFrame &&
        isAppUrl(contents.getURL()) &&
        isAppUrl(details.requestingUrl ?? requestingOrigin) &&
        isAllowedAppPermission(permission),
      ),
  );
}

// preload.ts mirrors this by string value.
const VISIBILITY_CHANNEL = 'trinity:host:v1:lifecycle:visibility';

export function createWindow(): void {
  const prefs = readWindowPrefs();
  systemTitleBarActive = prefs.systemTitleBar;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: GRAPHITE_DARK_SURFACE_APP,
    // Windows/Linux taskbar and window icon; dev runs would otherwise show Electron's
    // default. macOS uses the bundle's .icns.
    ...windowIconOptions(process.platform),
    // Trinity draws its own 32px title row unless the user opted into the OS bar.
    ...titleBarOptions(process.platform, prefs),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Read synchronously by preload, so the first render knows whether to draw the title
      // row and which app it runs in.
      additionalArguments: [titleBarArgument(prefs), releaseChannelArgument()],
      // Hardened defaults; see .agents/skills/electron/ipc-security.md.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Renderer must never reach Node directly; preload is the only bridge.
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // Chromium otherwise throttles a hidden, minimized or occluded renderer (timers, rAF
      // and the matrix-js-sdk `/sync` long-poll), which would stall live events and
      // suppress background notifications. Needed with close-to-tray below.
      backgroundThrottling: false,
      // A packaged release build refuses developer tools; development runs and the Electron
      // journeys (which launch dist/main.js unpackaged) keep them.
      devTools: !app.isPackaged,
    },
  });

  // The title row's ☰ pops the application menu up instead (title-bar-ipc.ts);
  // hiding keeps the menu's accelerators, unlike removeMenu().
  if (!prefs.systemTitleBar && process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  hardenContents(mainWindow.webContents);
  // Release builds have no View › Reload; recover a crashed or hung renderer instead.
  watchRendererRecovery(mainWindow);

  // Flush deep links buffered while the renderer could not receive them.
  mainWindow.webContents.on('did-finish-load', () => processDeepLinkQueue());

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // backgroundThrottling keeps document.visibilityState 'visible', so tell the renderer
  // itself when the window leaves or returns to the screen; it frees memory while hidden,
  // and App lock counts the time away.
  const win = mainWindow;
  // What the renderer was last told, so focus and maximize report a return only once. A
  // renderer that starts while the window is hidden asks lifecycle-ipc.ts instead.
  let visibility: 'visible' | 'hidden' = 'visible';
  const sendVisibility = (next: 'visible' | 'hidden') => () => {
    visibility = next;
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(VISIBILITY_CHANNEL, next);
    }
  };
  win.on('hide', sendVisibility('hidden'));
  win.on('minimize', sendVisibility('hidden'));
  win.on('show', sendVisibility('visible'));
  win.on('restore', sendVisibility('visible'));
  // Some restores emit neither show nor restore (a minimised maximised window on Windows may
  // emit only maximize and focus); report the window back once it is on screen again.
  const maybeBack = (): void => {
    try {
      if (visibility === 'hidden' && win.isVisible() && !win.isMinimized()) {
        sendVisibility('visible')();
      }
    } catch {
      // A window being destroyed; nothing to report.
    }
  };
  win.on('maximize', maybeBack);
  win.on('focus', maybeBack);

  // Close-to-tray: a user close hides the window, keeping the renderer and `/sync` alive for
  // background notifications. An explicit Quit sets `isQuitting` first, so the close proceeds.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // A page's `window.close()` destroys the WebContents, and with it the window, without
  // ever emitting the cancellable `close` above. Preload sends it here instead, so it
  // takes the same path as a user close.
  mainWindow.webContents.ipc.on(CLOSE_WINDOW_CHANNEL, () =>
    mainWindow?.close(),
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(START_URL);
}

export function focusMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  // The window may be hidden in the tray rather than minimized; show() reveals it and is a
  // no-op when already visible.
  mainWindow.show();
  mainWindow.focus();
}
