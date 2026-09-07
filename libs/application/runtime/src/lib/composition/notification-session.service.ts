import { Injectable, inject } from '@angular/core';
import { TrnToastService } from '@trinity/components/overlay';
import {
  NativePushLifetime,
  NotificationService,
  type NativePushActivation,
  type NativePushLifetimeEvent,
  type NotificationDestination,
  type NotificationIncident,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
import {
  WorkspaceNavigationService,
  type WorkspaceNavigationIntent,
} from '@trinity/application/workspace';
import {
  EMPTY,
  Observable,
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
  private readonly navigation = inject(WorkspaceNavigationService);
  private readonly health = inject(CapabilityHealthService);
  private readonly toast = inject(TrnToastService);
  private readonly navigationContext = Symbol();

  run(): Observable<never> {
    return merge(
      this.notifications
        .run()
        .pipe(concatMap((event) => this.handleNotification(event))),
      this.push.run().pipe(concatMap((event) => this.handlePush(event))),
    );
  }

  private handlePush(event: NativePushLifetimeEvent): Observable<never> {
    if (event.kind === 'prepared') return EMPTY;
    if (event.kind === 'activated') return this.openPush(event.destination);
    if (event.kind === 'received') {
      return this.notifications.receivePush(event.data).pipe(
        catchError(() => EMPTY),
        switchMap(() => EMPTY),
      );
    }
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
      { duration: 4000 },
    );
  }
}
