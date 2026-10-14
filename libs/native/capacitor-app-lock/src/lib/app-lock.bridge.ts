import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
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

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function instant(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The mobile Trinity PIN verifier (iOS Keychain, Android Keystore), written through this
 * package's `TrinityAppLock` plugin, which `cap sync` registers in both hosts. Inert
 * everywhere else, including Electron, whose verifier lives in the main process.
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
        map((result): AppLockPinStatus => ({
          kind: 'ready',
          set: result.set === true,
          nextAttemptAt: instant(result.nextAttemptAt),
        })),
        catchError(() => of<AppLockPinStatus>({ kind: 'unavailable' })),
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
      if (!this.available) return of({ kind: 'unavailable' });
      return from(appLock.verifyPin({ pin })).pipe(
        map((result): AppLockPinCheck => {
          const next = instant(result.nextAttemptAt);
          switch (result.result) {
            case 'verified':
            case 'invalid':
            case 'unavailable':
              return { kind: result.result };
            case 'failed':
              return { kind: 'failed', nextAttemptAt: next };
            case 'delayed':
              return next === null
                ? { kind: 'unavailable' }
                : { kind: 'delayed', nextAttemptAt: next };
            default: {
              // A native host answering outside the declared union (an older or a hostile
              // build) is unavailable; the compiler still checks that every result is handled.
              const unhandled: never = result.result;
              void unhandled;
              return { kind: 'unavailable' };
            }
          }
        }),
        catchError(() => of<AppLockPinCheck>({ kind: 'unavailable' })),
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
