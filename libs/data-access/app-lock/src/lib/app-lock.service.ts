import { Injectable, computed, inject, signal } from '@angular/core';
import {
  HostUserPresenceService,
  NO_USER_PRESENCE,
  injectHostAppName,
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
  forkJoin,
  map,
  of,
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
  type StoredAppLock,
} from './app-lock.preferences';
import {
  COMPLETED,
  GUARD_WINDOW_MS,
  NOT_ALLOWED,
  NOT_OFFERED,
  NOT_VERIFIED,
  NO_ANSWER,
  PIN_NOT_CLEARED,
  PIN_NOT_SAVED,
  PIN_UNAVAILABLE,
  PRESENCE_REASONS,
  SETTINGS_TIMEOUT_MS,
  SETTINGS_UNREADABLE,
  SETTING_NOT_SAVED,
  SUPPORT_TIMEOUT_MS,
  futureOrNull,
  guardOutcome,
  pinStateOf,
  pinUnlockOutcome,
  systemUnlockOutcome,
  unreadableSettingLocks,
  withoutPastWait,
  type AppLockCommandOutcome,
  type AppLockPinState,
  type AppLockStatus,
  type GuardOutcome,
  type UnlockOutcome,
} from './app-lock.models';
import {
  AppLockSystemPrompt,
  type SystemPromptKind,
} from './app-lock-system-prompt';
import { APP_LOCK_CLOCK } from './app-lock.tokens';
import { isValidPin } from './pin-policy';

