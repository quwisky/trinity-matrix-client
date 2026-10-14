import { Injectable, Provider, inject } from '@angular/core';
import {
  BiometricAuth,
  BiometryErrorType,
  BiometryType,
  isBiometryErrorType,
  type CheckBiometryResult,
} from '@aparajita/capacitor-biometric-auth';
import { Capacitor } from '@capacitor/core';
import {
  HOST_USER_PRESENCE_OPERATION,
  HostCapabilitiesService,
  NO_USER_PRESENCE,
  type HostOperationOutcome,
  type HostPinOutcome,
  type HostPinPresence,
  type HostPresenceBiometry,
  type HostPresenceOutcome,
  type HostSystemPresence,
  type HostSystemPresenceUnavailableReason,
  type HostUserPresenceOperation,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  take,
} from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';

/** The PIN half until a host's verifier exists (PR 2 replaces it per host). */
export const PIN_NOT_YET: HostPinPresence = {
  kind: 'unavailable',
  reason: 'not-supported',
};

const notSupported = (): HostOperationOutcome => ({
  kind: 'unavailable',
  reason: 'not-supported',
});

/**
 * What the device offers for the system prompt. With the device credential allowed, any
 * secure device can prompt (its passcode at least); only a device with no screen lock
 * cannot, and App lock then uses the PIN alone (decision 24).
 */
export function systemPresenceOf(
  result: CheckBiometryResult,
): HostSystemPresence {
  if (!result.deviceIsSecure) {
    return { kind: 'unavailable', reason: 'no-device-credential' };
  }
  if (!result.isAvailable) {
    return { kind: 'available', biometry: 'passcode-only' };
  }
  switch (result.biometryType) {
    case BiometryType.faceId:
    case BiometryType.faceAuthentication:
      return { kind: 'available', biometry: 'face' };
    case BiometryType.touchId:
      return { kind: 'available', biometry: 'touch-id' };
    case BiometryType.fingerprintAuthentication:
      return { kind: 'available', biometry: 'fingerprint' };
    case BiometryType.irisAuthentication:
    case BiometryType.none:
      return { kind: 'available', biometry: 'passcode-only' };
    default: {
      const unhandled: never = result.biometryType;
      void unhandled;
      return { kind: 'available', biometry: 'passcode-only' };
    }
  }
}

/** A stable outcome for whatever `authenticate` rejected with; never its message. */
export function presenceOutcomeOfError(error: unknown): HostPresenceOutcome {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  if (!isBiometryErrorType(code)) {
    return { kind: 'rejected', diagnostic: { code: 'presence-failed' } };
  }
  switch (code) {
    case BiometryErrorType.userCancel:
    case BiometryErrorType.systemCancel:
    case BiometryErrorType.appCancel:
    case BiometryErrorType.userFallback:
      return { kind: 'cancelled' };
    case BiometryErrorType.authenticationFailed:
      return { kind: 'failed' };
    case BiometryErrorType.biometryLockout:
      return { kind: 'locked-out' };
    case BiometryErrorType.passcodeNotSet:
    case BiometryErrorType.noDeviceCredential:
      return { kind: 'unavailable', reason: 'no-device-credential' };
    case BiometryErrorType.biometryNotEnrolled:
      return { kind: 'unavailable', reason: 'not-enrolled' };
    case BiometryErrorType.biometryNotAvailable:
      return { kind: 'unavailable', reason: 'not-supported' };
    case BiometryErrorType.none:
    case BiometryErrorType.invalidContext:
    case BiometryErrorType.notInteractive:
      return { kind: 'rejected', diagnostic: { code: 'presence-failed' } };
    default: {
      const unhandled: never = code;
      void unhandled;
      return { kind: 'rejected', diagnostic: { code: 'presence-failed' } };
    }
  }
}

/** The web and PWA have no App lock (decision 3). */
@Injectable({ providedIn: 'root' })
export class WebUserPresenceAdapter implements HostUserPresenceOperation {
  support(): Observable<HostUserPresenceSupport> {
    return defer(() => of(NO_USER_PRESENCE));
  }

  verify(): Observable<HostPresenceOutcome> {
    return defer(() =>
      of<HostPresenceOutcome>({ kind: 'unavailable', reason: 'not-supported' }),
    );
  }

  setPin(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }

  verifyPin(): Observable<HostPinOutcome> {
    return defer(() => of<HostPinOutcome>({ kind: 'unavailable' }));
  }

  clearPin(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
}

/** iOS and Android: Face ID, Touch ID or fingerprint, with the passcode in the prompt. */
@Injectable({ providedIn: 'root' })
export class CapacitorUserPresenceAdapter implements HostUserPresenceOperation {
  support(): Observable<HostUserPresenceSupport> {
    return defer(() => from(BiometricAuth.checkBiometry())).pipe(
      map((result): HostUserPresenceSupport => ({
        system: systemPresenceOf(result),
        pin: PIN_NOT_YET,
      })),
      catchError(() =>
        of<HostUserPresenceSupport>({
          system: { kind: 'unavailable', reason: 'not-supported' },
          pin: PIN_NOT_YET,
        }),
      ),
    );
  }

  verify(request: {
    readonly reason: string;
  }): Observable<HostPresenceOutcome> {
    return defer(() =>
      from(
        BiometricAuth.authenticate({
          reason: request.reason,
          cancelTitle: 'Cancel',
          allowDeviceCredential: true,
          iosFallbackTitle: 'Use passcode',
          androidTitle: 'Trinity',
          androidSubtitle: request.reason,
          // Face unlock on Android needs no extra tap.
          androidConfirmationRequired: false,
        }),
      ),
    ).pipe(
      map((): HostPresenceOutcome => ({ kind: 'verified' })),
      catchError((error: unknown) => of(presenceOutcomeOfError(error))),
    );
  }

