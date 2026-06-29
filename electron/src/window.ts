import { app, BrowserWindow, shell } from 'electron';
import * as path from 'node:path';
import { isAppUrl, START_URL } from './scheme';
import { processDeepLinkQueue } from './deep-link';

let mainWindow: BrowserWindow | null = null;

// Set only on the explicit Quit path (tray "Quit", app menu / Cmd+Q, or any
// app.quit()). Until then, closing the window hides it to the tray instead of
// destroying it, so the renderer + `/sync` long-poll stay alive in the
// background and notifications keep firing.
let isQuitting = false;

/** Live accessor for the shared main window (other modules use it, e.g. for
 * IPC sender validation), so they never have to reach back into this module's
 * mutable state directly. Returns `null` while no window exists. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Arm the explicit-quit flag without quitting. Wired to `app.on('before-quit')`
 * so any quit path (app menu / Cmd+Q, OS shutdown) lets the window `close`
 * handler stop hiding-to-tray and the process actually exit.
 */
export function setQuitting(): void {
  isQuitting = true;
}

/** Explicit quit: arm the flag, then quit (used by the tray "Quit" item). */
export function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

/** Block in-app navigation/popups to anything that isn't our app origin. */
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

  // Defense in depth: never attach a webview / open a privileged child frame.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Hardened defaults — see CLAUDE.md cross-platform guardrails.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Renderer must never reach Node directly; preload is the only bridge.
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // Keep the renderer running at full speed when the window is hidden,
      // minimized, or occluded. Chromium otherwise throttles background pages
      // (timers, rAF, and — critically — the matrix-js-sdk `/sync` long-poll),
      // which would stall live events and delay/suppress the renderer-driven
      // background notifications. This is the key enabler for "notify while in
      // the background" alongside close-to-tray below.
      backgroundThrottling: false,
    },
  });

  hardenContents(mainWindow.webContents);

  // Flush any deep links buffered before the renderer was ready to receive them
  // (cold start, or a load/reload that was in flight when the link arrived).
  mainWindow.webContents.on('did-finish-load', () => processDeepLinkQueue());

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Close-to-tray: a user-initiated window close hides the window instead of
  // destroying it, keeping the process, renderer, and `/sync` alive so
  // background notifications keep working. An explicit Quit sets `isQuitting`
  // first, letting the close proceed and the window actually be destroyed.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

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
  // The window may be hidden in the tray rather than minimized/closed — show()
  // is a no-op if already visible and reveals it if it was hidden-to-tray.
  mainWindow.show();
  mainWindow.focus();
}
