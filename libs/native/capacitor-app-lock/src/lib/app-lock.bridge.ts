import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, catchError, defer, from, map, of, timeout } from 'rxjs';
import { APP_LOCK_PLUGIN_NAME, type AppLockPlugin } from './definitions';

const appLock = registerPlugin<AppLockPlugin>(APP_LOCK_PLUGIN_NAME);

export type AppLockPinStatus =
  | {
      readonly kind: 'ready';
      readonly set: boolean;
      readonly nextAttemptAt: number | null;
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-supported' };

export type AppLockPinCheck =
  | { readonly kind: 'verified' }
  | { readonly kind: 'failed'; readonly nextAttemptAt: number | null }
  | { readonly kind: 'delayed'; readonly nextAttemptAt: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** How a dismissal ended; locking goes on whatever it is (best effort). */
export type AppLockDismissal =
  'completed' | 'failed' | 'timed-out' | 'unavailable';

type VerifyResult = Awaited<ReturnType<AppLockPlugin['verifyPin']>>['result'];

const UNAVAILABLE = { kind: 'unavailable' } as const;

/** How long locking waits for native UI to go before it carries on regardless. */
export const DISMISS_PRESENTED_TIMEOUT_MS = 2_000;

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * A wait's end as the plugin declares it: a finite number or null. Anything else (missing,
 * a string, an infinity) is undefined: a garbled answer, which the caller reads as unavailable.
 */
function waitEnd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The mobile Trinity PIN verifier (iOS Keychain, Android Keystore), written through this
 * package's `TrinityAppLock` plugin, which `cap sync` registers in both hosts. Inert
 * everywhere else, including Electron, whose verifier lives in the main process.
 *
 * Fails closed: an answer outside the declared shape (an older or a hostile build) is
 * unavailable, never "no PIN set", "no wait" or "verified".
 */
@Injectable({ providedIn: 'root' })
export class AppLockPinBridge {
  readonly available =
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable(APP_LOCK_PLUGIN_NAME);

  status(): Observable<AppLockPinStatus> {
    return defer((): Observable<AppLockPinStatus> => {
      if (!this.available) return of({ kind: 'not-supported' });
      return from(appLock.pinStatus()).pipe(
        map((answer: unknown): AppLockPinStatus => {
          if (!isRecord(answer)) return UNAVAILABLE;
          const set = answer['set'];
          const next = waitEnd(answer['nextAttemptAt']);
          if (typeof set !== 'boolean' || next === undefined)
            return UNAVAILABLE;
          return { kind: 'ready', set, nextAttemptAt: next };
        }),
        catchError(() => of<AppLockPinStatus>(UNAVAILABLE)),
      );
    });
  }

  set(pin: string): Observable<'completed' | 'invalid' | 'unavailable'> {
    return defer(() => {
      if (!this.available) return of('unavailable' as const);
      return from(appLock.setPin({ pin })).pipe(
        map(() => 'completed' as const),
        catchError((error: unknown) =>
          of(
            codeOf(error) === 'pin-invalid'
              ? ('invalid' as const)
              : ('unavailable' as const),
          ),
        ),
      );
    });
  }

  verify(pin: string): Observable<AppLockPinCheck> {
    return defer((): Observable<AppLockPinCheck> => {
      if (!this.available) return of(UNAVAILABLE);
      return from(appLock.verifyPin({ pin })).pipe(
        map((answer: unknown): AppLockPinCheck => {
          if (!isRecord(answer)) return UNAVAILABLE;
          // Narrowed by the switch; any other value reaches the default branch at runtime.
          const result = answer['result'] as VerifyResult;
          const next = waitEnd(answer['nextAttemptAt']);
          switch (result) {
            case 'verified':
            case 'invalid':
            case 'unavailable':
              return { kind: result };
            case 'failed':
              return next === undefined
                ? UNAVAILABLE
                : { kind: 'failed', nextAttemptAt: next };
            case 'delayed':
              return next === undefined || next === null
                ? UNAVAILABLE
                : { kind: 'delayed', nextAttemptAt: next };
            default: {
              // A native host answering outside the declared union (an older or a hostile
              // build) is unavailable; the compiler still checks that every result is handled.
              const unhandled: never = result;
              void unhandled;
              return UNAVAILABLE;
            }
          }
        }),
        catchError(() => of<AppLockPinCheck>(UNAVAILABLE)),
      );
    });
  }

  /**
   * Cold and finite: one answer, never an error, even when the call failed or the host never
   * answered. Completed also covers "nothing was presented".
   */
  dismissPresented(): Observable<AppLockDismissal> {
    return defer((): Observable<AppLockDismissal> => {
      if (!this.available) return of('unavailable');
      return from(appLock.dismissPresented()).pipe(
        map((): AppLockDismissal => 'completed'),
        timeout({
          first: DISMISS_PRESENTED_TIMEOUT_MS,
          with: () => of<AppLockDismissal>('timed-out'),
        }),
        catchError(() => of<AppLockDismissal>('failed')),
      );
    });
  }

  clear(): Observable<'completed' | 'unavailable'> {
    return defer(() => {
      if (!this.available) return of('unavailable' as const);
      return from(appLock.clearPin()).pipe(
        map(() => 'completed' as const),
        catchError(() => of('unavailable' as const)),
      );
    });
  }
}
