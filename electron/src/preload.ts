import { contextBridge, ipcRenderer, webFrame } from 'electron';
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
 *   to clicks the main process forwards over `notification-click`; only the typed
 *   account/room/event destination is passed to the callback (never the raw
 *   event), and it returns an unsubscribe function. The payload is re-validated
 *   in main — this bridge grants no privileged capability and never exposes
 *   ipcRenderer/Node.
 */
const DEEP_LINK_CHANNEL = 'deep-link';
const SHOW_NOTIFICATION_CHANNEL =
  'trinity:host:v1:notification-presentation:present';
const NOTIFICATION_CLICK_CHANNEL = 'notification-click';
// Mirrors dock-badge.ts's SET_BADGE_COUNT_CHANNEL (kept in sync by string value,
// as with SHOW_NOTIFICATION_CHANNEL / NOTIFICATION_CLICK_CHANNEL above).
const SET_BADGE_COUNT_CHANNEL = 'trinity:host:v1:badge:set';
const HOST_NEGOTIATE_CHANNEL = 'trinity:host:v1:negotiate';
// Mirrors window.ts by string value: main reports the window leaving or returning to the screen.
const VISIBILITY_CHANNEL = 'trinity:host:v1:lifecycle:visibility';
// Mirror title-bar-ipc.ts by string value; main re-validates every payload.
const SET_OVERLAY_CHANNEL = 'trinity:host:v1:title-bar:set-overlay';
const POPUP_MENU_CHANNEL = 'trinity:host:v1:title-bar:popup-menu';
const GET_SYSTEM_TITLE_BAR_CHANNEL =
  'trinity:host:v1:title-bar:get-system-title-bar';
const SET_SYSTEM_TITLE_BAR_CHANNEL =
  'trinity:host:v1:title-bar:set-system-title-bar';
const RELAUNCH_CHANNEL = 'trinity:host:v1:title-bar:relaunch';
// Mirrors window.ts by string value; main only closes the window, as a user close does.
const CLOSE_WINDOW_CHANNEL = 'trinity:window:close';
// window.ts appends the running title-bar mode to argv; anything else means "no row".
const TITLE_BAR_ARGUMENT = '--trinity-title-bar=';
const titleBarArgument = process.argv
  .find((arg) => arg.startsWith(TITLE_BAR_ARGUMENT))
  ?.slice(TITLE_BAR_ARGUMENT.length);
const titleBarMode =
  titleBarArgument === 'row' || titleBarArgument === 'system'
    ? titleBarArgument
    : null;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/** Payload accepted by `showNotification`; mirrors core's `DesktopNotification`. */
interface ShowNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  destination: {
    accountId: string;
    roomId: string;
    eventId: string;
  };
  /** Suppress the OS notification sound (the user's "Play a sound" setting is off). */
  silent?: boolean;
}

type NegotiatedOperation =
  | 'authentication-handoff'
  | 'deep-links'
  | 'back'
  | 'file-export'
  | 'notification-presentation'
  | 'location'
  | 'badge'
  | 'secure-store'
  | 'lifecycle'
  | 'updates'
  | 'title-bar';

const unavailableGrant = () =>
  ({ kind: 'unavailable', reason: 'host-rejected' }) as const;

// Listen at preload load (before any page JS), buffering URLs that arrive before
// the renderer subscribes. The main process flushes a cold-start deep link on
// `did-finish-load`, which can precede Angular's `onDeepLink` registration in
// ngOnInit — without this buffer that URL would be lost.
const buffered: string[] = [];
let active: ((url: string) => void) | null = null;
let negotiationAccepted = false;
let grantedOperations = new Set<NegotiatedOperation>();
let negotiationGeneration = 0;

ipcRenderer.on(
  DEEP_LINK_CHANNEL,
  (_event: IpcRendererEvent, url: string): void => {
    if (typeof url !== 'string') {
      return;
    }
    if (active && grantedOperations.has('deep-links')) {
      active(url);
    } else {
      buffered.push(url);
    }
  },
);

