import { Injectable, computed, inject, signal } from '@angular/core';
import {
  HostAuthenticationHandoffService,
  HostUserPresenceService,
  NO_USER_PRESENCE,
  type HostOperationOutcome,
  type HostPresenceOutcome,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
} from '@trinity/runtime/preferences';
import {
  BehaviorSubject,
  Observable,
  catchError,
  defaultIfEmpty,
  defer,
  filter,
  finalize,
  forkJoin,
  map,
  of,
  share,
  switchMap,
  take,
  tap,
  timeout,
} from 'rxjs';
import {
  APP_LOCK_ENABLED_PREFERENCE,
  APP_LOCK_LOCK_AFTER_PREFERENCE,
  readAppLockSettings,
  type LockAfter,
} from './app-lock.preferences';
import {
  GUARD_WINDOW_MS,
  PRESENCE_REASONS,
  SUPPORT_TIMEOUT_MS,
  futureOrNull,
  guardOutcome,
  pinUnlockOutcome,
  systemUnlockOutcome,
  withoutPastWait,
  type AppLockCommandOutcome,
  type AppLockPinState,
  type AppLockStatus,
  type GuardOutcome,
  type UnlockOutcome,
} from './app-lock.models';
import { APP_LOCK_CLOCK } from './app-lock.tokens';
import { isValidPin, waitSecondsAfter } from './pin-policy';

/** The app's name where the host reports none (web, mobile, a shell without an identity). */
const DEFAULT_APP_NAME = 'Trinity';

const COMPLETED: AppLockCommandOutcome = { kind: 'completed' };
const NOT_OFFERED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'not-offered',
};
const NOT_VERIFIED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'not-verified',
};
const PIN_NOT_SAVED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'pin-not-saved',
};
const SETTING_NOT_SAVED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'setting-not-saved',
};
const PIN_UNAVAILABLE: UnlockOutcome = { kind: 'unavailable' };
const PROMPT_ENDED: HostPresenceOutcome = { kind: 'cancelled' };
const PROMPT_BROKE: HostPresenceOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'app-lock-prompt-failed' },
};

/** Whether a system prompt's failures count toward the unlock delay (spec §2). */
type PromptPurpose = 'unlock' | 'guard';

function appNameFrom(handoff: HostAuthenticationHandoffService): string {
  try {
    return handoff.deviceDisplayName() || DEFAULT_APP_NAME;
  } catch {
    // A desktop shell without an identity fails sign-in on its own; the prompt still works.
    return DEFAULT_APP_NAME;
  }
}

/**
 * App lock's state and commands (spec 2026-10-12). A privacy screen only: nothing here
 * touches keys or stored data, and no PIN is ever logged, stored or returned. Commands are
 * cold, finite and never error.
 */
@Injectable({ providedIn: 'root' })
export class AppLockService {
  private readonly presence = inject(HostUserPresenceService);
  private readonly preferences = inject(PreferenceStoreService);
  private readonly now = inject(APP_LOCK_CLOCK);
  private readonly _status = signal<AppLockStatus>('unknown');
  private readonly statusChanges = new BehaviorSubject<AppLockStatus>(
    'unknown',
  );
  private readonly _enabled = signal(false);
  private readonly _lockAfter = signal<LockAfter>('1m');
  private readonly _support = signal<HostUserPresenceSupport>(NO_USER_PRESENCE);
  private readonly systemFailures = signal(0);
  private readonly systemFailureAt = signal<number | null>(null);
  /** The one system prompt open now; concurrent callers share it (never two at once). */
  private prompt: Observable<HostPresenceOutcome> | null = null;
  private verifiedAt: number | null = null;

