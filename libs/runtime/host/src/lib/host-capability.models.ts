import type { Observable } from 'rxjs';

/** Every host operation agreed by the capability architecture program. */
export const HOST_OPERATIONS = [
  'authentication-handoff',
  'deep-links',
  'back',
  'file-export',
  'notification-presentation',
  'location',
  'badge',
  'secure-store',
  'lifecycle',
  'updates',
  'title-bar',
  'user-presence',
  'lock-integration',
  'screen-privacy',
] as const;

export type HostOperation = (typeof HOST_OPERATIONS)[number];

export type HostUnavailableReason =
  'not-implemented' | 'not-supported' | 'protocol-mismatch' | 'host-rejected';

/** Secret-safe metadata: stable codes only, never payloads, URLs, keys, or values. */
export interface HostDiagnostic {
  readonly code: string;
}

export type HostCapabilitySupport =
  | { readonly kind: 'supported' }
  | {
      readonly kind: 'unavailable';
      readonly reason: HostUnavailableReason;
      readonly diagnostic?: HostDiagnostic;
    };

export interface HostCapabilityManifest {
  readonly protocolVersion: 1;
  readonly operations: Readonly<Record<HostOperation, HostCapabilitySupport>>;
}

export type HostOperationOutcome =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'unavailable';
      readonly reason: HostUnavailableReason;
      readonly diagnostic?: HostDiagnostic;
    }
  | { readonly kind: 'rejected'; readonly diagnostic: HostDiagnostic };

export interface HostAuthenticationHandoffOperation {
  callback(request: { readonly webUrl: string; readonly appUrl: string }): {
    readonly url: string;
    readonly applicationType: 'web' | 'native';
  };
  /**
   * `privateCallback`: the page's redirect back to the app scheme must reach Trinity alone,
   * since another app can register the same scheme. A host that cannot do that rejects it.
   */
  open(request: {
    readonly url: string;
    readonly privateCallback?: boolean;
  }): Observable<HostOperationOutcome>;
  /** Whether `open` can honour `privateCallback`; every host answers, and a false hides legacy SSO. */
  privateCallbackSupported(): boolean;
  /**
   * The name of a Matrix device this host signs in or registers, also sent as the OIDC
   * client name. Optional: a host without one of its own is "Trinity".
   */
  deviceDisplayName?(): string;
  /**
   * Emits when the person closes the host's own sign-in sheet (Custom Tabs, Safari View
   * Controller). Only a host that signs in through a sheet of its own has it: App lock counts
   * that sheet as Trinity's system UI. A browser outside Trinity (desktop, web) has none.
   */
  readonly sheetClosed?: Observable<void>;
}

export interface HostDeepLinksOperation {
  deepLinkSupport(): Observable<HostCapabilitySupport>;
  readonly received: Observable<{ readonly url: string }>;
  closeAuthentication(): Observable<HostOperationOutcome>;
}

export interface HostBackOperation {
  backSupport(): Observable<HostCapabilitySupport>;
  readonly intents: Observable<{ readonly canGoBack: boolean }>;
  background(): Observable<HostOperationOutcome>;
}

/**
 * `cancelled`: the host reported its save UI (the native share sheet) as dismissed, so it
 * may not have saved anything. On Android this also covers a share target that kept Trinity
 * in the foreground, such as Copy. Consumers report neither success nor failure for it.
 * Browser and desktop downloads cannot observe a cancel and never produce it.
 */
export type HostFileExportOutcome =
  HostOperationOutcome | { readonly kind: 'cancelled' };

export interface HostFileExportOperation {
  support(): Observable<HostCapabilitySupport>;
  save(request: {
    readonly bytes: Blob;
    readonly filename: string;
  }): Observable<HostFileExportOutcome>;
}

export interface HostNotificationPresentationOperation {
  presentationSupport(): Observable<HostCapabilitySupport>;
  readonly activated: Observable<HostNotificationDestination>;
  requestPermission(): Observable<HostOperationOutcome>;
  present(request: {
    readonly title: string;
    readonly body: string;
    readonly tag?: string;
    readonly silent?: boolean;
    /** Always hide: the title is the app's name only; mobile hosts drop it (the OS shows it). */
    readonly generic?: boolean;
    /** Hide on the lock screen: redacted on the device lock screen where the host can. */
    readonly hideOnLockScreen?: boolean;
    readonly destination: HostNotificationDestination;
  }): Observable<HostOperationOutcome>;
}

/** Semantic target round-tripped through an untrusted host notification surface. */
export interface HostNotificationDestination {
  readonly accountId: string;
  readonly roomId: string;
  readonly eventId: string;
}

export interface HostBadgeOperation {
  support(): Observable<HostCapabilitySupport>;
  set(count: number): Observable<HostOperationOutcome>;
}

export interface HostLifecycleOperation {
  readonly events: Observable<
    { readonly kind: 'active' } | { readonly kind: 'background' }
  >;
  /** Ask the host to drop its own caches after the app went to the background. */
  releaseMemory?(): Observable<HostOperationOutcome>;
}

export interface HostUpdatesOperation {
  check(): Observable<HostOperationOutcome>;
}

/** What kind of system prompt confirms presence; `passcode-only` has no biometric sensor. */
export type HostPresenceBiometry =
  'face' | 'fingerprint' | 'touch-id' | 'windows-hello' | 'passcode-only';