function acceptNegotiation(requested: readonly string[], value: unknown): void {
  negotiationAccepted = false;
  grantedOperations = new Set();
  if (!value || typeof value !== 'object') return;
  const result = value as {
    readonly kind?: unknown;
    readonly protocolVersion?: unknown;
    readonly operations?: unknown;
  };
  if (
    result.kind !== 'accepted' ||
    result.protocolVersion !== 1 ||
    !result.operations ||
    typeof result.operations !== 'object'
  ) {
    return;
  }
  negotiationAccepted = true;
  const support = result.operations as Record<string, unknown>;
  for (const operation of requested) {
    const entry = support[operation];
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { readonly kind?: unknown }).kind === 'supported'
    ) {
      grantedOperations.add(operation as NegotiatedOperation);
    }
  }
  if (grantedOperations.has('deep-links') && active) {
    while (buffered.length > 0) active(buffered.shift() as string);
  }
}

async function negotiate(operations: readonly string[]): Promise<unknown> {
  const generation = ++negotiationGeneration;
  // A new request supersedes every earlier grant immediately. Its response is
  // authoritative only while it remains the latest request in flight.
  acceptNegotiation([], undefined);
  try {
    const result = await ipcRenderer.invoke(HOST_NEGOTIATE_CHANNEL, {
      protocolVersion: 1,
      operations,
    });
    if (generation === negotiationGeneration) {
      acceptNegotiation(operations, result);
    }
    return result;
  } catch (error) {
    if (generation === negotiationGeneration) {
      acceptNegotiation([], undefined);
    }
    throw error;
  }
}

// A page's `window.close()` would destroy the renderer, skipping close-to-tray and
// stopping `/sync`. Route it to main, which closes the window like a user close.
contextBridge.executeInMainWorld({
  func: (requestClose: () => void) => {
    // The main world's globalThis is its window; Node typings carry no DOM lib.
    (globalThis as { close?: () => void }).close = () => requestClose();
  },
  args: [() => ipcRenderer.send(CLOSE_WINDOW_CHANNEL)],
});

