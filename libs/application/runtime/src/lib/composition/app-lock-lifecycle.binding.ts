import { DOCUMENT } from '@angular/common';
import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { TitleBarState } from '@trinity/application/workspace';
import {
  APP_LOCK_CLOCK,
  AppLockService,
  DESKTOP_IMMEDIATE_GRACE_MS,
  awayVerdict,
  type AppLockSurface,
} from '@trinity/data-access/app-lock';
import {
  KeyboardShortcutsService,
  chordToAccelerator,
  getTrinityDesktopBridge,
} from '@trinity/platform-native';
import {
  HostLifecycleService,
  HostLockIntegrationService,
  HostSystemUiService,
} from '@trinity/runtime/host';
import {
  Observable,
  Subscription,
  defer,
  finalize,
  fromEvent,
  ignoreElements,
  map,
  merge,
  of,
  switchMap,
  tap,
  timer,
} from 'rxjs';

/**
 * `hidden`: away because the host hid or minimised the app, which the shell may hold.
 * `shown`: back because the host reports the app on screen again; `back` is focus alone.
 */
type AwayEvent =
  | 'hidden'
  | 'away'
  | 'shown'
  | 'back'
  | 'system-ui-opened'
  | 'system-ui-closed';

/** Time away since `since`; `floorMs` is the least that locks (see SYSTEM_UI_CLOSED_GRACE_MS). */
interface AwayPeriod {
  readonly since: number;
  readonly floorMs: number;
}

/**
 * When Trinity's own system UI closes while the app is still away, time away counts from
 * then, and never locks sooner than this: Android's device-credential screen answers before
 * the app reports it is back, and "Immediately" must not lock behind it.
 */
const SYSTEM_UI_CLOSED_GRACE_MS = DESKTOP_IMMEDIATE_GRACE_MS;

/**
 * App lock's part of the shell (decision 14): the away timer over the host lifecycle and,
 * on desktop, window focus; the shell's lock requests; the state and accelerator the shell
 * shows; and the window title. Time in Trinity's own system UI is not "away" (Review
 * Focus 1): it never starts the timer, and it stops one that is running.
 */
