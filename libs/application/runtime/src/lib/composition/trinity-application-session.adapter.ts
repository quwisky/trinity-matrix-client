import { Location } from '@angular/common';
import { Injectable, Injector, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SwUpdate, type VersionReadyEvent } from '@angular/service-worker';
import type {
  ApplicationRuntimeWarning,
  ApplicationSessionEvent,
} from '../application-runtime.models';
import { NavigationFocusService } from '../navigation-focus.service';
import { BadgeCoordinator } from '@trinity/application/badge';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
  type WorkspaceNavigationIntent,
} from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  NotificationService,
  PushService,
  type NativePushActivation,
  type NotificationDestination,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
import {
  RoomLibraryLifetime,
  SpaceRoomOrderService,
} from '@trinity/data-access/room-library';
import { NativeNavigationService } from '@trinity/platform-native';
import {
  HostBackService,
  HostDeepLinksService,
  HostLifecycleService,
  HostUpdatesService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  catchError,
  concat,
  concatMap,
  defer,
  filter,
  from,
  ignoreElements,
  map,
  merge,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';

/** Owns every live host and Workspace subscription for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrinityApplicationSessionAdapter {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly badge = inject(BadgeCoordinator);
  private readonly notifications = inject(NotificationService);
  private readonly push = inject(PushService);
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnDialogService);
  private readonly workspaceBack = inject(WorkspaceBackService);
  private readonly workspaceNavigation = inject(WorkspaceNavigationService);
  private readonly nativeNavigation = inject(NativeNavigationService);
  private readonly hostDeepLinks = inject(HostDeepLinksService);
  private readonly hostBack = inject(HostBackService);
  private readonly hostLifecycle = inject(HostLifecycleService);
  private readonly hostUpdates = inject(HostUpdatesService);
  private readonly navigationFocus = inject(NavigationFocusService);
  private readonly routedSurfaces = inject(WorkspaceRoutedSurfaceAdapter);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfacePresenterAdapter,
  );
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly roomLibrary = inject(RoomLibraryLifetime);

  run(readiness: Observable<void>): Observable<ApplicationSessionEvent> {
    return this.roomLibrary.run().pipe(
      switchMap((event) =>
        event.kind === 'blocked'
          ? of({
              kind: 'blocked',
              recovery: 'retry-startup',
              diagnostic: event.diagnostic,
            } as const)
          : concat(
              of({ kind: 'prepared' } as const),
              readiness.pipe(
                take(1),
                switchMap(() => this.runLive()),
                map((warning): ApplicationSessionEvent => ({
                  kind: 'warning',
                  warning,
                })),
              ),
            ),
      ),
    );
  }

  private runLive(): Observable<ApplicationRuntimeWarning> {
    return merge(
      this.badge.run().pipe(concatMap((outcome) => this.badgeWarning(outcome))),
      this.runNotificationActivations(),
      this.navigationFocus.run().pipe(ignoreElements()),
      this.routedSurfaces.run().pipe(ignoreElements()),
      this.applicationSurfaces.run().pipe(ignoreElements()),
      this.spaceOrder.run().pipe(ignoreElements()),
      this.runDeepLinks().pipe(ignoreElements()),
      this.runBackIntents().pipe(ignoreElements()),
      this.runNavigationGesturePolicy().pipe(ignoreElements()),
      this.runUpdates(),
    );
  }

  private runNotificationActivations(): Observable<ApplicationRuntimeWarning> {
    return merge(
      this.notifications
        .run()
        .pipe(concatMap((event) => this.handleNotificationEvent(event))),
      this.push.run().pipe(
        concatMap((activation) => this.openNativePush(activation)),
        catchError(() => of(warning('host', 'push-session-failed'))),
      ),
    );
  }

  private handleNotificationEvent(
    event: NotificationRuntimeEvent,
  ): Observable<ApplicationRuntimeWarning> {
    return event.kind === 'activated'
      ? this.openNotification(event.destination)
      : of(warning('host', event.diagnostic.code));
  }

  private openNotification(
    destination: NotificationDestination,
  ): Observable<ApplicationRuntimeWarning> {
    return this.openWorkspaceIntent({
      kind: 'notification',
      accountId: destination.accountId,
      roomId: destination.roomId,
      eventId: destination.eventId,
    });
  }

  private openNativePush(
    activation: NativePushActivation,
  ): Observable<ApplicationRuntimeWarning> {
    return this.openWorkspaceIntent({
      kind: 'notification',
      ...activation,
    });
  }

  private openWorkspaceIntent(
    intent: WorkspaceNavigationIntent,
  ): Observable<ApplicationRuntimeWarning> {
    return defer(() => {
      try {
        window.focus();
      } catch {
        // Browser focus may be denied; Workspace navigation is still valid.
      }
      return this.workspaceNavigation.navigate(intent).pipe(
        switchMap((outcome) =>
          outcome.kind === 'ready'
            ? EMPTY
            : of(warning('workspace', 'notification-navigation-rejected')),
        ),
        catchError(() =>
          of(warning('workspace', 'notification-navigation-failed')),
        ),
      );
    });
  }

  private badgeWarning(
    outcome: HostOperationOutcome,
  ): Observable<ApplicationRuntimeWarning> {
    if (
      outcome.kind === 'completed' ||
      (outcome.kind === 'unavailable' &&
        (outcome.reason === 'not-supported' ||
          outcome.reason === 'not-implemented'))
    ) {
      return EMPTY;
    }
    return of(warning('badge', 'badge-update-failed'));
  }

  private runDeepLinks(): Observable<void> {
    return this.hostDeepLinks.received.pipe(
      concatMap(({ url }) => this.handleDeepLink(url)),
    );
  }

  private handleDeepLink(url: string): Observable<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return EMPTY;
    }
    const path = parsed.host || parsed.pathname.replace(/^\/+/, '');
    const params = parsed.searchParams;
    if (
      path !== 'sso-callback' ||
      (!params.has('loginToken') && !params.has('code') && !params.has('error'))
    ) {
      return EMPTY;
    }
    const queryParams: Record<string, string> = {};
    for (const key of CALLBACK_PARAMS) {
      const value = params.get(key);
      if (value !== null) queryParams[key] = value;
    }
    return this.hostDeepLinks.closeAuthentication().pipe(
      switchMap(() =>
        from(this.router.navigate(['/sso-callback'], { queryParams })),
      ),
      map(() => void 0),
    );
  }

  private runBackIntents(): Observable<void> {
    return this.hostBack.intents.pipe(
      concatMap(({ canGoBack }) =>
        defer(() => {
          if (
            this.dialog.hasOpen() &&
            !this.workspaceBack.activeOwnsTopmostOverlay()
          ) {
            this.dialog.closeTopmost();
            return of(void 0);
          }
          if (this.workspaceBack.hasActive()) {
            return this.workspaceBack.back().pipe(
              take(1),
              map(() => void 0),
            );
          }
          if (this.dialog.hasOpen()) {
            this.dialog.closeTopmost();
            return of(void 0);
          }
          if (canGoBack) {
            this.location.back();
            return of(void 0);
          }
          return this.hostBack.background().pipe(
            take(1),
            map(() => void 0),
          );
        }),
      ),
    );
  }

  private runNavigationGesturePolicy(): Observable<void> {
    return new Observable(() => {
      const policy = effect(
        () => {
          const interceptionActive =
            this.dialog.openState() || this.workspaceBack.hasActive();
          this.nativeNavigation.setHistoryGesturesEnabled(!interceptionActive);
        },
        { injector: this.injector },
      );
      return () => policy.destroy();
    });
  }

  private runUpdates(): Observable<ApplicationRuntimeWarning> {
    const initialCheck = this.checkForUpdates();
    const serviceWorkerEvents = this.swUpdate.isEnabled
      ? merge(
          this.swUpdate.unrecoverable.pipe(
            tap(() => window.location.reload()),
            ignoreElements(),
          ),
          this.swUpdate.versionUpdates.pipe(
            filter(
              (event): event is VersionReadyEvent =>
                event.type === 'VERSION_READY',
            ),
            tap(() => {
              this.toast.show('A new version of Trinity is available.', {
                duration: 0,
                action: {
                  label: 'Reload',
                  onClick: () => this.activateUpdate(),
                },
              });
            }),
            ignoreElements(),
          ),
        )
      : EMPTY;
    const foregroundChecks = this.hostLifecycle.events.pipe(
      filter((event) => event.kind === 'active'),
      switchMap(() => this.checkForUpdates()),
    );
    return merge(initialCheck, serviceWorkerEvents, foregroundChecks);
  }

  private checkForUpdates(): Observable<ApplicationRuntimeWarning> {
    return defer(() => this.hostUpdates.check()).pipe(
      switchMap((outcome) =>
        outcome.kind === 'rejected'
          ? of(warning('updates', 'update-check-failed'))
          : EMPTY,
      ),
      catchError(() => of(warning('updates', 'update-check-failed'))),
    );
  }

  private activateUpdate(): void {
    void this.swUpdate.activateUpdate().then(
      () => window.location.reload(),
      () => window.location.reload(),
    );
  }
}

function warning(
  scope: ApplicationRuntimeWarning['scope'],
  code: string,
): ApplicationRuntimeWarning {
  return {
    stage: 'session',
    scope,
    diagnostic: { code },
    recovery: 'retry-startup',
  };
}

const CALLBACK_PARAMS = [
  'loginToken',
  'sso_state',
  'code',
  'state',
  'error',
  'error_description',
] as const;
