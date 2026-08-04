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
   * callback receives the target `roomId` and the `userId` of the account the
   * notification belongs to (so a tap can switch accounts before opening the
   * room); `userId` is absent for legacy single-account payloads. The raw IPC
   * event is never leaked. Returns an unsubscribe function.
   */
  onNotificationClick?: (
    callback: (roomId: string, userId?: string) => void,
  ) => () => void;

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

  /**
   * Publish the origins the app legitimately talks to — every signed-in homeserver,
   * plus any origin `.well-known` discovery is probing right now.
   *
   * Desktop-only. The renderer is served from `trinity://app`, so homeserver traffic is
   * cross-origin; main injects CORS headers to unblock it (see electron/src/cors.ts)
   * because non-compliant reverse proxies strip the ones the Matrix spec requires. Main
   * cannot know WHICH origins those are — the user picks them at login — so it scopes
   * the shim to whatever the renderer declares here. Anything undeclared is left alone,
   * which keeps a future sanitizer bypass from borrowing the shim to read arbitrary
   * https origins. Call it whenever the set changes; main replaces the whole set.
   */
  cors?: {
    setAllowedOrigins: (origins: readonly string[]) => void;
    /**
     * Additively allow ONE origin. Discovery and login reach a homeserver before any
     * account exists to declare it; the next `setAllowedOrigins` replaces the set, so a
     * probe of a server never signed into does not linger.
     */
    allowOrigin: (origin: string) => void;
  };

  /**
   * Ask the MAIN process to estimate the device's APPROXIMATE location from its
   * public IP (city-level), resolving `null` when the lookup is unavailable or
   * fails. Desktop-only: Chromium's own `navigator.geolocation` is backed by
   * Google's network provider, which prebuilt Electron can't authenticate without
   * an embedded API key, so it never resolves on a keyboard-and-mouse desktop.
   * This is an explicit, opt-in convenience (the user taps it in the manual
   * location dialog) — it is never called automatically, and it sends only the
   * IP the request originates from, never GPS or Wi-Fi scan data.
   */
  resolveApproxLocation?: () => Promise<{ lat: number; lng: number } | null>;
}

/** Payload for {@link TrinityDesktopBridge.showNotification}. */
export interface DesktopNotification {
  /** Notification title (e.g. `sender · room`). */
  title: string;
  /** Body / message preview. */
  body: string;
  /**
   * Suppress the OS notification sound. The desktop shell builds its own native
   * notification in the main process, so it never sees the Web `NotificationOptions` the
   * browser paths carry `silent` on — without this the "Play a sound" setting would be a
   * no-op on Electron.
   */
  silent?: boolean;
  /**
   * Collapse key: a newer notification with the same tag replaces an earlier
   * still-open one. Mirrors the Web `Notification` `tag`. Trinity uses
   * `userId|roomId` so messages from one room collapse per account (and the same
   * room on two accounts stays two distinct toasts).
   */
  tag?: string;
  /** Matrix room id to route to when the notification is clicked. */
  roomId: string;
  /** User id of the account this notification belongs to (for switch-then-open). */
  userId?: string;
}

/**
 * Read the desktop bridge off `globalThis`, or `undefined` on web/mobile.
 * Centralizes the (necessarily) loose global access so feature code stays typed.
 */
export function getTrinityDesktopBridge(): TrinityDesktopBridge | undefined {
  return (globalThis as { trinityDesktop?: TrinityDesktopBridge })
    .trinityDesktop;
}