  /** "Trinity", or "Trinity Next" in the desktop prerelease; the window title uses it too. */
  readonly appName = appNameFrom(inject(HostAuthenticationHandoffService));
  readonly status = this._status.asReadonly();
  readonly locked = computed(() => this._status() === 'locked');
  readonly enabled = this._enabled.asReadonly();
  readonly lockAfter = this._lockAfter.asReadonly();
  readonly support = this._support.asReadonly();
  /** App lock can be on here: the host keeps a PIN (decisions 23 and 24). */
  readonly offered = computed(() => this._support().pin.kind === 'available');
  /** The system prompt is primary while it is available (decision 23). */
  readonly systemAvailable = computed(
    () => this._support().system.kind === 'available',
  );
  readonly pinState = computed((): AppLockPinState => {
    const pin = this._support().pin;
    if (pin.kind !== 'available') return 'unavailable';
    return pin.set ? 'ready' : 'not-set';
  });
  /**
   * Locked with no way in but the full reset ("Erase all data on this device"): no system
   * prompt and no usable PIN. Never unlocks; the lock screen offers the reset, and Retry
   * (`refreshSupport`) while the PIN is `unavailable`, which may pass.
   */
  readonly resetOnly = computed(
    () =>
      this.locked() && !this.systemAvailable() && this.pinState() !== 'ready',
  );
  readonly systemWaitUntil = computed(() => {
    const wait = waitSecondsAfter(this.systemFailures());
    const at = this.systemFailureAt();
    return wait > 0 && at !== null ? at + wait * 1000 : null;
  });

  /**
   * Read the settings and the host's support; never errors. Run before the first render.
   * Fails closed: only a readable "off" leaves the lock off. An unreadable setting locks
   * whatever the host says about its PIN, and a host that does not answer within
   * {@link SUPPORT_TIMEOUT_MS} leaves no method available ({@link resetOnly}) until
   * `refreshSupport` hears from it.
   */
  hydrate(): Observable<void> {
    return forkJoin({
      stored: readAppLockSettings(this.preferences),
      support: this.presence.support().pipe(
        take(1),
        timeout({ first: SUPPORT_TIMEOUT_MS, with: () => of(null) }),
        catchError(() => of(null)),
        defaultIfEmpty(null),
      ),
    }).pipe(
      map(({ stored, support }) => {
        if (support) this._support.set(withoutPastWait(support, this.now()));
        this._lockAfter.set(stored.lockAfter);
        const enabled = stored.enabled !== false;
        this._enabled.set(enabled);
        this.setStatus(enabled ? 'locked' : 'off');
      }),
      catchError(() => {
        this._enabled.set(true);
        this.setStatus('locked');
        return of(undefined);
      }),
    );
  }

  /**
   * Re-read the host's support (at every unlock and when Settings opens). Never changes the
   * status: an unreadable setting stays locked even when no PIN is stored. On a host error,
   * or no answer within {@link SUPPORT_TIMEOUT_MS}, it keeps and emits the support it had.
   */
  refreshSupport(): Observable<HostUserPresenceSupport> {
    return defer(() =>
      this.presence.support().pipe(
        take(1),
        map((support) => withoutPastWait(support, this.now())),
        tap((support) => this._support.set(support)),
        timeout({
          first: SUPPORT_TIMEOUT_MS,
          with: () => of(this._support()),
        }),
        catchError(() => of(this._support())),
        defaultIfEmpty(this._support()),
      ),
    );
  }

  lockNow(): void {
    if (this._enabled() && this._status() === 'unlocked') {
      this.setStatus('locked');
    }
  }

  /** Emits once, as soon as nothing is locked (now, if nothing is). Cold. */
  whenUnlocked(): Observable<void> {
    return defer(() =>
      this.statusChanges.pipe(
        filter((status) => status === 'off' || status === 'unlocked'),
        take(1),
        map(() => undefined),
      ),
    );
  }

  unlockWithSystem(): Observable<UnlockOutcome> {
    return defer((): Observable<UnlockOutcome> => {
      if (this._status() !== 'locked') return of({ kind: 'unlocked' });
      const system = this._support().system;
      if (system.kind !== 'available') {
        return of({ kind: 'use-pin', reason: system.reason });
      }
      const until = this.systemWaitUntil();
      if (until !== null && this.now() < until) {
        return of({ kind: 'delayed', until });
      }
      return this.systemPrompt(
        PRESENCE_REASONS.unlock(this.appName),
        'unlock',
      ).pipe(
        map((outcome) => {
          if (outcome.kind === 'verified' && this._status() === 'locked') {
            this.setStatus('unlocked');
          }
          return systemUnlockOutcome(outcome, this.systemWaitUntil());
        }),
      );
    });
  }

