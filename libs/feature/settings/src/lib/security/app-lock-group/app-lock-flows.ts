import { Injectable, computed, inject } from '@angular/core';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  AppLockService,
  type AppLockCommandOutcome,
} from '@trinity/data-access/app-lock';
import type { HostPresenceOutcome } from '@trinity/runtime/host';
import {
  Observable,
  defaultIfEmpty,
  defer,
  map,
  of,
  switchMap,
  take,
} from 'rxjs';
import {
  failureMessage,
  methodWarningName,
  noPinToCheckMessage,
} from './app-lock-group.copy';
import {
  AppLockPinDialogComponent,
  type AppLockPinDialogResult,
} from './app-lock-pin-dialog.component';

/**
 * Where a flow ended: a command's own outcome, stopped by the person (a cancelled prompt or
 * dialog, which says nothing), or refused before any command ran, with the reason to show.
 */
export type AppLockFlowEnd =
  | AppLockCommandOutcome
  | { readonly kind: 'stopped' }
  | { readonly kind: 'refused'; readonly message: string };

export const STOPPED: AppLockFlowEnd = { kind: 'stopped' };

type Guard = (
  command: () => Observable<AppLockFlowEnd>,
) => Observable<AppLockFlowEnd>;

/** App lock setup and guarded changes; each flow ends with exactly one {@link AppLockFlowEnd}. */
@Injectable()
export class AppLockFlows {
  private readonly appLock = inject(AppLockService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly appName = this.appLock.appName;
  /** Everything the system prompt accepts, for the forgotten-PIN warning. */
  private readonly warningMethod = computed(() => {
    const system = this.appLock.support().system;
    return system.kind === 'available' ? methodWarningName(system) : null;
  });

  turnOn(): Observable<AppLockFlowEnd> {
    return this.confirmForSetup(true).pipe(
      switchMap((ended) =>
        ended
          ? of(ended)
          : this.askNewPin().pipe(
              switchMap((pin) =>
                pin
                  ? // Typing the PIN may outlast the 60-second window: prompt again if so.
                    this.confirmForSetup(false).pipe(
                      switchMap((again) =>
                        again ? of(again) : this.appLock.enable(pin),
                      ),
                    )
                  : of(STOPPED),
              ),
            ),
      ),
    );
  }

  /**
   * Change PIN: a fresh check, the new PIN twice, then (still verified) the change. Over a
   * PIN record the host can't read, only the system prompt counts as the check: the service
   * then clears the record and stores the new PIN.
   */
  changePin(): Observable<AppLockFlowEnd> {
    return defer(() => {
      const guard: Guard =
        this.appLock.pinState() === 'unreadable'
          ? (command) => this.systemGuarded(command)
          : (command) => this.guarded(command);
      return guard(() =>
        this.askNewPin().pipe(
          switchMap((pin) =>
            // Typing the new PIN may outlast the guard window: check again if it did.
            pin ? guard(() => this.appLock.changePin(pin)) : of(STOPPED),
          ),
        ),
      );
    });
  }

  /** Readably off over a PIN record that can't be read: clear it. */
  clearUnreadablePin(): Observable<AppLockFlowEnd> {
    return this.appLock.clearUnreadablePin();
  }

  /** A change after setup: a fresh verification first, unless one is recent (60 s). */
  guarded(
    command: () => Observable<AppLockFlowEnd>,
  ): Observable<AppLockFlowEnd> {
    return defer(() => {
      if (this.appLock.recentlyVerified()) return command();
      return this.appLock.verifyForChange().pipe(
        switchMap((guard): Observable<AppLockFlowEnd> => {
          switch (guard) {
            case 'verified':
              return command();
            case 'cancelled':
              return of(STOPPED);
            case 'use-pin':
              return this.withPin(command);
            default: {
              const unhandled: never = guard;
              void unhandled;
              return of(STOPPED);
            }
          }
        }),
      );
    });
  }

  /** A guard only the system prompt passes: the PIN can't be checked against a broken record. */
  private systemGuarded(
    command: () => Observable<AppLockFlowEnd>,
  ): Observable<AppLockFlowEnd> {
    return defer(() => {
      if (this.appLock.recentlySystemVerified()) return command();
      return this.appLock.verifyWithSystemForChange().pipe(
        switchMap((guard): Observable<AppLockFlowEnd> => {
          switch (guard) {
            case 'verified':
              return command();
            case 'cancelled':
              return of(STOPPED);
            case 'use-pin':
              return of<AppLockFlowEnd>({
                kind: 'refused',
                message: noPinToCheckMessage('unreadable', this.appName),
              });
            default: {
              const unhandled: never = guard;
              void unhandled;
              return of(STOPPED);
            }
          }
        }),
      );
    });
  }

  /**
   * Setup's system prompt: null when setup may go on, else where it ended. The first step
   * (`always`) prompts even inside the guard window; the second only once it has closed.
   */
  private confirmForSetup(always: boolean): Observable<AppLockFlowEnd | null> {
    return defer(() => {
      if (!this.appLock.systemAvailable()) return of(null);
      if (!always && this.appLock.recentlyVerified()) return of(null);
      return this.appLock
        .confirmPresence()
        .pipe(map((outcome) => this.setupStep(outcome)));
    });
  }

  private setupStep(outcome: HostPresenceOutcome): AppLockFlowEnd | null {
    switch (outcome.kind) {
      case 'verified':
        return null;
      // The system said why; Trinity says nothing more.
      case 'cancelled':
      case 'failed':
        return STOPPED;
      // The prompt can't run here now, so the PIN alone protects the lock.
      case 'unavailable':
        return null;
      case 'locked-out':
      case 'rejected':
        return {
          kind: 'refused',
          message: failureMessage('enable', 'not-verified', this.appName),
        };
      default: {
        const unhandled: never = outcome;
        void unhandled;
        return STOPPED;
      }
    }
  }

  /** The guard's fallback: the current PIN, unless there is none that can be checked. */
  private withPin(
    command: () => Observable<AppLockFlowEnd>,
  ): Observable<AppLockFlowEnd> {
    const pin = this.appLock.pinState();
    if (pin !== 'ready') {
      return of<AppLockFlowEnd>({
        kind: 'refused',
        message: noPinToCheckMessage(pin, this.appName),
      });
    }
    return this.askPin('verify').pipe(
      switchMap((result) =>
        result?.kind === 'verified' ? command() : of(STOPPED),
      ),
    );
  }

  private askNewPin(): Observable<string | null> {
    return this.askPin('set').pipe(
      map((result) => (result?.kind === 'pin' ? result.pin : null)),
    );
  }

  private askPin(
    mode: 'set' | 'verify',
  ): Observable<AppLockPinDialogResult | undefined> {
    return defer(() =>
      this.surfaces
        .open<AppLockPinDialogResult, AppLockPinDialogComponent>(
          AppLockPinDialogComponent,
          {
            ariaLabel:
              mode === 'set'
                ? `Set a ${this.appName} PIN`
                : `Enter your ${this.appName} PIN`,
            // The forgotten-PIN warning describes the set dialog.
            ...(mode === 'set'
              ? { ariaDescribedBy: 'app-lock-pin-warning' }
              : {}),
            autoFocus: '[data-autofocus]',
            inputs: { mode, methodName: this.warningMethod() },
          },
        )
        .closed.pipe(
          take(1),
          map((result) => result ?? undefined),
          defaultIfEmpty(undefined),
        ),
    );
  }
}
