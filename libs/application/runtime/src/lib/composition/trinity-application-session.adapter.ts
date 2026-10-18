import { Injectable, inject } from '@angular/core';
import { SwUpdate, type VersionReadyEvent } from '@angular/service-worker';
import type { ApplicationSessionEvent } from '../application-runtime.models';
import { CapabilityHealthService } from '../capability-health.service';
import { NavigationFocusService } from '../navigation-focus.service';
import { BadgeCoordinator } from '@trinity/application/badge';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { TrnToastService } from '@trinity/components/overlay';
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
import {
  TrustAccountStatusService,
  TrustLifetime,
} from '@trinity/data-access/trust';
import { LiveTimelineTrimmer } from '@trinity/data-access/timeline';
import { HostLifecycleService } from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  Subscription,
  filter,
  ignoreElements,
  map,
  merge,
  switchMap,
  take,
  tap,
} from 'rxjs';
import type {
  CapabilityHealthFact,
  CapabilityRecovery,
} from '@trinity/runtime/projection';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';
import { RoomOrderHealthService } from './room-order-health.service';
import { HostSessionHealthService } from './host-session-health.service';
import { NotificationSessionService } from './notification-session.service';
import { BackgroundMemoryRelease } from './background-memory-release.service';
import { DeviceConfirmationCoordinator } from './device-confirmation.coordinator';
import { TrinityHostNavigationAdapter } from './trinity-host-navigation.adapter';
import { WhatsNewLauncherAdapter } from './whats-new-launcher.adapter';
import { UnprotectedStorageNotice } from './unprotected-storage.presenter';

/** Owns every live host and Workspace subscription for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrinityApplicationSessionAdapter {
  private readonly badge = inject(BadgeCoordinator);
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(TrnToastService);
  private readonly hostLifecycle = inject(HostLifecycleService);
  private readonly memoryRelease = inject(BackgroundMemoryRelease);
  private readonly timelineTrimmer = inject(LiveTimelineTrimmer);
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
  private readonly accountTrust = inject(TrustAccountStatusService);
  private readonly deviceConfirmation = inject(DeviceConfirmationCoordinator);
  private readonly identity = inject(IdentityLifetime);
  private readonly health = inject(CapabilityHealthService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly notificationLifetime = inject(NotificationLifetime);
  private readonly roomAdministration = inject(RoomAdministrationLifetime);
  private readonly notificationSession = inject(NotificationSessionService);
  private readonly hostNavigation = inject(TrinityHostNavigationAdapter);
  private readonly whatsNewLauncher = inject(WhatsNewLauncherAdapter);
  private readonly unprotectedStorage = inject(UnprotectedStorageNotice);

  run(readiness: Observable<void>): Observable<ApplicationSessionEvent> {
    return new Observable<ApplicationSessionEvent>((subscriber) => {
      const subscriptions = new Subscription();
      let roomLibrary: RoomLibraryLifetimeEvent | null = null;
      let sessionPrepared = false;

      const fail = (error: unknown): void => subscriber.error(error);
      const openLiveSession = (): void => {
        subscriptions.add(
          this.runLive().subscribe({
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
      const observeOptional = (lifetime: Observable<unknown>): void => {
        subscriptions.add(
          lifetime.subscribe({
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
              this.reportHealthForActiveAccount(event.fact, () =>
                this.trust.recover(event.fact.context, event.fact.generation),
              );
          }),
          filter((event) => event.kind === 'prepared'),
          map(() => null),
        ),
      );
      observeOptional(this.accountTrust.run());
      observeOptional(this.deviceConfirmation.run());
      observeOptional(
        this.identity.run(this.routedSurfaces.roomProjectionDemand).pipe(
          tap((event) => {
            if (event.kind === 'health')
              this.reportHealthForActiveAccount(event.fact, () =>
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
                this.reportHealthForActiveAccount(event.fact, () =>
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
                this.reportHealthForActiveAccount(event.fact, () =>
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

  private runLive(): Observable<never> {
    return merge(
      this.badge.run().pipe(
        tap((outcome) => {
          if (this.hostHealth.badgeWrite(outcome))
            this.toast.show('The app badge could not be updated.', {
              duration: 4000,
              variant: 'danger',
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
      this.hostNavigation.runDeepLinks().pipe(ignoreElements()),
      this.runInteractions(),
      this.runUpdates().pipe(ignoreElements()),
      this.whatsNewLauncher.runPending(),
      this.unprotectedStorage.runPendingNotice(),
      this.memoryRelease.run(),
      this.timelineTrimmer.run(),
    );
  }

  /** One shared Back/gesture owner, subscribed by the root before readiness. */
  runInteractions(): Observable<never> {
    return this.hostNavigation.runInteractions();
  }

  private reportHealthForActiveAccount(
    fact: CapabilityHealthFact,
    recovery: CapabilityRecovery,
  ): void {
    const accountId = this.accounts.activeAccountId();
    if (accountId) this.health.presentForAccount(fact.context, accountId);
    this.health.report(fact, recovery);
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
