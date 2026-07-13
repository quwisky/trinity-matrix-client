import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

/**
 * Minimal, non-privileged preload bridge.
 *
 * Runs in a sandboxed, context-isolated world. We do NOT hand the renderer raw
 * Node, the filesystem, or `ipcRenderer` itself — only a small, explicit API
 * surface so the Angular app can (a) detect that it is running inside the
 * hand-rolled Electron desktop shell (used e.g. to keep the service worker off)
 * and (b) receive OS deep links forwarded by the main process.
 *
 * Detection contract (consumed by apps/trinity/src/main.ts):
 *   (globalThis as any).trinityDesktop?.isElectron === true
 *
 * Deep-link contract (consumed by apps/trinity/src/app/app.component.ts):
 *   trinityDesktop.onDeepLink(cb) subscribes to `eu.qwky.trinity://…` URLs that
 *   the main process forwards over the `deep-link` ipcRenderer channel (used for
 *   the desktop SSO callback) and returns an unsubscribe function. Only the URL
 *   string is passed to the callback — the raw IpcRendererEvent is never leaked.
 *
 * Notification contract (consumed by libs/core NotificationService):
 *   trinityDesktop.showNotification({ title, body, tag?, roomId }) asks the MAIN
 *   process to display a native OS notification (more reliably surfaced than a
 *   renderer Web Notification). trinityDesktop.onNotificationClick(cb) subscribes
 *   to clicks the main process forwards over `notification-click`; only the
 *   `roomId` string is passed to the callback (never the raw event), and it
 *   returns an unsubscribe function. The payload is re-validated in main — this
 *   bridge grants no privileged capability and never exposes ipcRenderer/Node.
 */
const DEEP_LINK_CHANNEL = 'deep-link';
const SHOW_NOTIFICATION_CHANNEL = 'show-notification';
const NOTIFICATION_CLICK_CHANNEL = 'notification-click';
// Mirrors dock-badge.ts's SET_BADGE_COUNT_CHANNEL (kept in sync by string value,
// as with SHOW_NOTIFICATION_CHANNEL / NOTIFICATION_CLICK_CHANNEL above).
const SET_BADGE_COUNT_CHANNEL = 'set-badge-count';

/** Payload accepted by `showNotification`; mirrors core's `DesktopNotification`. */
interface ShowNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  roomId: string;
  userId?: string;
}

// Listen at preload load (before any page JS), buffering URLs that arrive before
// the renderer subscribes. The main process flushes a cold-start deep link on
// `did-finish-load`, which can precede Angular's `onDeepLink` registration in
// ngOnInit — without this buffer that URL would be lost.
const buffered: string[] = [];
let active: ((url: string) => void) | null = null;

ipcRenderer.on(
  DEEP_LINK_CHANNEL,
  (_event: IpcRendererEvent, url: string): void => {
    if (typeof url !== 'string') {
      return;
    }
    if (active) {
      active(url);
    } else {
      buffered.push(url);
    }
  },
);

contextBridge.exposeInMainWorld('trinityDesktop', {
  isElectron: true,
  platform: process.platform,
  onDeepLink(callback: (url: string) => void): () => void {
    active = callback;
    // Replay anything that arrived before the renderer subscribed.
    while (buffered.length > 0) {
      callback(buffered.shift() as string);
    }
    return () => {
      if (active === callback) {
        active = null;
      }
    };
  },

  // Request a native OS notification from the main process. We forward only the
  // known string fields (and only when shaped correctly); the main process
  // re-validates and clamps everything before constructing a Notification.
  showNotification(payload: ShowNotificationPayload): void {
    if (typeof payload !== 'object' || payload === null) {
      return;
    }
    const { title, body, tag, roomId, userId } =
      payload as Partial<ShowNotificationPayload>;
    if (typeof roomId !== 'string') {
      return;
    }
    ipcRenderer.send(SHOW_NOTIFICATION_CHANNEL, {
      title: typeof title === 'string' ? title : '',
      body: typeof body === 'string' ? body : '',
      tag: typeof tag === 'string' ? tag : undefined,
      roomId,
      userId: typeof userId === 'string' ? userId : undefined,
    });
  },

  // Push the app-wide unread total to the main process for the dock/launcher
  // badge. Only forwarded when it's an actual number; the main process re-validates
  // and clamps before calling app.setBadgeCount (0 clears the badge).
  setBadgeCount(count: number): void {
    if (typeof count !== 'number') {
      return;
    }
    ipcRenderer.send(SET_BADGE_COUNT_CHANNEL, count);
  },

  // Subscribe to native-notification clicks. Only the roomId (and the account
  // userId it belongs to) are handed to the callback — the raw IpcRendererEvent is
  // never leaked. Returns unsubscribe.
  onNotificationClick(
    callback: (roomId: string, userId?: string) => void,
  ): () => void {
    const listener = (
      _event: IpcRendererEvent,
      roomId: unknown,
      userId: unknown,
    ): void => {
      if (typeof roomId === 'string') {
        callback(roomId, typeof userId === 'string' ? userId : undefined);
      }
    };
    ipcRenderer.on(NOTIFICATION_CLICK_CHANNEL, listener);
    return () =>
      ipcRenderer.removeListener(NOTIFICATION_CLICK_CHANNEL, listener);
  },

  // OS-keychain-backed secret storage in the MAIN process (safeStorage). These only
  // proxy to validated main-process handlers — the renderer never sees the keyring or
  // the on-disk ciphertext. Backs core's Electron SecureStorage backend.
  secureStore: {
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke('trinity:secure-store:available') as Promise<boolean>,
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke('trinity:secure-store:get', key) as Promise<
        string | null
      >,
    set: (key: string, value: string): Promise<boolean> =>
      ipcRenderer.invoke(
        'trinity:secure-store:set',
        key,
        value,
      ) as Promise<boolean>,
    delete: (key: string): Promise<void> =>
      ipcRenderer.invoke('trinity:secure-store:delete', key) as Promise<void>,
  },

  // Ask the main process to estimate the device's approximate (IP-based) location.
  // Only used by the desktop location-share dialog's opt-in button; the main process
  // does the keyless HTTPS lookup and returns null on any failure.
  resolveApproxLocation: (): Promise<{ lat: number; lng: number } | null> =>
    ipcRenderer.invoke('trinity:geolocation:approximate') as Promise<{
      lat: number;
      lng: number;
    } | null>,
});
