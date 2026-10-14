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
  NO_USER_PRESENCE,
  type HostOperationOutcome,
  type HostPinOutcome,
  type HostPinPresence,
  type HostPresenceOutcome,
  type HostSystemPresence,
  type HostUserPresenceOperation,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

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

/** Select the user-presence adapter once at the composition root. */
export function userPresenceProvider(): Provider {
  return {
    provide: HOST_USER_PRESENCE_OPERATION,
    useFactory: (): HostUserPresenceOperation =>
      Capacitor.isNativePlatform()
        ? inject(CapacitorUserPresenceAdapter)
        : inject(WebUserPresenceAdapter),
  };
}
