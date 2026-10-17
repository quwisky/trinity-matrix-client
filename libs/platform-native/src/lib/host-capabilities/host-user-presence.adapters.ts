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
  AppLockPinBridge,
  type AppLockPinStatus,
} from '@trinity/capacitor-app-lock';
import {
  HOST_USER_PRESENCE_OPERATION,
  HostCapabilitiesService,
  NO_USER_PRESENCE,
  type HostOperationOutcome,
  type HostPinOutcome,
  type HostPinPresence,
  type HostPresenceOutcome,
  type HostSystemPresence,
  type HostUserPresenceOperation,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import {
  Observable,
  catchError,
  defer,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  take,
} from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import {
  NO_PIN_STORE,
  PIN_STORE_UNREADABLE,
  parseCommandOutcome,
  parsePinOutcome,
  parsePresenceOutcome,
  parseUserPresenceSupport,
} from './host-user-presence.electron-response';

const notSupported = (): HostOperationOutcome => ({
  kind: 'unavailable',
  reason: 'not-supported',
});

/**
 * What the device offers for the system prompt. With the device credential allowed, any
 * secure device can prompt (its passcode at least); only a device with no screen lock
 * cannot, and App lock then uses the PIN alone.
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
      // On iPhone and iPad, Touch ID falls back to the device passcode.
      return { kind: 'available', biometry: 'touch-id', fallback: 'passcode' };
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

/** A clear the host could not confirm: the full reset must report it, not skip it. */
const PIN_CLEAR_FAILED: HostOperationOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'pin-clear-failed' },
};

/** The mobile plugin's PIN status as the host contract's PIN half. */
function pinPresenceOf(status: AppLockPinStatus): HostPinPresence {
  switch (status.kind) {
    case 'ready':
      return {
        kind: 'available',
        set: status.set,
        nextAttemptAt: status.nextAttemptAt,
      };
    case 'unavailable':
      return PIN_STORE_UNREADABLE;
    case 'not-supported':
      return NO_PIN_STORE;
    default: {
      const unhandled: never = status;
      void unhandled;
      return PIN_STORE_UNREADABLE;
    }
  }
}

/** The web and PWA have no App lock. */
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

/**
 * iOS and Android: Face ID, Touch ID or fingerprint, with the passcode in the prompt; the
 * Trinity PIN through the `TrinityAppLock` plugin (Keychain, Keystore).
 */
@Injectable({ providedIn: 'root' })
export class CapacitorUserPresenceAdapter implements HostUserPresenceOperation {
  private readonly pins = inject(AppLockPinBridge);

  support(): Observable<HostUserPresenceSupport> {
    const system = defer(() => from(BiometricAuth.checkBiometry())).pipe(
      map(systemPresenceOf),
      catchError(() =>
        of<HostSystemPresence>({
          kind: 'unavailable',
          reason: 'not-supported',
        }),
      ),
    );
    const pin = defer(() => this.pins.status()).pipe(
      map(pinPresenceOf),
      catchError(() => of(PIN_STORE_UNREADABLE)),
    );
    return forkJoin({ system, pin });
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

  setPin(pin: string): Observable<HostOperationOutcome> {
    return defer(() => this.pins.set(pin)).pipe(
      map((result): HostOperationOutcome => {
        switch (result) {
          case 'completed':
            return { kind: 'completed' };
          case 'invalid':
            return { kind: 'rejected', diagnostic: { code: 'pin-invalid' } };
          case 'unavailable':
            return notSupported();
          default: {
            const unhandled: never = result;
            void unhandled;
            return notSupported();
          }
        }
      }),
      catchError(() => of(notSupported())),
    );
  }

  /** `AppLockPinCheck` is a subset of `HostPinOutcome`, so it passes through unchanged. */
  verifyPin(pin: string): Observable<HostPinOutcome> {
    return defer(() => this.pins.verify(pin)).pipe(
      catchError(() => of<HostPinOutcome>({ kind: 'unavailable' })),
    );
  }

  /**
   * Without the plugin there is no PIN, so nothing to clear. With it, a clear the plugin
   * could not confirm is a failure, so the full reset reports it instead of skipping it.
   */
  clearPin(): Observable<HostOperationOutcome> {
    return defer(() => this.pins.clear()).pipe(
      map((result): HostOperationOutcome => {
        if (result === 'completed') return { kind: 'completed' };
        return this.pins.available ? PIN_CLEAR_FAILED : notSupported();
      }),
      catchError(() => of(PIN_CLEAR_FAILED)),
    );
  }
}

/** Electron: the main process's system prompt (Touch ID on macOS) and the Trinity PIN. */
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
        // Without the granted operation the shell has no PIN store. With it, a failed
        // call says nothing about the store, so the PIN half fails closed as on mobile.
        return granted && bridge
          ? defer(() => bridge.support()).pipe(
              map(parseUserPresenceSupport),
              catchError(() =>
                of<HostUserPresenceSupport>({
                  system: NO_USER_PRESENCE.system,
                  pin: PIN_STORE_UNREADABLE,
                }),
              ),
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

  setPin(pin: string): Observable<HostOperationOutcome> {
    return this.granted.pipe(
      switchMap((granted) => {
        const bridge = getTrinityDesktopBridge()?.capabilities.userPresence;
        return granted && bridge
          ? from(bridge.setPin(pin)).pipe(
              map(parseCommandOutcome),
              catchError(() => of(notSupported())),
            )
          : of(notSupported());
      }),
    );
  }

  verifyPin(pin: string): Observable<HostPinOutcome> {
    return this.granted.pipe(
      switchMap((granted): Observable<HostPinOutcome> => {
        const bridge = getTrinityDesktopBridge()?.capabilities.userPresence;
        return granted && bridge
          ? from(bridge.verifyPin(pin)).pipe(
              map(parsePinOutcome),
              catchError(() => of<HostPinOutcome>({ kind: 'unavailable' })),
            )
          : of<HostPinOutcome>({ kind: 'unavailable' });
      }),
    );
  }

  /** Without the granted operation there is no shell PIN, so nothing to clear. */
  clearPin(): Observable<HostOperationOutcome> {
    return this.granted.pipe(
      switchMap((granted) => {
        const bridge = getTrinityDesktopBridge()?.capabilities.userPresence;
        return granted && bridge
          ? from(bridge.clearPin()).pipe(
              map(parseCommandOutcome),
              catchError(() => of(PIN_CLEAR_FAILED)),
            )
          : of(notSupported());
      }),
    );
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
