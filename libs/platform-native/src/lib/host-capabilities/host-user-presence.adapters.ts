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
  type HostPresenceBiometry,
  type HostPresenceOutcome,
  type HostSystemPresence,
  type HostSystemPresenceUnavailableReason,
  type HostUnavailableReason,
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

/** The PIN half for a host with no PIN store (no plugin, no usable encryption, the web). */
const NO_PIN_STORE: HostPinPresence = {
  kind: 'unavailable',
  reason: 'not-supported',
};

/**
 * A PIN store the host cannot read, or an answer about it that cannot be trusted: never
 * "available, not set" nor "no PIN store" (fail closed).
 */
const PIN_STORE_UNREADABLE: HostPinPresence = {
  kind: 'unavailable',
  reason: 'secure-storage-unavailable',
};

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
    // The desktop shell reports Touch ID only on a Mac, whose sheet offers the account password.
    return biometry === 'touch-id'
      ? { kind, biometry, fallback: 'password' }
      : {
          kind,
          biometry: biometry as Exclude<HostPresenceBiometry, 'touch-id'>,
        };
  }
  if (
    kind === 'unavailable' &&
    SYSTEM_UNAVAILABLE.includes(reason as HostSystemPresenceUnavailableReason)
  ) {
    return { kind, reason: reason as HostSystemPresenceUnavailableReason };
  }
  return { kind: 'unavailable', reason: 'not-supported' };
}

/** Only an explicit "no PIN store" reads as one; anything garbled fails closed. */
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
  if (kind === 'unavailable' && field(raw, 'reason') === 'not-supported') {
    return NO_PIN_STORE;
  }
  return PIN_STORE_UNREADABLE;
}

/**
 * Support as the shell reported it, validated. An unknown system half means "no system
 * prompt"; an unknown PIN half means "PIN store unreadable", so a bad answer fails closed.
 */
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

const MALFORMED_PIN: HostPinOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'electron-malformed-response' },
};
const UNAVAILABLE_REASONS: readonly HostUnavailableReason[] = [
  'not-implemented',
  'not-supported',
  'protocol-mismatch',
  'host-rejected',
];

function instantOrNull(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function diagnosticCode(raw: unknown): string | null {
  const code = field(field(raw, 'diagnostic'), 'code');
  return typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code)
    ? code
    : null;
}

/** A PIN outcome from the shell, validated; only stable fields survive. */
export function parsePinOutcome(raw: unknown): HostPinOutcome {
  const kind = field(raw, 'kind');
  const next = field(raw, 'nextAttemptAt');
  switch (kind) {
    case 'verified':
    case 'invalid':
    case 'unavailable':
      return { kind };
    case 'failed':
      return instantOrNull(next)
        ? { kind, nextAttemptAt: next }
        : MALFORMED_PIN;
    case 'delayed':
      return typeof next === 'number' && Number.isFinite(next)
        ? { kind, nextAttemptAt: next }
        : MALFORMED_PIN;
    case 'rejected': {
      const code = diagnosticCode(raw);
      return code ? { kind, diagnostic: { code } } : MALFORMED_PIN;
    }
    default:
      return MALFORMED_PIN;
  }
}

/** A PIN command's outcome from the shell; an unknown shape is malformed, not "none". */
function parseCommandOutcome(raw: unknown): HostOperationOutcome {
  const kind = field(raw, 'kind');
  const reason = field(raw, 'reason');
  const code = diagnosticCode(raw);
  if (kind === 'completed') return { kind };
  if (
    kind === 'unavailable' &&
    UNAVAILABLE_REASONS.includes(reason as HostUnavailableReason)
  ) {
    return { kind, reason: reason as HostUnavailableReason };
  }
  if (kind === 'rejected' && code) return { kind, diagnostic: { code } };
  return {
    kind: 'rejected',
    diagnostic: { code: 'electron-malformed-response' },
  };
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