/** Why the system prompt cannot run now. Stable codes only, never OS text. */
export type HostSystemPresenceUnavailableReason =
  | 'not-supported'
  | 'no-device-credential'
  | 'not-enrolled'
  | 'not-configured'
  | 'disabled-by-policy'
  | 'windows-version'
  | 'addon-unavailable'
  | 'locked-out';

/**
 * What a Touch ID sheet offers instead: the device passcode (iPhone, iPad) or the account
 * password (Mac). Every other prompt's fallback follows from its kind.
 */
export type HostTouchIdFallback = 'passcode' | 'password';

export type HostSystemPresence =
  | {
      readonly kind: 'available';
      readonly biometry: Exclude<HostPresenceBiometry, 'touch-id'>;
    }
  | {
      readonly kind: 'available';
      readonly biometry: 'touch-id';
      readonly fallback: HostTouchIdFallback;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: HostSystemPresenceUnavailableReason;
    };

/**
 * The Trinity PIN backup (spec decision 23). `set` says whether a verifier is stored;
 * `nextAttemptAt` (epoch ms) is the end of a failure wait still running, else null.
 * `not-supported` means the host has no PIN store and keeps no PIN; a store or record
 * the host cannot read, or an answer about it that cannot be trusted, is
 * `secure-storage-unavailable` (fail closed).
 */
export type HostPinPresence =
  | {
      readonly kind: 'available';
      readonly set: boolean;
      readonly nextAttemptAt: number | null;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'not-supported' | 'secure-storage-unavailable';
    };

/** Read again at every unlock: a passcode or Windows Hello can be turned off at any time. */
export interface HostUserPresenceSupport {
  readonly system: HostSystemPresence;
  readonly pin: HostPinPresence;
}

/** `cancelled` is not a failure: it never counts toward the PIN-style delay. */
export type HostPresenceOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'locked-out' }
  | {
      readonly kind: 'unavailable';
      readonly reason: HostSystemPresenceUnavailableReason;
    }
  | { readonly kind: 'rejected'; readonly diagnostic: HostDiagnostic };

/**
 * A PIN attempt. `invalid` is a PIN the host refused to hash (not 4–16 ASCII digits);
 * `failed` carries the wait the failure started, `delayed` a wait still running.
 */
export type HostPinOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'failed'; readonly nextAttemptAt: number | null }
  | { readonly kind: 'delayed'; readonly nextAttemptAt: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rejected'; readonly diagnostic: HostDiagnostic };

/**
 * App lock's "prove it's you": the system prompt and the Trinity PIN. The PIN, its hash
 * and its salt never leave the host's verifier and never appear in an outcome.
 */
export interface HostUserPresenceOperation {
  support(): Observable<HostUserPresenceSupport>;
  verify(request: { readonly reason: string }): Observable<HostPresenceOutcome>;
  setPin(pin: string): Observable<HostOperationOutcome>;
  verifyPin(pin: string): Observable<HostPinOutcome>;
  clearPin(): Observable<HostOperationOutcome>;
}

/** Why the desktop shell asks the app to lock: its menu item, the OS locking, or sleep. */
export type HostLockRequest = 'menu' | 'system-locked' | 'suspended';

export interface HostLockState {
  readonly enabled: boolean;
  readonly locked: boolean;
  /** The bound "Lock Trinity" shortcut as an Electron accelerator, or null when unassigned. */
  readonly accelerator: string | null;
}

/** The desktop shell's part of App lock. Only Electron implements it. */
export interface HostLockIntegrationOperation {
  readonly requests: Observable<HostLockRequest>;
  setState(state: HostLockState): Observable<HostOperationOutcome>;
  /** The cover has painted; a window held hidden for it may be shown. */
  coverPainted(): Observable<HostOperationOutcome>;
}

/**
 * What this host's app-switcher cover does. `blocksCapture`: it also blocks screenshots and
 * screen recording, screen sharing included (Android FLAG_SECURE); without it the cover only
 * hides the app-switcher snapshot (the iOS blur).
 */
export type HostScreenPrivacySupport =
  | { readonly kind: 'supported'; readonly blocksCapture: boolean }
  | Extract<HostCapabilitySupport, { readonly kind: 'unavailable' }>;

/** The mobile app-switcher cover (iOS blur, Android FLAG_SECURE). */
export interface HostScreenPrivacyOperation {
  support(): Observable<HostScreenPrivacySupport>;
  set(enabled: boolean): Observable<HostOperationOutcome>;
  /**
   * Dismiss native UI Trinity presented over the web view, best effort: on iOS the share sheet,
   * browser sheet, camera or photo picker; on Android an open Custom Tab, which Android 10 and
   * later refuse to close while Trinity is in the background.
   */
  dismissPresented(): Observable<HostOperationOutcome>;
}

export function unavailableHostManifest(
  reason: HostUnavailableReason,
  diagnostic?: HostDiagnostic,
): HostCapabilityManifest {
  const support: HostCapabilitySupport = {
    kind: 'unavailable',
    reason,
    ...(diagnostic ? { diagnostic } : {}),
  };
  return {
    protocolVersion: 1,
    operations: {
      'authentication-handoff': support,
      'deep-links': support,
      back: support,
      'file-export': support,
      'notification-presentation': support,
      location: support,
      badge: support,
      'secure-store': support,
      lifecycle: support,
      updates: support,
      'title-bar': support,
      'user-presence': support,
      'lock-integration': support,
      'screen-privacy': support,
    },
  };
}