  setPin(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }

  verifyPin(): Observable<HostPinOutcome> {
    return defer(() => of<HostPinOutcome>({ kind: 'unavailable' }));
  }

  clearPin(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
}

const BIOMETRIES: readonly HostPresenceBiometry[] = [
  'face',
  'fingerprint',
  'touch-id',
  'windows-hello',
  'passcode-only',
];
const SYSTEM_UNAVAILABLE: readonly HostSystemPresenceUnavailableReason[] = [
  'not-supported',
  'no-device-credential',
  'not-enrolled',
  'not-configured',
  'disabled-by-policy',
  'windows-version',
  'addon-unavailable',
  'locked-out',
];
const MALFORMED: HostPresenceOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'electron-malformed-response' },
};

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function systemOf(raw: unknown): HostSystemPresence {
  const kind = field(raw, 'kind');
  const biometry = field(raw, 'biometry');
  const reason = field(raw, 'reason');
  if (
    kind === 'available' &&
    BIOMETRIES.includes(biometry as HostPresenceBiometry)
  ) {
    return { kind, biometry: biometry as HostPresenceBiometry };
  }
  if (
    kind === 'unavailable' &&
    SYSTEM_UNAVAILABLE.includes(reason as HostSystemPresenceUnavailableReason)
  ) {
    return { kind, reason: reason as HostSystemPresenceUnavailableReason };
  }
  return { kind: 'unavailable', reason: 'not-supported' };
}

function pinOf(raw: unknown): HostPinPresence {
  const kind = field(raw, 'kind');
  const next = field(raw, 'nextAttemptAt');
  if (
    kind === 'available' &&
    typeof field(raw, 'set') === 'boolean' &&
    (next === null || (typeof next === 'number' && Number.isFinite(next)))
  ) {
    return {
      kind,
      set: field(raw, 'set') as boolean,
      nextAttemptAt: next as number | null,
    };
  }
  if (
    kind === 'unavailable' &&
    field(raw, 'reason') === 'secure-storage-unavailable'
  ) {
    return { kind, reason: 'secure-storage-unavailable' };
  }
  return PIN_NOT_YET;
}

/** Support as the shell reported it, validated; anything unknown means "not offered". */
export function parseUserPresenceSupport(
  raw: unknown,
): HostUserPresenceSupport {
  return {
    system: systemOf(field(raw, 'system')),
    pin: pinOf(field(raw, 'pin')),
  };
}

/** A prompt outcome from the shell, validated; only stable fields survive. */
export function parsePresenceOutcome(raw: unknown): HostPresenceOutcome {
  const kind = field(raw, 'kind');
  switch (kind) {
    case 'verified':
    case 'cancelled':
    case 'failed':
    case 'locked-out':
      return { kind };
    case 'unavailable': {
      const reason = field(raw, 'reason');
      return SYSTEM_UNAVAILABLE.includes(
        reason as HostSystemPresenceUnavailableReason,
      )
        ? { kind, reason: reason as HostSystemPresenceUnavailableReason }
        : MALFORMED;
    }
    case 'rejected': {
      const code = field(field(raw, 'diagnostic'), 'code');
      return typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code)
        ? { kind, diagnostic: { code } }
        : MALFORMED;
    }
    default:
      return MALFORMED;
  }
}

/** Electron: the main process's system prompt (Touch ID on macOS) and, from PR 2, PIN. */
@Injectable({ providedIn: 'root' })
export class ElectronUserPresenceAdapter implements HostUserPresenceOperation {
  private readonly capabilities = inject(HostCapabilitiesService);

  private readonly granted: Observable<boolean> = defer(() =>
    this.capabilities.manifest(),
  ).pipe(
    take(1),
    map(
      (manifest) => manifest.operations['user-presence'].kind === 'supported',
    ),
  );

  support(): Observable<HostUserPresenceSupport> {
    return this.granted.pipe(
      switchMap((granted) => {
        const bridge = getTrinityDesktopBridge()?.capabilities.userPresence;
        return granted && bridge
          ? from(bridge.support()).pipe(
              map(parseUserPresenceSupport),
              catchError(() => of(NO_USER_PRESENCE)),
            )
          : of(NO_USER_PRESENCE);
      }),
    );
  }

  verify(request: {
    readonly reason: string;
  }): Observable<HostPresenceOutcome> {
    return this.granted.pipe(
      switchMap((granted): Observable<HostPresenceOutcome> => {
        const bridge = getTrinityDesktopBridge()?.capabilities.userPresence;
        return granted && bridge
          ? from(bridge.verify(request.reason)).pipe(
              map(parsePresenceOutcome),
              catchError(() =>
                of<HostPresenceOutcome>({
                  kind: 'rejected',
                  diagnostic: { code: 'presence-failed' },
                }),
              ),
            )
          : of<HostPresenceOutcome>({
              kind: 'unavailable',
              reason: 'not-supported',
            });
      }),
    );
  }

  setPin(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }

  verifyPin(): Observable<HostPinOutcome> {
    return defer(() => of<HostPinOutcome>({ kind: 'unavailable' }));
  }

  clearPin(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
}

/** Select the user-presence adapter once at the composition root. */
export function userPresenceProvider(): Provider {
  return {
    provide: HOST_USER_PRESENCE_OPERATION,
    useFactory: (): HostUserPresenceOperation =>
      getTrinityDesktopBridge()
        ? inject(ElectronUserPresenceAdapter)
        : Capacitor.isNativePlatform()
          ? inject(CapacitorUserPresenceAdapter)
          : inject(WebUserPresenceAdapter),
  };
}