  unlockWithPin(pin: string): Observable<UnlockOutcome> {
    return this.checkPin(pin, () => {
      if (this._enabled() && this._status() === 'locked') {
        this.setStatus('unlocked');
      }
    });
  }

  /** Setup step 1: the system prompt. A success opens the 60-second window. */
  confirmPresence(): Observable<HostPresenceOutcome> {
    return this.systemPrompt(PRESENCE_REASONS.enable, 'guard');
  }

  /**
   * Setup step 2: store the PIN, then turn the lock on. Needs a PIN backup on this host
   * (`offered`), and a fresh verification where the system prompt is available. A lock that
   * is already on changes its PIN only through the guarded `changePin`.
   */
  enable(pin: string): Observable<AppLockCommandOutcome> {
    return defer((): Observable<AppLockCommandOutcome> => {
      if (!this.offered()) return of(NOT_OFFERED);
      const needsVerification = this._enabled() || this.systemAvailable();
      if (needsVerification && !this.recentlyVerified()) {
        return of(NOT_VERIFIED);
      }
      if (!isValidPin(pin)) {
        return of({ kind: 'failed', reason: 'pin-invalid' });
      }
      return this.storePin(pin).pipe(
        switchMap((stored) => {
          if (stored.kind !== 'completed') return of(stored);
          return this.save(APP_LOCK_ENABLED_PREFERENCE, true).pipe(
            switchMap((saved) => {
              if (saved.kind === 'completed') {
                this._enabled.set(true);
                this.verifiedAt = this.now();
                this.setStatus('unlocked');
                return of(saved);
              }
              // Not on after all: take the PIN back so nothing half-set remains. A readable
              // "off" wins over a PIN left behind, so a failed clear changes nothing.
              return this.clearPin().pipe(map(() => saved));
            }),
          );
        }),
      );
    });
  }

  /** A guarded change's verification: the system prompt where available. */
  verifyForChange(): Observable<GuardOutcome> {
    return defer((): Observable<GuardOutcome> => {
      if (this.recentlyVerified()) return of('verified');
      if (!this.systemAvailable()) return of('use-pin');
      return this.systemPrompt(PRESENCE_REASONS.change, 'guard').pipe(
        map(guardOutcome),
      );
    });
  }

  verifyPinForChange(pin: string): Observable<UnlockOutcome> {
    return this.checkPin(pin, () => undefined);
  }

  recentlyVerified(): boolean {
    return (
      this.verifiedAt !== null &&
      this.now() - this.verifiedAt <= GUARD_WINDOW_MS
    );
  }

  disable(): Observable<AppLockCommandOutcome> {
    return this.guarded(() =>
      this.save(APP_LOCK_ENABLED_PREFERENCE, false).pipe(
        switchMap((saved) => {
          if (saved.kind !== 'completed') return of(saved);
          this._enabled.set(false);
          this.setStatus('off');
          // A readable "off" wins over a leftover PIN, so a failed clear is not an error.
          return this.clearPin().pipe(map(() => saved));
        }),
      ),
    );
  }

  setLockAfter(lockAfter: LockAfter): Observable<AppLockCommandOutcome> {
    return this.guarded(() =>
      this.save(APP_LOCK_LOCK_AFTER_PREFERENCE, lockAfter).pipe(
        tap((saved) => {
          if (saved.kind === 'completed') this._lockAfter.set(lockAfter);
        }),
      ),
    );
  }

  changePin(pin: string): Observable<AppLockCommandOutcome> {
    return this.guarded(() =>
      isValidPin(pin)
        ? this.storePin(pin)
        : of<AppLockCommandOutcome>({ kind: 'failed', reason: 'pin-invalid' }),
    );
  }

  private guarded(
    command: () => Observable<AppLockCommandOutcome>,
  ): Observable<AppLockCommandOutcome> {
    return defer(() =>
      this.recentlyVerified() ? command() : of(NOT_VERIFIED),
    );
  }

  /** Hand the PIN to the host's verifier; its errors never reach the caller. */
  private storePin(pin: string): Observable<AppLockCommandOutcome> {
    return this.presence.setPin(pin).pipe(
      take(1),
      map((outcome: HostOperationOutcome): AppLockCommandOutcome => {
        if (outcome.kind === 'completed') return COMPLETED;
        return outcome.kind === 'rejected' &&
          outcome.diagnostic.code === 'pin-invalid'
          ? { kind: 'failed', reason: 'pin-invalid' }
          : PIN_NOT_SAVED;
      }),
      catchError(() => of(PIN_NOT_SAVED)),
      defaultIfEmpty(PIN_NOT_SAVED),
    );
  }

