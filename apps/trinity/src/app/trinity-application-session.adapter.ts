import { Location } from '@angular/common';
import { Injectable, Injector, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SwUpdate, type VersionReadyEvent } from '@angular/service-worker';
import {
  NavigationFocusService,
  type ApplicationRuntimeWarning,
} from '@trinity/application/runtime';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  AppBadgeService,
  NotificationService,
  type NotificationDestination,
} from '@trinity/data-access/notifications';
import { SpaceRoomOrderService } from '@trinity/data-access/rooms';
import { NativeNavigationService } from '@trinity/platform-native';
import {
  HostBackService,
  HostDeepLinksService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  defer,
  filter,
  from,
  fromEvent,
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
import { encodeRoomSegment } from '@trinity/util/matrix';

/** Owns every live host and Workspace subscription for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrinityApplicationSessionAdapter {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly badge = inject(AppBadgeService);
  private readonly notifications = inject(NotificationService);
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnDialogService);
  private readonly workspaceBack = inject(WorkspaceBackService);
  private readonly nativeNavigation = inject(NativeNavigationService);
  private readonly hostDeepLinks = inject(HostDeepLinksService);
  private readonly hostBack = inject(HostBackService);
  private readonly navigationFocus = inject(NavigationFocusService);
  private readonly routedSurfaces = inject(WorkspaceRoutedSurfaceAdapter);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfacePresenterAdapter,
  );
  private readonly spaceOrder = inject(SpaceRoomOrderService);

  run(): Observable<ApplicationRuntimeWarning> {
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
    return this.notifications
      .run()
      .pipe(concatMap((destination) => this.openNotification(destination)));
  }

  private openNotification(
    destination: NotificationDestination,
  ): Observable<ApplicationRuntimeWarning> {
    return defer(() => {
      try {
        window.focus();
      } catch {
        // Browser focus may be denied; Workspace navigation is still valid.
      }
      return from(
        this.router.navigate(
          ['/rooms', encodeRoomSegment(destination.roomId)],
          {
            queryParams: {
              account: destination.accountId,
              event: destination.eventId,
            },
          },
        ),
      ).pipe(
        switchMap((navigated) =>
          navigated
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
    if (!this.swUpdate.isEnabled) return EMPTY;
    const unrecoverable = this.swUpdate.unrecoverable.pipe(
      tap(() => window.location.reload()),
      ignoreElements(),
    );
    const readyVersions = this.swUpdate.versionUpdates.pipe(
      filter(
        (event): event is VersionReadyEvent => event.type === 'VERSION_READY',
      ),
      tap(() => {
        this.toast.show('A new version of Trinity is available.', {
          duration: 0,
          action: { label: 'Reload', onClick: () => this.activateUpdate() },
        });
      }),
      ignoreElements(),
    );
    const foregroundChecks = fromEvent(document, 'visibilitychange').pipe(
      filter(() => document.visibilityState === 'visible'),
      switchMap(() =>
        from(this.swUpdate.checkForUpdate()).pipe(
          ignoreElements(),
          catchError(() => of(warning('updates', 'update-check-failed'))),
        ),
      ),
    );
    return merge(unrecoverable, readyVersions, foregroundChecks);
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
