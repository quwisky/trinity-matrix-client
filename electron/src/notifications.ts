import { ipcMain, nativeImage, Notification } from 'electron';
import * as fs from 'node:fs';
import {
  coerceNotificationPayload,
  type NotificationRequest,
} from './notification-payload';
import { iconCandidatePaths } from './icons';
import { focusMainWindow, getMainWindow } from './window';

// Native notifications.
//   renderer -> main (`ipcMain.on`, one-way): SHOW_NOTIFICATION_CHANNEL asks us
//     to display an OS notification. The payload is UNTRUSTED — it is fully
//     validated/clamped in coerceNotificationPayload before any Notification is
//     constructed, and only accepted from our own main window's renderer.
//   main -> renderer: NOTIFICATION_CLICK_CHANNEL forwards the clicked
//     notification's roomId (and the account userId it belongs to) so the Angular
//     app can switch accounts if needed and route to the room.
export const SHOW_NOTIFICATION_CHANNEL = 'show-notification';
export const NOTIFICATION_CLICK_CHANNEL = 'notification-click';

// Per-room collapse for desktop notifications: a fresh notification for a room
// replaces the previous still-open one (mirrors the Web Notification `tag`).
const activeNotifications = new Map<string, Electron.Notification>();
// Lazily resolved colored app icon for notifications. `undefined` => not yet
// resolved; `null` => none found. macOS ignores this and uses the bundle icon.
let notificationIconCache: Electron.NativeImage | null | undefined;

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

/**
 * Show a validated OS notification. Collapses per room (a newer notification for
 * the same room replaces the previous open one). On click, reveals/focuses the
 * window and forwards the roomId to the renderer over `notification-click`.
 */
function showOsNotification(payload: NotificationRequest): void {
  if (!Notification.isSupported()) {
    return;
  }
  // Collapse key: the renderer sends `userId|roomId` as the tag so a room collapses
  // per account (and the same room on two accounts stays two toasts); fall back to
  // the room id for legacy single-account payloads.
  const collapseKey = payload.tag || payload.roomId;
  activeNotifications.get(collapseKey)?.close();

  const icon = resolveNotificationIcon();
  const notification = new Notification({
    title: payload.title || 'Trinity',
    body: payload.body,
    silent: payload.silent,
    ...(icon ? { icon } : {}),
  });
  activeNotifications.set(collapseKey, notification);

  notification.on('click', () => {
    focusMainWindow();
    getMainWindow()?.webContents.send(
      NOTIFICATION_CLICK_CHANNEL,
      payload.roomId,
      payload.userId,
    );
  });
  notification.on('close', () => {
    if (activeNotifications.get(collapseKey) === notification) {
      activeNotifications.delete(collapseKey);
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
export function maybeSendStartupTestNotification(): void {
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
export function registerNotificationIpc(): void {
  ipcMain.on(SHOW_NOTIFICATION_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return;
    }
    const payload = coerceNotificationPayload(raw);
    if (payload) {
      showOsNotification(payload);
    }
  });
}
