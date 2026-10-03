import type {
  HostNotificationDestination,
  HostOperation,
  HostOperationOutcome,
} from '@trinity/runtime/host';

/**
 * Shape of the minimal, non-privileged bridge that the hand-rolled Electron
 * preload exposes on the renderer's `globalThis` as `trinityDesktop`
 * (see electron/src/preload.ts).
 *
 * It is present ONLY inside the desktop shell; on web/PWA and on mobile
 * (Capacitor) it is `undefined`. Protocol v1 has a required negotiation core and grouped
 * capability operations. Every operation remains inert until the latest accepted negotiation
 * grants it; a rejected or partial renegotiation revokes earlier grants. The preload never leaks
 * `ipcRenderer` or Node.
 */
export interface TrinityDesktopBridge {
  readonly protocolVersion: 1;
  /** Always `true` when running inside the Electron shell. */
  readonly isElectron: true;

  /** Host `process.platform` ('darwin' | 'win32' | 'linux' | …). */
  readonly platform: string;

  /** Negotiate a versioned, explicit capability manifest with the validated main process. */
  readonly negotiate: (
    operations: readonly HostOperation[],
  ) => Promise<unknown>;

  /** Protocol-v1 operations are grouped by capability and gated by negotiated grants. */
  capabilities: {
    deepLinks: {
      /** Subscribe to validated OS deep links, replaying any buffered cold-start URL. */
      subscribe: (callback: (url: string) => void) => () => void;
    };
    notificationPresentation: {
      /** Present a validated native notification through the main process. */
      present: (payload: DesktopNotification) => Promise<HostOperationOutcome>;
      /** Subscribe to validated notification activation targets. */
      subscribeClicks: (
        callback: (destination: HostNotificationDestination) => void,
      ) => () => void;
    };
    badge: {
      /** Set the dock/launcher badge; `0` clears it. Main validates and clamps. */
      set: (count: number) => Promise<HostOperationOutcome>;
    };
    /** OS-keychain-backed secret storage owned by the main process. */
    secureStore: {
      isAvailable: () => Promise<boolean>;
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string) => Promise<boolean>;
      delete: (key: string) => Promise<void>;
    };
    /** Renderer-to-main transport policy, grouped separately from product operations. */
    networkCors: {
      setAllowedOrigins: (origins: readonly string[]) => void;
      allowOrigin: (origin: string) => void;
    };
    location: {
      /** Resolve an opt-in, city-level IP estimate or `null` when unavailable. */
      approximate: () => Promise<{ lat: number; lng: number } | null>;
    };
  };
}

/** Payload for Electron's grouped notification-presentation capability. */
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
   * `accountId|roomId` so messages from one room collapse per account (and the same
   * room on two accounts stays two distinct toasts).
   */
  tag?: string;
  /** Exact semantic destination to activate when the notification is clicked. */
  destination: HostNotificationDestination;
}

/**
 * Read the desktop bridge off `globalThis`, or `undefined` on web/mobile.
 * Centralizes the (necessarily) loose global access so feature code stays typed.
 */
export function getTrinityDesktopBridge(): TrinityDesktopBridge | undefined {
  const bridge = (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  if (!bridge || typeof bridge !== 'object') return undefined;
  const candidate = bridge as Partial<TrinityDesktopBridge>;
  const capabilities = candidate.capabilities;
  return candidate.protocolVersion === 1 &&
    candidate.isElectron === true &&
    typeof candidate.platform === 'string' &&
    typeof candidate.negotiate === 'function' &&
    !!capabilities &&
    !!capabilities.deepLinks &&
    typeof capabilities.deepLinks.subscribe === 'function' &&
    !!capabilities.notificationPresentation &&
    typeof capabilities.notificationPresentation.present === 'function' &&
    typeof capabilities.notificationPresentation.subscribeClicks ===
      'function' &&
    !!capabilities.badge &&
    typeof capabilities.badge.set === 'function' &&
    !!capabilities.secureStore &&
    typeof capabilities.secureStore.isAvailable === 'function' &&
    typeof capabilities.secureStore.get === 'function' &&
    typeof capabilities.secureStore.set === 'function' &&
    typeof capabilities.secureStore.delete === 'function' &&
    !!capabilities.networkCors &&
    typeof capabilities.networkCors.setAllowedOrigins === 'function' &&
    typeof capabilities.networkCors.allowOrigin === 'function' &&
    !!capabilities.location &&
    typeof capabilities.location.approximate === 'function'
    ? (bridge as TrinityDesktopBridge)
    : undefined;
}

/**
 * Whether this renderer is the hand-rolled Electron shell.
 *
 * Capacitor's `isNativePlatform()` is FALSE on desktop, so anything that must treat the
 * shell like neither web nor mobile — the service-worker enable predicate above all —
 * has to ask this instead. The user-agent token is a fallback for the case where the
 * preload marker is unavailable; it is checked second because the marker is the
 * authoritative signal and a user agent can be overridden.
 *
 * Not a service: it is read during `bootstrapApplication`'s provider array, before any
 * injector exists.
 */
export function isElectronRenderer(): boolean {
  return (
    !!getTrinityDesktopBridge() ||
    (typeof navigator !== 'undefined' &&
      navigator.userAgent.includes('Electron'))
  );
}
