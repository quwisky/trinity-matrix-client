import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { TrnToastService } from '@trinity/components/overlay';
import { AppLockService } from '@trinity/data-access/app-lock';
import {
  NativePushLifetime,
  NotificationService,
  NotificationSettingsStore,
  PushHandoffService,
  type NativePushActivation,
  type NativePushLifetimeEvent,
  type NotificationDestination,
  type NotificationIncident,
  type NotificationRuntimeEvent,
  type NotificationTextMode,
} from '@trinity/data-access/notifications';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { HostLifecycleService } from '@trinity/runtime/host';
import {
  WorkspaceNavigationService,
  type WorkspaceNavigationIntent,
} from '@trinity/application/workspace';
import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  catchError,
  concatMap,
  defer,
  exhaustMap,
  filter,
  ignoreElements,
  map,
  merge,
  mergeMap,
  of,
  switchMap,
  timer,
} from 'rxjs';
import { CapabilityHealthService } from '../capability-health.service';
import { appLockCovers } from './app-lock.providers';

/** How much each Notification text hides; a rise clears delivered notifications. */
const TEXT_PRIVACY: Readonly<Record<NotificationTextMode, number>> = {
  show: 0,
  'hide-on-lock-screen': 1,
  'always-hide': 2,
};

/** Owns notification delivery/activation health and contextual navigation incidents. */
@Injectable({ providedIn: 'root' })
export class NotificationSessionService {
  private readonly notifications = inject(NotificationService);
  private readonly settings = inject(NotificationSettingsStore);
  private readonly push = inject(NativePushLifetime);
  private readonly handoff = inject(PushHandoffService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly navigation = inject(WorkspaceNavigationService);
  private readonly health = inject(CapabilityHealthService);
  private readonly toast = inject(TrnToastService);
  private readonly appLock = inject(AppLockService);
  private readonly injector = inject(Injector);
  private readonly navigationContext = Symbol();
  private readonly taps = new Subject<WorkspaceNavigationIntent>();

  run(): Observable<never> {
    return merge(
      // First, so a tap the runtimes below emit as they start still reaches it.
      this.openTaps(),
      this.notifications
        .run()
        .pipe(concatMap((event) => this.handleNotification(event))),
      this.settings.run(),
      this.push.run().pipe(concatMap((event) => this.handlePush(event))),
      this.handoff.run(),
      this.refreshTokensOnBackground(),
      this.clearOpenedRooms(),
      this.clearResumedRoom(),
      this.mirrorNotificationText(),
    );
  }

  /**
   * Mirror App lock's effective Notification text for the push renderers once it has loaded,
   * then on each change. A more private mode also clears delivered notifications (even if the
   * write failed), so no earlier text stays on screen; a refused write is retried. Best effort.
   */
  private mirrorNotificationText(): Observable<never> {
    return new Observable<never>(() => {
      let seen: NotificationTextMode | null = null;
      /** The last mode the store accepted (or is writing); null after a refusal. */
      let written: NotificationTextMode | null = null;
      const writes = new Subscription();
      // The store lost the mirror (emptied, then refused): the next report writes it again.
      writes.add(
        this.handoff.notificationTextLost.subscribe(() => (written = null)),
      );
      const watch = effect(
        () => {
          if (this.appLock.status() === 'unknown') return;
          const mode = this.appLock.effectiveNotificationText();
          untracked(() => {
            const morePrivate =
              seen !== null && TEXT_PRIVACY[mode] > TEXT_PRIVACY[seen];
            seen = mode;
            if (mode === written && !morePrivate) return;
            written = mode;
            writes.add(
              this.handoff
                .writeNotificationText(mode)
                .pipe(
                  catchError(() => {
                    // Not de-duplicated away: the next report writes it again.
                    if (written === mode) written = null;
                    return of(void 0);
                  }),
                  switchMap(() =>
                    morePrivate ? this.handoff.clearDelivered() : EMPTY,
                  ),
                  catchError(() => EMPTY),
                )
                .subscribe(),
            );
          });
        },
        { injector: this.injector },
      );
      return () => {
        watch.destroy();
        writes.unsubscribe();
      };
    });
  }

  /**
   * On each move to the background, refresh OAuth access tokens so the closed-app
   * renderers' copy lives a full lifetime. A refresh still running when the app leaves
   * again is not doubled; the handoff bounds each run, so a hung one never holds off the
   * next. A failure never ends the session.
   */
  private refreshTokensOnBackground(): Observable<never> {
    return this.lifecycle.events.pipe(
      filter((event) => event.kind === 'background'),
      exhaustMap(() =>
        this.handoff.refreshBeforeBackground().pipe(catchError(() => EMPTY)),
      ),
      ignoreElements(),
    );
  }

  /** Clear a room's delivered notifications when it is focused, or still focused at unlock. */
  private clearOpenedRooms(): Observable<never> {
    return new Observable<never>(() => {
      let opened: string | null = null;
      const clearing = new Subscription();
      const focus = effect(
        () => {
          // Behind App lock nothing counts as opened: a room selected while locked, or
          // the one left open, clears once the person unlocks and can see it.
          const key = appLockCovers(this.appLock.status())
            ? null
            : (this.conversations.focused()?.key ?? null);
          untracked(() => {
            const id = key ? `${key.accountId}\u0000${key.roomId}` : null;
            if (id === opened) return;
            opened = id;
            if (key) {
              clearing.add(
                this.handoff.clearRoom(key.accountId, key.roomId).subscribe(),
              );
            }
          });
        },
        { injector: this.injector },
      );
      return () => {
        focus.destroy();
        clearing.unsubscribe();
      };
    });
  }

  /**
   * When the app returns to the foreground, clear the delivered notifications of the room
   * still open: while it was hidden, pushes for that room were shown natively (Android
   * hands the background to push). Best effort, like {@link clearOpenedRooms}.
   *
   * A return to the lock screen keeps them; clearOpenedRooms clears them after unlock. The
   * away timer may lock on this very event, and whether its listener runs before or after
   * this one depends on subscription order (each subscriber has its own host listener). So
   * while App lock is unlocked the decision waits until that event's dispatch is over
   * (a macrotask: a microtask could still run between two DOM listeners).
   */
  private clearResumedRoom(): Observable<never> {
    return this.lifecycle.events.pipe(
      filter((event) => event.kind === 'active'),
      mergeMap(() => {
        const status = untracked(this.appLock.status);
        if (status === 'off') return this.clearFocusedRoom();
        if (status !== 'unlocked') return EMPTY;
        return timer(0).pipe(
          switchMap(() =>
            appLockCovers(untracked(this.appLock.status))
              ? EMPTY
              : this.clearFocusedRoom(),
          ),
        );
      }),
      ignoreElements(),
      catchError(() => EMPTY),
    );
  }

  private clearFocusedRoom(): Observable<void> {
    const key = untracked(() => this.conversations.focused()?.key);
    return key ? this.handoff.clearRoom(key.accountId, key.roomId) : EMPTY;
  }

  private handlePush(event: NativePushLifetimeEvent): Observable<never> {
    if (event.kind === 'prepared') return EMPTY;
    if (event.kind === 'activated') return this.openPush(event.destination);
    this.health.report(event.fact, () =>
      this.push.recover(event.fact.context, event.fact.generation),
    );
    return EMPTY;
  }

  private handleNotification(
    event: NotificationRuntimeEvent,
  ): Observable<never> {
    if (event.kind === 'activated') return this.open(event.destination);
    if (event.kind === 'health') {
      this.health.report(event.fact, () =>
        this.notifications.recoverPresentation(
          event.fact.context,
          event.fact.generation,
        ),
      );
      return EMPTY;
    }
    this.reportIncident(event.incident);
    return EMPTY;
  }

  private open(destination: NotificationDestination): Observable<never> {
    return this.openIntent({ kind: 'notification', ...destination });
  }

  private openPush(activation: NativePushActivation): Observable<never> {
    return this.openIntent({ kind: 'notification', ...activation });
  }

  /**
   * A tap brings the app forward at once, to the lock screen if App lock covers it; the
   * destination opens once the person unlocks. It never holds up the events behind it.
   */
  private openIntent(intent: WorkspaceNavigationIntent): Observable<never> {
    return defer(() => {
      try {
        window.focus();
      } catch {
        // Browser focus may be denied; Workspace navigation is still valid.
      }
      this.taps.next(intent);
      return EMPTY;
    });
  }

  /**
   * Opens tapped destinations in order. While App lock covers the app only the latest tap
   * waits, and it opens as soon as the lock is off or unlocked.
   */
  private openTaps(): Observable<never> {
    return this.taps.pipe(
      switchMap((intent) =>
        this.appLock.whenUnlocked().pipe(map(() => intent)),
      ),
      concatMap((intent) =>
        this.navigation.navigate(intent).pipe(
          switchMap((outcome) =>
            outcome.kind === 'ready'
              ? EMPTY
              : this.navigationIncident('notification-navigation-rejected'),
          ),
          catchError(() =>
            this.navigationIncident('notification-navigation-failed'),
          ),
        ),
      ),
    );
  }

  private navigationIncident(
    code: Extract<
      NotificationIncident['code'],
      'notification-navigation-rejected' | 'notification-navigation-failed'
    >,
  ): Observable<never> {
    this.reportIncident({
      context: this.navigationContext,
      capability: 'notifications',
      operation: 'navigation',
      code,
    });
    return EMPTY;
  }

  private reportIncident(incident: NotificationIncident): void {
    this.health.incident(incident);
    this.toast.show(
      incident.operation === 'presentation-command'
        ? 'A notification could not be shown.'
        : 'That notification destination could not be opened.',
      { duration: 4000, variant: 'danger' },
    );
  }
}