contextBridge.exposeInMainWorld('trinityDesktop', {
  protocolVersion: 1,
  isElectron: true,
  platform: process.platform,
  negotiate,
  capabilities: {
    deepLinks: {
      subscribe(callback: (url: string) => void): () => void {
        if (!grantedOperations.has('deep-links')) return () => undefined;
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
      present(payload: ShowNotificationPayload): Promise<unknown> {
        if (!grantedOperations.has('notification-presentation')) {
          return Promise.resolve(unavailableGrant());
        }
        if (typeof payload !== 'object' || payload === null) {
          return Promise.resolve({
            kind: 'rejected',
            diagnostic: { code: 'invalid-notification-payload' },
          });
        }
        const { title, body, tag, destination, silent } =
          payload as Partial<ShowNotificationPayload>;
        if (!isNotificationDestination(destination)) {
          return Promise.resolve({
            kind: 'rejected',
            diagnostic: { code: 'invalid-notification-payload' },
          });
        }
        return ipcRenderer.invoke(SHOW_NOTIFICATION_CHANNEL, {
          title: typeof title === 'string' ? title : '',
          body: typeof body === 'string' ? body : '',
          tag: typeof tag === 'string' ? tag : undefined,
          destination,
          silent: silent === true,
        }) as Promise<unknown>;
      },
      subscribeClicks(
        callback: (destination: ShowNotificationPayload['destination']) => void,
      ): () => void {
        if (!grantedOperations.has('notification-presentation')) {
          return () => undefined;
        }
        const listener = (
          _event: IpcRendererEvent,
          destination: unknown,
        ): void => {
          if (!grantedOperations.has('notification-presentation')) return;
          if (isNotificationDestination(destination)) callback(destination);
        };
        ipcRenderer.on(NOTIFICATION_CLICK_CHANNEL, listener);
        return () =>
          ipcRenderer.removeListener(NOTIFICATION_CLICK_CHANNEL, listener);
      },
    },
    badge: {
      // Push the app-wide unread total through the protocol-v1 badge operation.
      set(count: number): Promise<unknown> {
        if (!grantedOperations.has('badge')) {
          return Promise.resolve(unavailableGrant());
        }
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
        grantedOperations.has('secure-store')
          ? (ipcRenderer.invoke(
              'trinity:secure-store:available',
            ) as Promise<boolean>)
          : Promise.resolve(false),
      get: (key: string): Promise<string | null> =>
        grantedOperations.has('secure-store')
          ? (ipcRenderer.invoke('trinity:secure-store:get', key) as Promise<
              string | null
            >)
          : Promise.resolve(null),
      set: (key: string, value: string): Promise<boolean> =>
        grantedOperations.has('secure-store')
          ? (ipcRenderer.invoke(
              'trinity:secure-store:set',
              key,
              value,
            ) as Promise<boolean>)
          : Promise.resolve(false),
      delete: (key: string): Promise<void> =>
        grantedOperations.has('secure-store')
          ? (ipcRenderer.invoke(
              'trinity:secure-store:delete',
              key,
            ) as Promise<void>)
          : Promise.resolve(),
    },
    networkCors: {
      setAllowedOrigins: (origins: readonly string[]): void => {
        if (!negotiationAccepted) return;
        ipcRenderer.send('trinity:cors:set-allowed-origins', [...origins]);
      },
      allowOrigin: (origin: string): void => {
        if (!negotiationAccepted) return;
        ipcRenderer.send('trinity:cors:allow-origin', origin);
      },
    },
    location: {
      approximate: (): Promise<{ lat: number; lng: number } | null> =>
        grantedOperations.has('location')
          ? (ipcRenderer.invoke('trinity:geolocation:approximate') as Promise<{
              lat: number;
              lng: number;
            } | null>)
          : Promise.resolve(null),
    },
    lifecycle: {
      subscribeVisibility(
        callback: (visibility: 'visible' | 'hidden') => void,
      ): () => void {
        if (!grantedOperations.has('lifecycle')) return () => undefined;
        const listener = (_event: IpcRendererEvent, visibility: unknown) => {
          if (!grantedOperations.has('lifecycle')) return;
          if (visibility === 'visible' || visibility === 'hidden') {
            callback(visibility);
          }
        };
        ipcRenderer.on(VISIBILITY_CHANNEL, listener);
        return () => ipcRenderer.removeListener(VISIBILITY_CHANNEL, listener);
      },
      // Electron advises this only after an event that lowers memory use, such as hiding.
      releaseMemory: (): void => {
        if (grantedOperations.has('lifecycle')) webFrame.clearCache();
      },
    },
    titleBar: {
      // Not a privilege: the mode this window was created with, known before negotiation.
      mode: titleBarMode,
      setOverlayColors: (colors: {
        color: string;
        symbolColor: string;
      }): void => {
        if (!grantedOperations.has('title-bar')) return;
        if (!colors || typeof colors !== 'object') return;
        const { color, symbolColor } = colors as Partial<typeof colors>;
        if (!isHexColour(color) || !isHexColour(symbolColor)) return;
        ipcRenderer.send(SET_OVERLAY_CHANNEL, {
          color,
          symbolColor,
        });
      },
      popupMenu: (at: { x: number; y: number }): void => {
        if (!grantedOperations.has('title-bar')) return;
        if (!at || typeof at !== 'object') return;
        const { x, y } = at as Partial<typeof at>;
        if (!isMenuCoordinate(x) || !isMenuCoordinate(y)) return;
        ipcRenderer.send(POPUP_MENU_CHANNEL, { x, y });
      },
      getSystemTitleBar: (): Promise<{ saved: boolean; active: boolean }> =>
        grantedOperations.has('title-bar')
          ? (ipcRenderer.invoke(GET_SYSTEM_TITLE_BAR_CHANNEL) as Promise<{
              saved: boolean;
              active: boolean;
            }>)
          : Promise.resolve({ saved: false, active: false }),
      setSystemTitleBar: (value: boolean): Promise<unknown> => {
        if (!grantedOperations.has('title-bar')) {
          return Promise.resolve(unavailableGrant());
        }
        if (typeof value !== 'boolean') {
          return Promise.resolve({
            kind: 'rejected',
            diagnostic: { code: 'invalid-system-title-bar' },
          });
        }
        return ipcRenderer.invoke(
          SET_SYSTEM_TITLE_BAR_CHANNEL,
          value,
        ) as Promise<unknown>;
      },
      relaunch: (): void => {
        if (!grantedOperations.has('title-bar')) return;
        ipcRenderer.send(RELAUNCH_CHANNEL);
      },
    },
  },
});

function isHexColour(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOUR.test(value);
}

function isMenuCoordinate(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 10_000
  );
}

function isNotificationDestination(
  value: unknown,
): value is ShowNotificationPayload['destination'] {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['accountId'] === 'string' &&
    typeof candidate['roomId'] === 'string' &&
    typeof candidate['eventId'] === 'string'
  );
}