@Injectable({ providedIn: 'root' })
export class AppLockLifecycleBinding {
  private readonly appLock = inject(AppLockService);
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly lockIntegration = inject(HostLockIntegrationService);
  private readonly systemUi = inject(HostSystemUiService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly titleBar = inject(TitleBarState);
  private readonly injector = inject(Injector);
  private readonly now = inject(APP_LOCK_CLOCK);
  private readonly window = inject(DOCUMENT).defaultView;

  readonly surface: AppLockSurface = getTrinityDesktopBridge()
    ? 'desktop'
    : 'mobile';

  run(): Observable<never> {
    return merge(
      this.awayTimer(),
      this.lockIntegration.requests.pipe(
        tap(() => this.appLock.lockNow()),
        ignoreElements(),
      ),
      this.changes(() => ({
        enabled: this.appLock.enabled(),
        locked: this.appLock.locked(),
        accelerator: chordToAccelerator(this.shortcuts.binding('lock.now')),
      })).pipe(
        switchMap((state) => this.lockIntegration.setState(state)),
        ignoreElements(),
      ),
      this.changes(() => this.appLock.locked()).pipe(
        tap((locked) => this.titleBar.setLocked(locked)),
        ignoreElements(),
      ),
    );
  }

  private presence(): Observable<'hidden' | 'away' | 'shown' | 'back'> {
    const lifecycle = this.lifecycle.events.pipe(
      map((event) =>
        event.kind === 'background' ? ('hidden' as const) : ('shown' as const),
      ),
    );
    if (this.surface !== 'desktop' || !this.window) return lifecycle;
    // Focus also counts as back: some restores (a minimised maximised window on Windows)
    // emit neither show nor restore, and the window must not lock in front of the person.
    return merge(
      lifecycle,
      fromEvent(this.window, 'blur').pipe(map(() => 'away' as const)),
      fromEvent(this.window, 'focus').pipe(map(() => 'back' as const)),
    );
  }

  private awayTimer(): Observable<never> {
    return defer(() => {
      let away = false;
      // Hidden or minimised and not yet reported shown: only then can the shell hold the window.
      let hidden = false;
      let period: AwayPeriod | null = null;
      let pending: Subscription | undefined;
      let reveal: Subscription | undefined;

      const stop = (): void => {
        period = null;
        pending?.unsubscribe();
        pending = undefined;
      };
      const begin = (floorMs: number): void => {
        if (
          period ||
          this.appLock.status() !== 'unlocked' ||
          this.systemUi.active()
        ) {
          return;
        }
        period = { since: this.now(), floorMs };
        const wait = this.remainingMs(period);
        if (wait <= 0) {
          stop();
          this.appLock.lockNow();
          return;
        }
        pending = timer(wait).subscribe(() => {
          stop();
          this.appLock.lockNow();
        });
      };
      const back = (shown: boolean): void => {
        const ended = period;
        const wasLocked = this.appLock.locked();
        const wasHidden = hidden;
        // Only the host's own report ends the hidden state. A DOM focus can arrive before the
        // shell starts its reveal, which then ignores that first signal; the report sends it again.
        if (shown) hidden = false;
        stop();
        if (
          ended &&
          this.appLock.status() === 'unlocked' &&
          this.remainingMs(ended) <= 0
        ) {
          this.appLock.lockNow();
        }
        reveal?.unsubscribe();
        reveal = undefined;
        // The shell holds a window only while App lock is on and only after hiding it, so a
        // focus change alone, or an app without the lock, has nothing to reveal.
        if (wasHidden && this.appLock.enabled()) {
          reveal = this.revealHeldWindow(wasLocked).subscribe();
        }
      };

      return merge(
        this.presence(),
        this.changes(() => this.systemUi.active()).pipe(
          map((open) => (open ? 'system-ui-opened' : 'system-ui-closed')),
        ),
      ).pipe(
        tap((event: AwayEvent) => {
          switch (event) {
            case 'hidden':
              hidden = true;
              away = true;
              begin(0);
              return;
            case 'away':
              away = true;
              begin(0);
              return;
            case 'shown':
              away = false;
              back(true);
              return;
            case 'back':
              away = false;
              back(false);
              return;
            case 'system-ui-opened':
              stop();
              return;
            case 'system-ui-closed':
              if (away) begin(SYSTEM_UI_CLOSED_GRACE_MS);
              return;
            default: {
              const unhandled: never = event;
              void unhandled;
            }
          }
        }),
        ignoreElements(),
        finalize(() => {
          stop();
          reveal?.unsubscribe();
        }),
      );
    });
  }

  /** Milliseconds until the period locks; zero or less locks now. */
  private remainingMs(period: AwayPeriod): number {
    const now = this.now();
    const verdict = awayVerdict({
      awaySince: period.since,
      now,
      lockAfter: this.appLock.lockAfter(),
      surface: this.surface,
    });
    const elapsed = now - period.since;
    // A clock that went backwards (or is not finite) locks whatever the floor says.
    const floorLeft =
      Number.isFinite(elapsed) && elapsed >= 0 ? period.floorMs - elapsed : 0;
    return Math.max(
      verdict.kind === 'wait' ? verdict.remainingMs : 0,
      floorLeft,
    );
  }

  /**
   * Back on screen: let the shell show a window it held hidden. With nothing locked it can
   * show at once. A window that was already locked tells it again once the cover has
   * painted, as the cover signalled only when it opened. A lock that starts now leaves the
   * signal to the cover as it opens.
   */
  private revealHeldWindow(wasLocked: boolean): Observable<unknown> {
    if (!this.appLock.locked()) return this.lockIntegration.coverPainted();
    if (!wasLocked) return of(undefined);
    return this.afterPaint().pipe(
      switchMap(() => this.lockIntegration.coverPainted()),
    );
  }

  /** Emits once the current frame has painted: the first frame lays out, the second paints. */
  private afterPaint(): Observable<void> {
    const view = this.window;
    if (!view) return of(undefined);
    return new Observable<void>((subscriber) => {
      let frame = view.requestAnimationFrame(() => {
        frame = view.requestAnimationFrame(() => {
          subscriber.next();
          subscriber.complete();
        });
      });
      return () => view.cancelAnimationFrame(frame);
    });
  }

  /** A signal read as a stream of its values, for as long as it is subscribed. */
  private changes<T>(read: () => T): Observable<T> {
    return new Observable<T>((subscriber) => {
      const ref = effect(
        () => {
          const value = read();
          untracked(() => subscriber.next(value));
        },
        { injector: this.injector },
      );
      return () => ref.destroy();
    });
  }
}
