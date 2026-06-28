import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  protocol,
  shell,
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Hand-rolled Electron main process for Trinity.
 *
 * Design: the desktop app is the existing Angular `www/` web build wrapped in a
 * hardened Electron shell. There is NO Capacitor desktop bridge — on desktop the
 * Angular app runs its existing web fallbacks. The renderer detects desktop via
 * the `trinityDesktop` marker exposed by `preload.ts`.
 *
 * The build is served over a custom *privileged* scheme (registered as
 * standard + secure + fetch + stream) instead of raw `file://`, so that:
 *   - the renderer is a SECURE CONTEXT (required by WebCrypto SubtleCrypto and
 *     IndexedDB, which Matrix crypto + storage rely on),
 *   - the crypto WASM can be loaded with `WebAssembly.instantiateStreaming`
 *     (needs `Content-Type: application/wasm` + a streamable fetch Response),
 *   - `<base href="/">` and the app's absolute asset paths resolve cleanly,
 *   - the strict CSP in index.html (`'self'`) binds to a stable app origin.
 */

const APP_SCHEME = 'trinity';
const APP_HOST = 'app';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const START_URL = `${APP_ORIGIN}/`;

// OS-level deep-link scheme for the SSO callback. The IdP redirects the system
// browser to `eu.qwky.trinity://sso-callback?loginToken=…&sso_state=…`; the OS
// re-launches/forwards to us and we hand the raw URL to the renderer over the
// `deep-link` IPC channel.
//
// NOTE: this is DISTINCT from the in-session `trinity://app` scheme above. That
// one is an Electron-session-only privileged scheme that serves `www/` and is
// NOT registered with the OS. `eu.qwky.trinity` MUST be a real OS protocol
// client (app.setAsDefaultProtocolClient) for the browser redirect to route
// back into the app.
const DEEP_LINK_SCHEME = 'eu.qwky.trinity';
const DEEP_LINK_PREFIX = `${DEEP_LINK_SCHEME}://`;
const DEEP_LINK_CHANNEL = 'deep-link';

// Native notifications.
//   renderer -> main (`ipcMain.on`, one-way): SHOW_NOTIFICATION_CHANNEL asks us
//     to display an OS notification. The payload is UNTRUSTED — it is fully
//     validated/clamped in coerceNotificationPayload before any Notification is
//     constructed, and only accepted from our own main window's renderer.
//   main -> renderer: NOTIFICATION_CLICK_CHANNEL forwards the clicked
//     notification's roomId so the Angular app can route to it.
const SHOW_NOTIFICATION_CHANNEL = 'show-notification';
const NOTIFICATION_CLICK_CHANNEL = 'notification-click';
const NOTIFICATION_TITLE_LIMIT = 120;
const NOTIFICATION_BODY_LIMIT = 300;
const NOTIFICATION_ROOM_ID_LIMIT = 256;

// Windows toast identity: OS notifications are attributed to this
// AppUserModelID (must match the installer's appId). Set once at startup;
// no-op on macOS/Linux.
const APP_USER_MODEL_ID = 'eu.qwky.trinity';

// In dev (compiled to electron/dist/main.js) and when packaged inside app.asar,
// the copied web build sits at electron/www (i.e. one level up from dist/).
// fs reads are asar-aware in Electron, so this path works in both cases.
const WWW_ROOT = path.resolve(__dirname, '..', 'www');
const INDEX_HTML = path.join(WWW_ROOT, 'index.html');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

async function fileResponse(filePath: string, status = 200): Promise<Response> {
  const data = await fs.promises.readFile(filePath);
  return new Response(new Uint8Array(data), {
    status,
    headers: { 'content-type': contentTypeFor(filePath) },
  });
}