/**
 * App lock's state and commands (spec 2026-10-12). A privacy screen only: nothing here
 * touches keys or stored data, and no PIN is ever logged, stored or returned. Commands are
 * cold, finite and never error. A lock sticks: an answer to anything started before the
 * latest lock never unlocks or opens the guard window.
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
  private verifiedAt: number | null = null;
  /** The system prompt opened the guard window (not a PIN check, not setup). */
  private verifiedBySystem = false;
  /** The enabled setting could not be read; the host's PIN decides. */
  private settingUnreadable = false;
  /** Counts moves into `locked`; work started before the latest one is stale. */
  private locks = 0;
  private readonly systemPrompt = new AppLockSystemPrompt({
    presence: this.presence,
    now: () => this.now(),
    locks: () => this.locks,
    verified: (kind) => this.presenceVerified(kind),
    unavailable: (reason) =>
      this._support.update((support) => ({
        ...support,
        system: { kind: 'unavailable', reason },
      })),
  });

  /** "Trinity", or "Trinity Next" in the desktop prerelease; the window title uses it too. */
  readonly appName = injectHostAppName();
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
  readonly pinState = computed((): AppLockPinState =>
    pinStateOf(this._support()),
  );
  /**
   * Locked with no system prompt and no usable PIN, so only recovery is left; it never
   * unlocks. With `pinState` `unreadable` the lock screen says "Trinity can't read your PIN
   * right now" and offers Retry (`retry`) and the full reset; otherwise only the full reset
   * ("Erase all data on this device").
   */
  readonly recoveryOnly = computed(
    () =>
      this.locked() && !this.systemAvailable() && this.pinState() !== 'ready',
  );
  /** See {@link AppLockSystemPrompt.waitUntil}: null again once the deadline passes. */
  readonly systemWaitUntil = this.systemPrompt.waitUntil;

  /**
   * Read the settings and the host's support; never errors and always completes. Run before
   * the first render. A readable setting always wins. An unreadable one (or storage that does
   * not answer within 3 s) follows `unreadableSettingLocks`: locked only where the host can
   * verify presence, then a stored PIN decides. A host that does not answer within
   * {@link SUPPORT_TIMEOUT_MS} fails closed until `refreshSupport` or `retry` hears from it.
   */
  hydrate(): Observable<void> {
    return this.load(false);
  }

  /**
   * Re-read the host's support (at every unlock and when Settings opens). While an unreadable
   * setting holds the lock, a host that now shows no lock can exist turns it off. A readable
   * setting is never changed here. On a host error, or no answer within
   * {@link SUPPORT_TIMEOUT_MS}, it keeps and emits the support it had.
   */
  refreshSupport(): Observable<HostUserPresenceSupport> {
    return defer(() =>
      this.presence.support().pipe(
        take(1),
        map((support) => withoutPastWait(support, this.now())),
        tap((support) => {
          this._support.set(support);
          if (
            this.settingUnreadable &&
            this._status() === 'locked' &&
            !unreadableSettingLocks(support)
          ) {
            this.release();
          }
        }),
        timeout({
          first: SUPPORT_TIMEOUT_MS,
          with: () => of(this._support()),
        }),
        catchError(() => of(this._support())),
        defaultIfEmpty(this._support()),
      ),
    );
  }

  /**
   * The lock screen's Retry: re-read the setting (when it was unreadable) and the host's
   * support. It only ever releases a lock (a readable "off"), never unlocks, and never
   * re-locks someone who unlocked meanwhile. Emits once and never errors.
   */
  retry(): Observable<void> {
    return defer(() =>
      this.settingUnreadable && this._status() === 'locked'
        ? this.load(true)
        : this.refreshSupport().pipe(map(() => undefined)),
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
      return this.systemPrompt
        .prompt(PRESENCE_REASONS.unlock(this.appName), 'unlock')
        .pipe(
          // The prompt itself unlocks (see presenceVerified), even if this caller left.
          map((outcome) =>
            systemUnlockOutcome(outcome, this.systemWaitUntil()),
          ),
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
    return this.systemPrompt.prompt(PRESENCE_REASONS.enable, 'enable');
  }

  /**
   * Setup step 2: store the PIN, then turn the lock on. Needs a PIN backup on this host
   * (`offered`), and a fresh verification where the system prompt is available. A lock that
   * is already on changes its PIN only through the guarded `changePin`. A lock that comes
   * while it runs sticks: the lock is on, but nothing unlocks.
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
      const locks = this.locks;
      return this.storePin(pin).pipe(
        switchMap((stored) => {
          if (stored.kind !== 'completed') return of(stored);
          return this.save(APP_LOCK_ENABLED_PREFERENCE, true).pipe(
            switchMap((saved) => {
              if (saved.kind === 'completed') {
                this._enabled.set(true);
                this.settingUnreadable = false;
                if (locks === this.locks && this._status() !== 'locked') {
                  this.openGuardWindow(false);
                  this.setStatus('unlocked');
                }
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
      return this.systemPrompt
        .prompt(PRESENCE_REASONS.change, 'change')
        .pipe(map(guardOutcome));
    });
  }

  /**
   * The guard for replacing a PIN record the host can't read: only the system prompt counts,
   * so a window a PIN check opened doesn't (see {@link changePin}). `use-pin` here means
   * there is no system prompt, and so no way to make that change.
   */
  verifyWithSystemForChange(): Observable<GuardOutcome> {
    return defer((): Observable<GuardOutcome> => {
      if (this.recentlySystemVerified()) return of('verified');
      if (!this.systemAvailable()) return of('use-pin');
      return this.systemPrompt
        .prompt(PRESENCE_REASONS.change, 'change')
        .pipe(map(guardOutcome));
    });
  }

  verifyPinForChange(pin: string): Observable<UnlockOutcome> {
    return this.checkPin(pin, () => undefined, false);
  }

  /** The guard window is open, and the system prompt opened it. */
  recentlySystemVerified(): boolean {
    return this.recentlyVerified() && this.verifiedBySystem;
  }

  recentlyVerified(): boolean {
    return (
      this.verifiedAt !== null &&
      this.now() - this.verifiedAt <= GUARD_WINDOW_MS
    );
  }

  /** Turning the lock off is the person's verified choice; it completes even past a lock. */
  disable(): Observable<AppLockCommandOutcome> {
    return this.guarded(() =>
      this.save(APP_LOCK_ENABLED_PREFERENCE, false).pipe(
        switchMap((saved) => {
          if (saved.kind !== 'completed') return of(saved);
          this.release();
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

  /**
   * A new PIN. Over a PIN record the host can't read, only after the system prompt confirmed
   * it's you inside the guard window (spec §1: someone who forgot the PIN but can use the
   * system prompt resets it this way): the record is cleared, then the new PIN stored, then
   * support re-read. A PIN check alone never replaces a record it couldn't read.
   */
  changePin(pin: string): Observable<AppLockCommandOutcome> {
    return this.guarded(() => {
      if (!isValidPin(pin)) {
        return of<AppLockCommandOutcome>({
          kind: 'failed',
          reason: 'pin-invalid',
        });
      }
      if (this.pinState() !== 'unreadable') return this.storePin(pin);
      if (!this.recentlySystemVerified()) return of(NOT_VERIFIED);
      return this.clearHostPin().pipe(
        switchMap((cleared) =>
          cleared.kind === 'completed' ? this.storePin(pin) : of(cleared),
        ),
        switchMap((outcome) => this.thenRefresh(outcome)),
      );
    });
  }

  /**
   * Settings' way out of a PIN record the host can't read while App lock is readably off
   * (ruling T16-1). With a readable "off" nothing consults the record, so clearing it needs
   * no verification and grants nothing: turning the lock on still runs setup. Refused
   * (`not-allowed`) unless, at call time, the lock is off, the setting was actually read and
   * the PIN store is unreadable; there the full reset stays the only way. Re-reads support
   * afterwards, whatever the host answered.
   */
  clearUnreadablePin(): Observable<AppLockCommandOutcome> {
    return defer(() => {
      if (
        this._enabled() ||
        this.settingUnreadable ||
        this._status() !== 'off' ||
        this.pinState() !== 'unreadable'
      ) {
        return of(NOT_ALLOWED);
      }
      return this.clearHostPin().pipe(
        switchMap((outcome) => this.thenRefresh(outcome)),
      );
    });
  }

  /** Settings was left: the next change needs a fresh verification (decision 7). */
  endGuardWindow(): void {
    this.verifiedAt = null;
    this.verifiedBySystem = false;
  }

  /** Startup reads everything; a Retry only releases a lock that is still in place. */
  private load(retrying: boolean): Observable<void> {
    let answered: HostUserPresenceSupport | null = null;
    return forkJoin({
      stored: readAppLockSettings(this.preferences).pipe(
        timeout({
          first: SETTINGS_TIMEOUT_MS,
          with: () => of(SETTINGS_UNREADABLE),
        }),
      ),
      support: this.presence.support().pipe(
        take(1),
        tap((support) => (answered = support)),
        timeout({ first: SUPPORT_TIMEOUT_MS, with: () => of(null) }),
        catchError(() => of(null)),
        defaultIfEmpty(null),
      ),
    }).pipe(
      map(({ stored, support }) => {
        if (support) this._support.set(withoutPastWait(support, this.now()));
        else if (!retrying) this._support.set(NO_ANSWER);
        this.decide(stored, support, retrying);
      }),
      catchError(() => {
        // Only a bug gets here: read it as an unreadable setting with what the host said.
        this.decide(SETTINGS_UNREADABLE, answered, retrying);
        return of(undefined);
      }),
    );
  }

  private decide(
    stored: StoredAppLock,
    support: HostUserPresenceSupport | null,
    retrying: boolean,
  ): void {
    const enabled =
      stored.enabled === 'unreadable'
        ? unreadableSettingLocks(support)
        : stored.enabled;
    if (retrying) {
      // A Retry never locks: someone may have unlocked while it waited. It only releases.
      this._lockAfter.set(stored.lockAfter);
      this.settingUnreadable = stored.enabled === 'unreadable';
      if (!enabled && this._status() !== 'off') this.release();
      return;
    }
    this._lockAfter.set(stored.lockAfter);
    this.settingUnreadable = stored.enabled === 'unreadable';
    this._enabled.set(enabled);
    this.setStatus(enabled ? 'locked' : 'off');
  }

  /** A prompt verified with no lock since it opened; only an answer that takes effect counts. */
  private presenceVerified(kind: SystemPromptKind): void {
    if (kind === 'unlock' && this._status() !== 'locked') return; // A PIN unlocked first.
    // A settings check never opens the guard window behind the lock.
    if (kind !== 'unlock' && this._status() === 'locked') return;
    this.openGuardWindow(true);
    if (kind === 'unlock') this.setStatus('unlocked');
  }

  private release(): void {
    this.settingUnreadable = false;
    this._enabled.set(false);
    this.setStatus('off');
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

  private openGuardWindow(bySystem: boolean): void {
    this.verifiedAt = this.now();
    this.verifiedBySystem = bySystem;
  }

  /** The host's clear, with its failure kept: unavailable, rejected, an error or no answer. */
  private clearHostPin(): Observable<AppLockCommandOutcome> {
    return this.presence.clearPin().pipe(
      take(1),
      map((outcome) =>
        outcome.kind === 'completed' ? COMPLETED : PIN_NOT_CLEARED,
      ),
      catchError(() => of(PIN_NOT_CLEARED)),
      defaultIfEmpty(PIN_NOT_CLEARED),
    );
  }

  /** `outcome`, once support has been read again (what the PIN store holds now). */
  private thenRefresh(
    outcome: AppLockCommandOutcome,
  ): Observable<AppLockCommandOutcome> {
    return this.refreshSupport().pipe(
      take(1),
      map(() => outcome),
      defaultIfEmpty(outcome),
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

  /** A PIN check; a `verified` answer to a check started before the latest lock is `cancelled`. */
  private checkPin(
    pin: string,
    onVerified: () => void,
    unlocks = true,
  ): Observable<UnlockOutcome> {
    return defer((): Observable<UnlockOutcome> => {
      if (!isValidPin(pin)) return of({ kind: 'invalid' });
      const locks = this.locks;
      return this.presence.verifyPin(pin).pipe(
        take(1),
        map((outcome): UnlockOutcome => {
          const now = this.now();
          const result = pinUnlockOutcome(outcome, now);
          if (result.kind === 'unlocked') {
            this.patchPinWait(null);
            const behindLock = !unlocks && this._status() === 'locked';
            if (locks !== this.locks || behindLock)
              return { kind: 'cancelled' };
            this.openGuardWindow(false);
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
    if (status === 'locked') {
      this.endGuardWindow();
      if (this._status() !== 'locked') this.locks += 1;
    }
    this._status.set(status);
    this.statusChanges.next(status);
  }
}
