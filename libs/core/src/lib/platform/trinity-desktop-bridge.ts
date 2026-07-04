/**
 * Shape of the minimal, non-privileged bridge that the hand-rolled Electron
 * preload exposes on the renderer's `globalThis` as `trinityDesktop`
 * (see electron/src/preload.ts).
 *
 * It is present ONLY inside the desktop shell; on web/PWA and on mobile
 * (Capacitor) it is `undefined`. Every member is optional, so callers MUST
 * feature-detect (`typeof bridge?.fn === 'function'`) before use. The preload
 * never leaks `ipcRenderer` or Node — these are the only capabilities it grants.
 */
export interface TrinityDesktopBridge {
  /** Always `true` when running inside the Electron shell. */
  readonly isElectron?: boolean;

  /** Host `process.platform` ('darwin' | 'win32' | 'linux' | …). */
  readonly platform?: string;

  /**
   * Subscribe to `eu.qwky.trinity://…` OS deep links (e.g. the SSO callback)
   * forwarded by the main process. Returns an unsubscribe function. Replays any
   * link that was buffered before the renderer subscribed.
   */
  onDeepLink?: (callback: (url: string) => void) => () => void;

  /**
   * Ask the MAIN process to show a native OS notification. Routed through main
   * (rather than the renderer Web `Notification` API) because Electron renderer
   * notifications are unreliably surfaced/attributed by the OS — especially on
   * macOS. The payload is validated + clamped in the main process; a malformed
   * payload is silently ignored.
   */
  showNotification?: (payload: DesktopNotification) => void;

  /**
   * Subscribe to native-notification clicks forwarded by the main process. The
   * callback receives ONLY the target `roomId` (never the raw IPC event).
   * Returns an unsubscribe function.
   */
  onNotificationClick?: (callback: (roomId: string) => void) => () => void;

  /**
   * Push the app-wide unread total to the MAIN process, which sets the macOS
   * dock badge (and the Linux launcher count where supported) via
   * `app.setBadgeCount`. The value is validated + clamped in main (finite number,
   * floored, `[0, 9999]`; `0` clears it); a malformed payload is silently ignored.
   * A no-op where unsupported (Windows has no numeric taskbar badge without an
   * overlay icon).
   */
  setBadgeCount?: (count: number) => void;

  /**
   * OS-keychain-backed secret storage in the MAIN process (Electron `safeStorage`).
   * The renderer never touches the keyring or the on-disk ciphertext — it only asks
   * main to get/set/delete a key. `set` resolves `false` when the OS keychain is
   * unavailable (`safeStorage.isEncryptionAvailable()` false), and `isAvailable`
   * reports the same so callers can fall back. Backs the Electron `SecureStorage`.
   */
  secureStore?: {
    isAvailable: () => Promise<boolean>;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
    delete: (key: string) => Promise<void>;
  };
}

/** Payload for {@link TrinityDesktopBridge.showNotification}. */
export interface DesktopNotification {
  /** Notification title (e.g. `sender · room`). */
  title: string;
  /** Body / message preview. */
  body: string;
  /**
   * Collapse key: a newer notification with the same tag replaces an earlier
   * still-open one. Mirrors the Web `Notification` `tag`. Trinity uses the
   * room id so repeated messages from one room collapse into a single toast.
   */
  tag?: string;
  /** Matrix room id to route to when the notification is clicked. */
  roomId: string;
}

/**
 * Read the desktop bridge off `globalThis`, or `undefined` on web/mobile.
 * Centralizes the (necessarily) loose global access so feature code stays typed.
 */
export function getTrinityDesktopBridge(): TrinityDesktopBridge | undefined {
  return (globalThis as { trinityDesktop?: TrinityDesktopBridge })
    .trinityDesktop;
}