/** True only for URLs on our own app origin (exact origin match, no prefix tricks). */
function isAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Custom-scheme file server for the Angular build.
 *
 * - Maps `<scheme>://app/<path>` -> `www/<path>` (so `/assets/...` ->
 *   `www/assets/...` and the crypto WASM is served as `application/wasm`).
 * - SPA fallback: extensionless paths (Angular client routes) serve index.html
 *   so a reload on e.g. `/rooms` boots the app instead of 404ing.
 * - Path-traversal hardened: a resolved path that escapes WWW_ROOT is rejected.
 */
function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel === '') {
      rel = 'index.html';
    }

    const resolved = path.normalize(path.join(WWW_ROOT, rel));
    if (resolved !== WWW_ROOT && !resolved.startsWith(WWW_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.isFile()) {
        return await fileResponse(resolved);
      }
    } catch {
      // fall through to SPA fallback / 404
    }

    // No file on disk: serve index.html for client routes (no extension),
    // otherwise it's a genuinely missing asset.
    if (path.extname(rel) === '') {
      return await fileResponse(INDEX_HTML);
    }
    return new Response('Not Found', { status: 404 });
  });
}

/** Block in-app navigation/popups to anything that isn't our app origin. */
function hardenContents(contents: Electron.WebContents): void {
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

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: () => void shell.openExternal('https://ionicframework.com/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Per-room collapse for desktop notifications: a fresh notification for a room
// replaces the previous still-open one (mirrors the Web Notification `tag`).
const activeNotifications = new Map<string, Electron.Notification>();
// Lazily resolved colored app icon for notifications. `undefined` => not yet
// resolved; `null` => none found. macOS ignores this and uses the bundle icon.
let notificationIconCache: Electron.NativeImage | null | undefined;

// Deep-link URLs that arrived before the renderer was ready to receive them
// (cold start, or while a navigation/reload was in flight). Flushed to the
// renderer on `did-finish-load` / once the app is ready. See deliverDeepLink().
const pendingDeepLinks: string[] = [];

// Set only on the explicit Quit path (tray "Quit", app menu / Cmd+Q, or any
// app.quit()). Until then, closing the window hides it to the tray instead of
// destroying it, so the renderer + `/sync` long-poll stay alive in the
// background and notifications keep firing.
let isQuitting = false;

function createWindow(): void {
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

function focusMainWindow(): void {
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

/** First `eu.qwky.trinity://…` entry in a process argv array, if any. */
function deepLinkFromArgv(argv: readonly string[]): string | undefined {
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
function processDeepLinkQueue(): void {
  if (pendingDeepLinks.length === 0 || !app.isReady()) {
    return;
  }
  focusMainWindow(); // reveal/focus; creates the window on cold start
  const contents = mainWindow?.webContents;
  if (!contents || contents.isLoading()) {
    return; // renderer not up yet — `did-finish-load` retries the flush
  }
  for (const url of pendingDeepLinks.splice(0)) {
    contents.send(DEEP_LINK_CHANNEL, url);
  }
}

/**
 * Validate, buffer, and attempt to deliver an inbound OS deep link. Anything
 * that isn't our `eu.qwky.trinity://` scheme is ignored. This is the single
 * funnel for all OS sources (macOS `open-url`, Windows/Linux argv on cold start
 * and via `second-instance`).
 */
function deliverDeepLink(url: string | undefined): void {
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
function registerDeepLinkProtocol(): void {
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

/**
 * Candidate on-disk locations for an icon asset shipped in `electron/build/`.
 * The asset is made available at runtime via electron-builder `extraResources`
 * (Resources/build) when packaged. We probe a small set of locations so it
 * resolves in dev (run from `electron/`), when packaged (asar app root +
 * extracted resources), or if ever copied beside the compiled main.
 */
function iconCandidatePaths(fileName: string): string[] {
  return [
    path.join(process.resourcesPath, 'build', fileName), // packaged: extraResources
    path.join(app.getAppPath(), 'build', fileName), // dev (electron/) + asar root
    path.join(__dirname, '..', 'build', fileName), // dist/ -> build/
    path.join(__dirname, fileName), // alongside compiled main
  ];
}

/**
 * Resolve the platform tray icon as a NativeImage.
 *
 * macOS uses a monochrome *template* image (`…Template.png`, black + alpha) that
 * the system recolors for light/dark menubars; Windows/Linux use the colored
 * PNG. Never throws if the asset is missing.
 */
function resolveTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const fileName = isMac ? 'trinityTrayTemplate.png' : 'trinityTray.png';

  for (const candidate of iconCandidatePaths(fileName)) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const image = nativeImage.createFromPath(candidate);
      if (image.isEmpty()) {
        continue;
      }
      if (isMac) {
        image.setTemplateImage(true);
      }
      return image;
    } catch {
      // try next candidate
    }
  }

  console.warn('[tray] icon asset not found; tray may not render', { fileName });
  return nativeImage.createEmpty();
}

/**
 * Colored app icon for native notifications (Windows/Linux render it; macOS
 * ignores `icon` and uses the bundle icon). Resolved once, lazily; returns
 * `undefined` when the asset can't be found so we omit the option rather than
 * pass a blank image.
 */
function resolveNotificationIcon(): Electron.NativeImage | undefined {
  if (notificationIconCache === undefined) {
    let found: Electron.NativeImage | null = null;
    for (const candidate of iconCandidatePaths('trinityTray.png')) {
      try {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) {
          found = image;
          break;
        }
      } catch {
        // try next candidate
      }
    }
    notificationIconCache = found;
  }
  return notificationIconCache ?? undefined;
}

/** Validated, clamped notification request derived from an untrusted IPC payload. */
interface NotificationRequest {
  title: string;
  body: string;
  roomId: string;
  silent: boolean;
}

/**
 * Clamp an untrusted IPC string: it must be a string; strip control characters
 * (defends against terminal/markup injection in the toast), trim, and cap length.
 */
function sanitizeNotificationText(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);
}

/**
 * Validate + coerce the UNTRUSTED `show-notification` payload. Returns `null`
 * (so the caller shows nothing) for anything malformed: a non-object, a missing
 * room id, or an empty title+body.
 */
function coerceNotificationPayload(raw: unknown): NotificationRequest | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const roomId = sanitizeNotificationText(rec['roomId'], NOTIFICATION_ROOM_ID_LIMIT);
  if (!roomId) {
    return null; // no target room => nothing to collapse on or open
  }
  const title = sanitizeNotificationText(rec['title'], NOTIFICATION_TITLE_LIMIT);
  const body = sanitizeNotificationText(rec['body'], NOTIFICATION_BODY_LIMIT);
  if (!title && !body) {
    return null; // empty notification => ignore
  }
  return { title, body, roomId, silent: rec['silent'] === true };
}

/**
 * Show a validated OS notification. Collapses per room (a newer notification for
 * the same room replaces the previous open one). On click, reveals/focuses the
 * window and forwards the roomId to the renderer over `notification-click`.
 */
function showOsNotification(payload: NotificationRequest): void {
  if (!Notification.isSupported()) {
    return;
  }
  // Per-room collapse: drop any still-open notification for the same room.
  activeNotifications.get(payload.roomId)?.close();

  const icon = resolveNotificationIcon();
  const notification = new Notification({
    title: payload.title || 'Trinity',
    body: payload.body,
    silent: payload.silent,
    ...(icon ? { icon } : {}),
  });
  activeNotifications.set(payload.roomId, notification);

  notification.on('click', () => {
    focusMainWindow();
    mainWindow?.webContents.send(NOTIFICATION_CLICK_CHANNEL, payload.roomId);
  });
  notification.on('close', () => {
    if (activeNotifications.get(payload.roomId) === notification) {
      activeNotifications.delete(payload.roomId);
    }
  });
  // Electron 42 posts via macOS UNUserNotification, which requires a STABLE code
  // signature — unsigned/ad-hoc builds fail silently here with "UNErrorDomain error 1"
  // rather than displaying. Surface it so it's diagnosable instead of mysterious.
  notification.on('failed', (_event, error) => {
    console.error(
      `[notification] display failed (room ${payload.roomId}): ${error}. On macOS this ` +
        'usually means the app is unsigned or ad-hoc-signed — Electron 42 needs a stable ' +
        'code signature to post notifications. See docs/DEVELOPMENT.md (macOS signing).',
    );
  });

  notification.show();
}

/**
 * Dev aid: when the `TRINITY_NOTIFY_TEST` env var is set, post one OS notification a few
 * seconds after startup — a quick way to confirm desktop notifications actually display
 * (and, via the `failed` listener, to see "UNErrorDomain error 1" when the build lacks a
 * stable code signature). OFF by default; never fires in normal use. Launch the app's
 * binary with the env set so you also see the console output, e.g.:
 *   TRINITY_NOTIFY_TEST=1 "/Applications/Trinity.app/Contents/MacOS/Trinity"
 */
function maybeSendStartupTestNotification(): void {
  if (!process.env['TRINITY_NOTIFY_TEST']) {
    return;
  }
  setTimeout(() => {
    if (!Notification.isSupported()) {
      console.log('[notify-test] Notification.isSupported() is false here.');
      return;
    }
    const icon = resolveNotificationIcon();
    const notification = new Notification({
      title: 'Trinity',
      body: 'Test notification — desktop notifications are working.',
      ...(icon ? { icon } : {}),
    });
    notification.on('show', () =>
      console.log('[notify-test] OS accepted the notification (shown).'),
    );
    notification.on('failed', (_event, error) =>
      console.error(
        `[notify-test] FAILED: ${error}. On macOS this means the app lacks a stable code ` +
          'signature — sign it (docs/DEVELOPMENT.md → macOS signing).',
      ),
    );
    notification.show();
    console.log('[notify-test] posted a startup test notification.');
  }, 3000);
}

/**
 * Wire the one-way `show-notification` IPC. Treats the channel as an untrusted
 * boundary: only accepts messages from our own main window's renderer, and
 * validates the payload before constructing any notification.
 */
function registerNotificationIpc(): void {
  ipcMain.on(SHOW_NOTIFICATION_CHANNEL, (event, raw: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return;
    }
    const payload = coerceNotificationPayload(raw);
    if (payload) {
      showOsNotification(payload);
    }
  });
}

