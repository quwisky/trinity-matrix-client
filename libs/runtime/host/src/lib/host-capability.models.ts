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
  open(request: { readonly url: string }): Observable<HostOperationOutcome>;
  /**
   * The name of a Matrix device this host signs in or registers, also sent as the OIDC
   * client name. Optional: a host without one of its own is "Trinity".
   */
  deviceDisplayName?(): string;
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
    },
  };
}