  private clearPin(): Observable<void> {
    return this.presence.clearPin().pipe(
      take(1),
      map(() => undefined),
      catchError(() => of(undefined)),
      defaultIfEmpty(undefined),
    );
  }

  private save(
    descriptor:
      | typeof APP_LOCK_ENABLED_PREFERENCE
      | typeof APP_LOCK_LOCK_AFTER_PREFERENCE,
    value: boolean | LockAfter,
  ): Observable<AppLockCommandOutcome> {
    return this.preferences
      .setPreference(descriptor, INSTALLATION_PREFERENCE_CONTEXT, value)
      .pipe(
        take(1),
        map((outcome): AppLockCommandOutcome =>
          outcome.kind === 'completed' ? COMPLETED : SETTING_NOT_SAVED,
        ),
        catchError(() => of(SETTING_NOT_SAVED)),
        defaultIfEmpty(SETTING_NOT_SAVED),
      );
  }

  /**
   * The system prompt, shared: a call while one is open joins it instead of opening a second.
   * Its outcome is recorded once, however many callers share it.
   */
  private systemPrompt(
    reason: string,
    purpose: PromptPurpose,
  ): Observable<HostPresenceOutcome> {
    return defer(() => {
      if (this.prompt) return this.prompt;
      const shared: Observable<HostPresenceOutcome> = this.presence
        .verify({ reason })
        .pipe(
          take(1),
          catchError(() => of(PROMPT_BROKE)),
          defaultIfEmpty(PROMPT_ENDED),
          tap((outcome) => {
            if (this.prompt === shared) this.prompt = null;
            this.recordPrompt(outcome, purpose);
          }),
          finalize(() => {
            if (this.prompt === shared) this.prompt = null;
          }),
          share(),
        );
      this.prompt = shared;
      return shared;
    });
  }

  private recordPrompt(
    outcome: HostPresenceOutcome,
    purpose: PromptPurpose,
  ): void {
    switch (outcome.kind) {
      case 'verified':
        this.systemFailures.set(0);
        this.systemFailureAt.set(null);
        this.verifiedAt = this.now();
        return;
      case 'failed':
        // Only the lock screen's prompt feeds Trinity's delay (spec §2).
        if (purpose === 'unlock') {
          this.systemFailures.update((count) => count + 1);
          this.systemFailureAt.set(this.now());
        }
        return;
      case 'unavailable':
        this._support.update((support) => ({
          ...support,
          system: { kind: 'unavailable', reason: outcome.reason },
        }));
        return;
      case 'cancelled':
      case 'locked-out':
      case 'rejected':
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
      }
    }
  }

  private checkPin(
    pin: string,
    onVerified: () => void,
  ): Observable<UnlockOutcome> {
    return defer((): Observable<UnlockOutcome> => {
      if (!isValidPin(pin)) return of({ kind: 'invalid' });
      return this.presence.verifyPin(pin).pipe(
        take(1),
        map((outcome) => {
          const now = this.now();
          const result = pinUnlockOutcome(outcome, now);
          if (result.kind === 'unlocked') {
            this.verifiedAt = now;
            this.patchPinWait(null);
            onVerified();
          } else if (result.kind === 'failed' || result.kind === 'delayed') {
            this.patchPinWait(futureOrNull(result.until, now));
          }
          return result;
        }),
        catchError(() => of(PIN_UNAVAILABLE)),
        defaultIfEmpty(PIN_UNAVAILABLE),
      );
    });
  }

  private patchPinWait(nextAttemptAt: number | null): void {
    this._support.update((support) =>
      support.pin.kind === 'available'
        ? { ...support, pin: { ...support.pin, nextAttemptAt } }
        : support,
    );
  }

  private setStatus(status: AppLockStatus): void {
    if (status === 'locked') this.verifiedAt = null;
    this._status.set(status);
    this.statusChanges.next(status);
  }
}