/**
 * System tray so the app keeps running (and syncing, and notifying) in the
 * background after the window is closed to tray. Click / double-click reveals
 * the window; the context menu offers an explicit "Quit" that sets `isQuitting`
 * so the app really exits. The reference is held in module scope so the tray is
 * not garbage-collected (which would make it vanish).
 */
function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(resolveTrayIcon());
  tray.setToolTip('Trinity');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Trinity', click: () => focusMainWindow() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // Left-click reveals on Linux/macOS; Windows convention is double-click.
  tray.on('click', () => focusMainWindow());
  tray.on('double-click', () => focusMainWindow());
}

// Custom schemes must be registered as privileged BEFORE the app is ready.
// standard + secure => stable origin + secure context (WebCrypto/IndexedDB);
// supportFetchAPI + stream => `fetch()` works and the WASM can stream-instantiate.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Become the OS handler for `eu.qwky.trinity://` (the SSO callback). Only the
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
    isQuitting = true;
  });

  app.whenReady().then(() => {
    // Windows toast identity: set before any window/notification so OS
    // notifications are attributed to Trinity rather than "Electron". No-op
    // on macOS/Linux.
    app.setAppUserModelId(APP_USER_MODEL_ID);

    registerAppProtocol();
    buildMenu();
    createWindow();
    createTray();
    registerNotificationIpc();
    maybeSendStartupTestNotification(); // dev-only, gated on TRINITY_NOTIFY_TEST

    // Block any extra web contents (e.g. from a future webview) at creation.
    app.on('web-contents-created', (_event, contents) => hardenContents(contents));

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
