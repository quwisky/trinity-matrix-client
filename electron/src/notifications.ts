import { ipcMain, Notification } from 'electron';
import {
  coerceNotificationPayload,
  type NotificationRequest,
} from './notification-payload';
import { appIconImage } from './icons';
import { focusMainWindow, getMainWindow } from './window';
import { appIdentity } from './app-identity';

// Native notifications. SHOW_NOTIFICATION_CHANNEL (renderer -> main) asks for an OS
// notification; the payload is untrusted, validated and clamped in coerceNotificationPayload
// before any Notification is built, and accepted only from our own main window's renderer.
// NOTIFICATION_CLICK_CHANNEL (main -> renderer) forwards the clicked notification's typed
// account/room/event destination.
export const SHOW_NOTIFICATION_CHANNEL =
  'trinity:host:v1:notification-presentation:present';
export const NOTIFICATION_CLICK_CHANNEL = 'notification-click';

// Per-room collapse: a fresh notification for a room replaces the previous open one
// (mirrors the Web Notification `tag`).
const activeNotifications = new Map<string, Electron.Notification>();
// Settles a pending notification as completed when a newer one for the same room replaces
// it: it never shows, but nothing failed.
const supersede = new Map<Electron.Notification, () => void>();
/**
 * Colored app icon for Linux notifications, whose daemons show no app icon unless the
 * desktop-entry hint matches an installed .desktop file. macOS and Windows already show
 * the app icon and would add `icon` as a second image. `undefined` when the asset can't be
 * found, so the option is omitted rather than passed blank.
 */
function resolveNotificationIcon(): Electron.NativeImage | undefined {
  return process.platform === 'linux' ? appIconImage() : undefined;
}

/** Outcome of showing an OS notification; showOsNotification() resolves with one. */
type NotificationHostOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'unavailable'; readonly reason: 'not-supported' }
  | {
      readonly kind: 'rejected';
      readonly diagnostic: { readonly code: string };
    };

function showOsNotification(
  payload: NotificationRequest,
): Promise<NotificationHostOutcome> {
  if (!Notification.isSupported()) {
    return Promise.resolve({ kind: 'unavailable', reason: 'not-supported' });
  }
  // The renderer sends `accountId|roomId` as the tag, so a room collapses per account (the
  // same room on two accounts stays two toasts); the room id alone is the legacy fallback.
  const collapseKey = payload.tag || payload.destination.roomId;
  const previous = activeNotifications.get(collapseKey);
  if (previous) {
    supersede.get(previous)?.();
    previous.close();
  }

  let notification: Electron.Notification;
  try {
    const icon = resolveNotificationIcon();
    notification = new Notification({
      // A body-only notification carries the app's name ("Trinity" or "Trinity Next").
      title: payload.title || appIdentity().productName,
      body: payload.body,
      silent: payload.silent,
      ...(icon ? { icon } : {}),
    });
  } catch {
    return Promise.resolve({
      kind: 'rejected',
      diagnostic: { code: 'notification-host-failed' },
    });
  }
  activeNotifications.set(collapseKey, notification);

  notification.on('click', () => {
    focusMainWindow();
    getMainWindow()?.webContents.send(
      NOTIFICATION_CLICK_CHANNEL,
      payload.destination,
    );
  });
  notification.on('close', () => {
    if (activeNotifications.get(collapseKey) === notification) {
      activeNotifications.delete(collapseKey);
    }
  });
  // macOS posts via UNUserNotification, which requires a stable code signature: unsigned or
  // ad-hoc builds fail silently with "UNErrorDomain error 1". Surface it so it is diagnosable.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: NotificationHostOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      supersede.delete(notification);
      notification.removeListener('show', onShow);
      notification.removeListener('failed', onFailed);
      resolve(outcome);
    };
    const onShow = (): void => finish({ kind: 'completed' });
    const onFailed = (_event: Electron.Event, error: string): void => {
      console.error(
        `[notification] display failed (room ${payload.destination.roomId}): ${error}. On macOS this ` +
          'usually means the app is unsigned or ad-hoc-signed — Electron 42 needs a stable ' +
          'code signature to post notifications. See the developer Electron platform guide (macOS signing).',
      );
      finish({
        kind: 'rejected',
        diagnostic: { code: 'notification-host-failed' },
      });
    };
    const timeout = setTimeout(
      () =>
        finish({
          kind: 'rejected',
          diagnostic: { code: 'notification-host-timeout' },
        }),
      5_000,
    );
    supersede.set(notification, () => finish({ kind: 'completed' }));
    notification.once('show', onShow);
    notification.once('failed', onFailed);
    try {
      notification.show();
    } catch {
      finish({
        kind: 'rejected',
        diagnostic: { code: 'notification-host-failed' },
      });
    }
  });
}

/**
 * Dev aid: with the `TRINITY_NOTIFY_TEST` env var set, post one OS notification shortly
 * after startup to confirm notifications display (and see "UNErrorDomain error 1" when the
 * build lacks a stable code signature). Never fires otherwise. Launch the app's binary with
 * the env set to see the console output, e.g.
 * `TRINITY_NOTIFY_TEST=1 "/Applications/Trinity.app/Contents/MacOS/Trinity"`.
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
      title: appIdentity().productName,
      body: 'Test notification — desktop notifications are working.',
      ...(icon ? { icon } : {}),
    });
    notification.on('show', () =>
      console.log('[notify-test] OS accepted the notification (shown).'),
    );
    notification.on('failed', (_event, error) =>
      console.error(
        `[notify-test] FAILED: ${error}. On macOS this means the app lacks a stable code ` +
          'signature — sign it (developer Electron platform guide, macOS signing).',
      ),
    );
    notification.show();
    console.log('[notify-test] posted a startup test notification.');
  }, 3000);
}

/**
 * Wire the versioned notification-presentation operation. An untrusted boundary: only our
 * own main window's renderer is served, and the payload is validated before any
 * notification is built.
 */
export function registerNotificationIpc(): void {
  ipcMain.handle(SHOW_NOTIFICATION_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return {
        kind: 'rejected',
        diagnostic: { code: 'sender-rejected' },
      } as const;
    }
    const payload = coerceNotificationPayload(raw);
    if (!payload) {
      return {
        kind: 'rejected',
        diagnostic: { code: 'invalid-notification-payload' },
      } as const;
    }
    return showOsNotification(payload);
  });
}
