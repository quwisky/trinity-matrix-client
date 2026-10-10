import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { TrnToastService } from '@trinity/components/overlay';
import {
  NativePushLifetime,
  NotificationService,
  PushHandoffService,
  type NativePushActivation,
  type NativePushLifetimeEvent,
  type NotificationDestination,
  type NotificationIncident,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import {
  WorkspaceNavigationService,
  type WorkspaceNavigationIntent,
} from '@trinity/application/workspace';
import {
  EMPTY,
  Observable,
  Subscription,
  catchError,
  concatMap,
  defer,
  merge,
  switchMap,
} from 'rxjs';
import { CapabilityHealthService } from '../capability-health.service';

/** Owns notification delivery/activation health and contextual navigation incidents. */
@Injectable({ providedIn: 'root' })
export class NotificationSessionService {
  private readonly notifications = inject(NotificationService);
  private readonly push = inject(NativePushLifetime);
  private readonly handoff = inject(PushHandoffService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly navigation = inject(WorkspaceNavigationService);
  private readonly health = inject(CapabilityHealthService);
  private readonly toast = inject(TrnToastService);
  private readonly injector = inject(Injector);
  private readonly navigationContext = Symbol();

  run(): Observable<never> {
    return merge(
      this.notifications
        .run()
        .pipe(concatMap((event) => this.handleNotification(event))),
      this.push.run().pipe(concatMap((event) => this.handlePush(event))),
      // Keeps the closed-app push renderers' store current; inert off native mobile.
      this.handoff.run(),
      this.clearOpenedRooms(),
    );
  }

  /**
   * Each time a room becomes the focused Conversation (Workspace focuses only a room it has
   * found ready), clear that account's delivered notifications for it. Best effort: the
   * handoff swallows native failures, so Workspace never sees one.
   */
  private clearOpenedRooms(): Observable<never> {
    return new Observable<never>(() => {
      let opened: string | null = null;
      const clearing = new Subscription();
      const focus = effect(
        () => {
          const key = this.conversations.focused()?.key ?? null;
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

  private openIntent(intent: WorkspaceNavigationIntent): Observable<never> {
    return defer(() => {
      try {
        window.focus();
      } catch {
        // Browser focus may be denied; Workspace navigation is still valid.
      }
      return this.navigation.navigate(intent).pipe(
        switchMap((outcome) =>
          outcome.kind === 'ready'
            ? EMPTY
            : this.navigationIncident('notification-navigation-rejected'),
        ),
        catchError(() =>
          this.navigationIncident('notification-navigation-failed'),
        ),
      );
    });
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
