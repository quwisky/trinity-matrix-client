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

export interface HostFileExportOperation {
  save(request: {
    readonly bytes: Blob;
    readonly filename: string;
  }): Observable<HostOperationOutcome>;
}

export interface HostNotificationPresentationOperation {
  presentationSupport(): Observable<HostCapabilitySupport>;
  readonly activated: Observable<{
    readonly roomId: string;
    readonly userId?: string;
  }>;
  requestPermission(): Observable<HostOperationOutcome>;
  present(request: {
    readonly title: string;
    readonly body: string;
    readonly tag?: string;
    readonly silent?: boolean;
    readonly roomId: string;
    readonly userId?: string;
  }): Observable<HostOperationOutcome>;
}

export interface HostLocationOperation {
  locate(request: {
    readonly accuracy: 'precise' | 'approximate';
  }): Observable<
    | { readonly kind: 'located'; readonly lat: number; readonly lng: number }
    | Exclude<HostOperationOutcome, { readonly kind: 'completed' }>
  >;
}

export interface HostBadgeOperation {
  support(): Observable<HostCapabilitySupport>;
  set(count: number): Observable<HostOperationOutcome>;
}

export interface HostSecureStoreOperation {
  available(): Observable<HostCapabilitySupport>;
  get(key: string): Observable<string | null>;
  set(key: string, value: string): Observable<HostOperationOutcome>;
  remove(key: string): Observable<HostOperationOutcome>;
}

export interface HostLifecycleOperation {
  readonly events: Observable<
    { readonly kind: 'active' } | { readonly kind: 'background' }
  >;
}

export interface HostUpdatesOperation {
  check(): Observable<HostOperationOutcome>;
}

/** Compile-time catalogue: every agreed operation has one narrow interface. */
export interface HostOperationContracts {
  readonly 'authentication-handoff': HostAuthenticationHandoffOperation;
  readonly 'deep-links': HostDeepLinksOperation;
  readonly back: HostBackOperation;
  readonly 'file-export': HostFileExportOperation;
  readonly 'notification-presentation': HostNotificationPresentationOperation;
  readonly location: HostLocationOperation;
  readonly badge: HostBadgeOperation;
  readonly 'secure-store': HostSecureStoreOperation;
  readonly lifecycle: HostLifecycleOperation;
  readonly updates: HostUpdatesOperation;
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
    },
  };
}
