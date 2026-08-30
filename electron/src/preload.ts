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
 * Deep-link contract (consumed by the selected host adapter):
 *   trinityDesktop.capabilities.deepLinks.subscribe(cb) receives `eu.qwky.trinity://…` URLs that
 *   the main process forwards over the `deep-link` ipcRenderer channel (used for
 *   the desktop SSO callback) and returns an unsubscribe function. Only the URL
 *   string is passed to the callback — the raw IpcRendererEvent is never leaked.
 *
 * Notification contract (consumed by the selected host adapter):
 *   trinityDesktop.capabilities.notificationPresentation.present(...) asks the MAIN
 *   process to display a native OS notification (more reliably surfaced than a
 *   renderer Web Notification). The adjacent subscribeClicks(cb) operation subscribes
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
const SET_BADGE_COUNT_CHANNEL = 'trinity:host:v1:badge:set';
const HOST_NEGOTIATE_CHANNEL = 'trinity:host:v1:negotiate';

/** Payload accepted by `showNotification`; mirrors core's `DesktopNotification`. */
interface ShowNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  roomId: string;
  userId?: string;
  /** Suppress the OS notification sound (the user's "Play a sound" setting is off). */
  silent?: boolean;
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
  protocolVersion: 1,
  isElectron: true,
  platform: process.platform,
  negotiate: (operations: readonly string[]) =>
    ipcRenderer.invoke(HOST_NEGOTIATE_CHANNEL, {
      protocolVersion: 1,
      operations,
    }) as Promise<unknown>,
  capabilities: {
    deepLinks: {
      subscribe(callback: (url: string) => void): () => void {
        active = callback;
        while (buffered.length > 0) {
          callback(buffered.shift() as string);
        }
        return () => {
          if (active === callback) active = null;
        };
      },
    },
    notificationPresentation: {
      present(payload: ShowNotificationPayload): void {
        if (typeof payload !== 'object' || payload === null) return;
        const { title, body, tag, roomId, userId, silent } =
          payload as Partial<ShowNotificationPayload>;
        if (typeof roomId !== 'string') return;
        ipcRenderer.send(SHOW_NOTIFICATION_CHANNEL, {
          title: typeof title === 'string' ? title : '',
          body: typeof body === 'string' ? body : '',
          tag: typeof tag === 'string' ? tag : undefined,
          roomId,
          userId: typeof userId === 'string' ? userId : undefined,
          silent: silent === true,
        });
      },
      subscribeClicks(
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
    },
    badge: {
      // Push the app-wide unread total through the protocol-v1 badge operation.
      set(count: number): Promise<unknown> {
        if (typeof count !== 'number') {
          return Promise.resolve({
            kind: 'rejected',
            diagnostic: { code: 'invalid-badge-count' },
          });
        }
        return ipcRenderer.invoke(
          SET_BADGE_COUNT_CHANNEL,
          count,
        ) as Promise<unknown>;
      },
    },
    secureStore: {
      isAvailable: (): Promise<boolean> =>
        ipcRenderer.invoke(
          'trinity:secure-store:available',
        ) as Promise<boolean>,
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
    networkCors: {
      setAllowedOrigins: (origins: readonly string[]): void => {
        ipcRenderer.send('trinity:cors:set-allowed-origins', [...origins]);
      },
      allowOrigin: (origin: string): void => {
        ipcRenderer.send('trinity:cors:allow-origin', origin);
      },
    },
    location: {
      approximate: (): Promise<{ lat: number; lng: number } | null> =>
        ipcRenderer.invoke('trinity:geolocation:approximate') as Promise<{
          lat: number;
          lng: number;
        } | null>,
    },
  },
});
