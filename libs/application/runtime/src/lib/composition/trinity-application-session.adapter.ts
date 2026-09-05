import { Location } from '@angular/common';
import { Injectable, Injector, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SwUpdate, type VersionReadyEvent } from '@angular/service-worker';
import type {
  ApplicationRuntimeWarning,
  ApplicationSessionEvent,
} from '../application-runtime.models';
import { CapabilityHealthService } from '../capability-health.service';
import { NavigationFocusService } from '../navigation-focus.service';
import { BadgeCoordinator } from '@trinity/application/badge';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  NotificationLifetime,
  type NotificationLifetimeEvent,
} from '@trinity/data-access/notifications';
import { IdentityLifetime } from '@trinity/data-access/identity';
import {
  RoomLibraryLifetime,
  SpaceRoomOrderService,
  type RoomLibraryLifetimeEvent,
} from '@trinity/data-access/room-library';
import {
  RoomAdministrationLifetime,
  type RoomAdministrationLifetimeEvent,
} from '@trinity/data-access/room-administration';
import { TrustLifetime } from '@trinity/data-access/trust';
import { NativeNavigationService } from '@trinity/platform-native';
import {
  HostBackService,
  HostDeepLinksService,
  HostLifecycleService,
  type HostCapabilitySupport,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import {
  EMPTY,
  NEVER,
  Observable,
  Subscription,
  catchError,
  concatMap,
  defer,
  filter,
  from,
  ignoreElements,
  map,
  merge,
  of,
  repeat,
  retry,
  switchMap,
  take,
  tap,
  throwError,
  throwIfEmpty,
  timer,
  timeout,
} from 'rxjs';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';
import { RoomOrderHealthService } from './room-order-health.service';
import { HostSessionHealthService } from './host-session-health.service';
import { NotificationSessionService } from './notification-session.service';

/** Owns every live host and Workspace subscription for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrinityApplicationSessionAdapter {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly badge = inject(BadgeCoordinator);
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnDialogService);
  private readonly workspaceBack = inject(WorkspaceBackService);
  private readonly nativeNavigation = inject(NativeNavigationService);
  private readonly hostDeepLinks = inject(HostDeepLinksService);
  private readonly hostBack = inject(HostBackService);
  private readonly hostLifecycle = inject(HostLifecycleService);
  private readonly hostHealth = inject(HostSessionHealthService);
  private readonly navigationFocus = inject(NavigationFocusService);
  private readonly routedSurfaces = inject(WorkspaceRoutedSurfaceAdapter);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfacePresenterAdapter,
  );
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly roomOrderHealth = inject(RoomOrderHealthService);
  private readonly roomLibrary = inject(RoomLibraryLifetime);
  private readonly trust = inject(TrustLifetime);
  private readonly identity = inject(IdentityLifetime);
  private readonly health = inject(CapabilityHealthService);
  private readonly notificationLifetime = inject(NotificationLifetime);
  private readonly roomAdministration = inject(RoomAdministrationLifetime);
  private readonly notificationSession = inject(NotificationSessionService);

  run(readiness: Observable<void>): Observable<ApplicationSessionEvent> {
    return new Observable<ApplicationSessionEvent>((subscriber) => {
      const subscriptions = new Subscription();
      const queuedWarnings: ApplicationRuntimeWarning[] = [];
      let roomLibrary: RoomLibraryLifetimeEvent | null = null;
      let sessionPrepared = false;
      let readinessOpen = false;

      const fail = (error: unknown): void => subscriber.error(error);
      const publishWarning = (
        runtimeWarning: ApplicationRuntimeWarning,
      ): void => {
        if (!readinessOpen) {
          queuedWarnings.push(runtimeWarning);
          return;
        }
        subscriber.next({ kind: 'warning', warning: runtimeWarning });
      };
      const openLiveSession = (): void => {
        readinessOpen = true;
        for (const runtimeWarning of queuedWarnings.splice(0)) {
          publishWarning(runtimeWarning);
        }
        subscriptions.add(
          this.runLive().subscribe({
            next: (runtimeWarning) => publishWarning(runtimeWarning),
            error: fail,
          }),
        );
      };
      const prepareSession = (): void => {
        if (sessionPrepared || !roomLibrary) return;
        sessionPrepared = true;
        if (roomLibrary.kind === 'blocked') {
          subscriber.next({
            kind: 'blocked',
            recovery: 'retry-startup',
            diagnostic: roomLibrary.diagnostic,
          });
          subscriber.complete();
          return;
        }
        subscriber.next({ kind: 'prepared' });
        subscriptions.add(
          readiness.pipe(take(1)).subscribe({
            next: openLiveSession,
            error: fail,
          }),
        );
      };
      const observeOptional = (
        lifetime: Observable<ApplicationRuntimeWarning | null>,
      ): void => {
        subscriptions.add(
          lifetime.subscribe({
            next: (runtimeWarning) => {
              if (runtimeWarning) publishWarning(runtimeWarning);
            },
            error: fail,
          }),
        );
      };

      subscriptions.add(
        this.roomLibrary.run().subscribe({
          next: (event) => {
            if (roomLibrary) {
              if (event.kind === 'blocked') {
                subscriber.next({
                  kind: 'blocked',
                  recovery: 'retry-startup',
                  diagnostic: event.diagnostic,
                });
                subscriber.complete();
              }
              return;
            }
            roomLibrary = event;
            prepareSession();
          },
          error: fail,
        }),
      );
      observeOptional(
        this.trust.run().pipe(
          tap((event) => {
            if (event.kind === 'health')
              this.health.report(event.fact, () =>
                this.trust.recover(event.fact.context, event.fact.generation),
              );
          }),
          filter((event) => event.kind === 'prepared'),
          map(() => null),
        ),
      );
      observeOptional(
        this.identity.run(this.routedSurfaces.roomProjectionDemand).pipe(
          tap((event) => {
            if (event.kind === 'health')
              this.health.report(event.fact, () =>
                this.identity.recover(
                  event.fact.context,
                  event.fact.generation,
                ),
              );
          }),
          filter((event) => event.kind === 'prepared'),
          map(() => null),
        ),
      );
      subscriptions.add(
        this.notificationLifetime
          .run(this.routedSurfaces.roomProjectionDemand)
          .subscribe({
            next: (event: NotificationLifetimeEvent) => {
              if (event.kind === 'health')
                this.health.report(event.fact, () =>
                  this.notificationLifetime.recover(
                    event.fact.context,
                    event.fact.generation,
                  ),
                );
            },
            error: fail,
          }),
      );
      subscriptions.add(
        this.roomAdministration
          .run(
            this.routedSurfaces.roomProjectionDemand,
            this.routedSurfaces.activeRoomId,
          )
          .subscribe({
            next: (event: RoomAdministrationLifetimeEvent) => {
              if (event.kind === 'health')
                this.health.report(event.fact, () =>
                  this.roomAdministration.recover(
                    event.fact.operation,
                    event.fact.context,
                    event.fact.generation,
                  ),
                );
            },
            error: fail,
          }),
      );

      return () => subscriptions.unsubscribe();
    });
  }

  private runLive(): Observable<ApplicationRuntimeWarning> {
    return merge(
      this.badge.run().pipe(
        tap((outcome) => {
          if (this.hostHealth.badgeWrite(outcome))
            this.toast.show('The app badge could not be updated.', {
              duration: 4000,
            });
        }),
        ignoreElements(),
      ),
      this.notificationSession.run(),
      this.navigationFocus.run().pipe(ignoreElements()),
      this.routedSurfaces.run().pipe(ignoreElements()),
      this.applicationSurfaces.run().pipe(ignoreElements()),
      this.spaceOrder.run().pipe(
        tap((event) => this.roomOrderHealth.reportRuntime(event)),
        ignoreElements(),
      ),
      this.runDeepLinks().pipe(ignoreElements()),
      this.runBackIntents().pipe(ignoreElements()),
      this.runNavigationGesturePolicy().pipe(ignoreElements()),
      this.runUpdates().pipe(ignoreElements()),
    );
  }

  private runDeepLinks(): Observable<void> {
    return this.runSupportedHostStream(
      'deep-links',
      'deep-link-support-check-failed',
      () => this.hostDeepLinks.support(),
      () =>
        this.hostDeepLinks.received.pipe(
          tap({
            error: () =>
              this.reportHostIncident(
                'deep-links',
                'deep-link-listener-failed',
              ),
            complete: () =>
              this.reportHostIncident(
                'deep-links',
                'deep-link-listener-ownership-released',
              ),
          }),
          retry({ delay: 1_000 }),
          repeat({ delay: 1_000 }),
          concatMap(({ url }) => this.handleDeepLink(url)),
        ),
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
      tap((outcome) => {
        if (hostOutcomeFailed(outcome))
          this.reportHostIncident(
            'authentication-handoff',
            'authentication-close-failed',
          );
      }),
      switchMap(() =>
        from(this.router.navigate(['/sso-callback'], { queryParams })),
      ),
      switchMap((navigated) =>
        navigated
          ? of(void 0)
          : this.hostIncident('deep-links', 'deep-link-navigation-rejected'),
      ),
      catchError(() =>
        this.hostIncident('deep-links', 'deep-link-navigation-failed'),
      ),
    );
  }

  private runBackIntents(): Observable<void> {
    return this.runSupportedHostStream(
      'back',
      'host-back-support-check-failed',
      () => this.hostBack.support(),
      () =>
        this.hostBack.intents.pipe(
          tap({
            error: () =>
              this.reportHostIncident('back', 'host-back-listener-failed'),
            complete: () =>
              this.reportHostIncident(
                'back',
                'host-back-listener-ownership-released',
              ),
          }),
          retry({ delay: 1_000 }),
          repeat({ delay: 1_000 }),
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
                  catchError(() =>
                    this.hostIncident('back', 'workspace-back-failed'),
                  ),
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
                switchMap((outcome) =>
                  hostOutcomeFailed(outcome)
                    ? this.hostIncident('back', 'host-background-failed')
                    : of(void 0),
                ),
              );
            }),
          ),
        ),
    );
  }

  private runSupportedHostStream(
    operation: 'deep-links' | 'back',
    failureCode: string,
    support: () => Observable<HostCapabilitySupport>,
    stream: () => Observable<void>,
  ): Observable<void> {
    let incidentReported = false;
    return defer(support).pipe(
      take(1),
      throwIfEmpty(() => new Error('Host support returned no outcome.')),
      timeout(10_000),
      switchMap((outcome) => {
        if (outcome.kind === 'supported') {
          incidentReported = false;
          return stream();
        }
        return outcome.reason === 'not-supported' ||
          outcome.reason === 'not-implemented'
          ? NEVER
          : throwError(() => new Error('Host support negotiation failed.'));
      }),
      retry({
        delay: () => {
          if (!incidentReported) {
            incidentReported = true;
            this.reportHostIncident(operation, failureCode);
          }
          return timer(1_000);
        },
      }),
    );
  }

  private hostIncident(operation: string, code: string): Observable<never> {
    this.reportHostIncident(operation, code);
    return EMPTY;
  }

  private reportHostIncident(operation: string, code: string): void {
    this.hostHealth.incident('host', operation, code);
    this.toast.show('A host navigation action could not be completed.', {
      duration: 4000,
    });
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

  private runUpdates(): Observable<void> {
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

  private checkForUpdates(): Observable<void> {
    return this.hostHealth.checkUpdates();
  }

  private activateUpdate(): void {
    void this.swUpdate.activateUpdate().then(
      () => window.location.reload(),
      () => window.location.reload(),
    );
  }
}

const CALLBACK_PARAMS = [
  'loginToken',
  'sso_state',
  'code',
  'state',
  'error',
  'error_description',
] as const;

function hostOutcomeFailed(outcome: HostOperationOutcome): boolean {
  return (
    outcome.kind === 'rejected' ||
    (outcome.kind === 'unavailable' &&
      outcome.reason !== 'not-supported' &&
      outcome.reason !== 'not-implemented')
  );
}
