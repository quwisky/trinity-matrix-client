import { Location } from '@angular/common';
import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  SwUpdate,
  type UnrecoverableStateEvent,
  type VersionEvent,
} from '@angular/service-worker';
import { NavigationFocusService } from '../navigation-focus.service';
import { BadgeCoordinator } from '@trinity/application/badge';
import {
  InboundRoomLinkService,
  WorkspaceBackService,
  type WorkspaceSurface,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  NotificationLifetime,
  NativePushLifetime,
  NotificationService,
  PushHandoffService,
  type NativePushLifetimeEvent,
  type NotificationLifetimeEvent,
  type NotificationRuleHealth,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
import {
  ConversationRuntime,
  LiveTimelineTrimmer,
} from '@trinity/data-access/timeline';
import {
  AppLockService,
  type AppLockStatus,
  type NotificationText,
} from '@trinity/data-access/app-lock';
import {
  IdentityLifetime,
  type IdentityLifetimeEvent,
} from '@trinity/data-access/identity';
import {
  RoomLibraryLifetime,
  type RoomLibraryLifetimeEvent,
  SpaceRoomOrderService,
} from '@trinity/data-access/room-library';
import {
  RoomAdministrationLifetime,
  type RoomAdministrationHealth,
  type RoomAdministrationLifetimeEvent,
} from '@trinity/data-access/room-administration';
import {
  TrustAccountStatusService,
  TrustLifetime,
  TrustUsersService,
  type TrustCapabilityHealth,
  type TrustLifetimeEvent,
} from '@trinity/data-access/trust';
import { NativeNavigationService } from '@trinity/platform-native';
import {
  HostBackService,
  HostDeepLinksService,
  HostLifecycleService,
  HostUpdatesService,
} from '@trinity/runtime/host';
import { MockProvider, ngMocks } from 'ng-mocks';
import {
  EMPTY,
  Observable,
  Subject,
  type Subscription,
  lastValueFrom,
  of,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';
import { TrinityApplicationSessionAdapter } from './trinity-application-session.adapter';
import { BackgroundMemoryRelease } from './background-memory-release.service';
import { WhatsNewLauncherAdapter } from './whats-new-launcher.adapter';
import { UnprotectedStorageNotice } from './unprotected-storage.presenter';
import { DeviceConfirmationCoordinator } from './device-confirmation.coordinator';
import { CapabilityHealthService } from '../capability-health.service';
import { healthFact } from '../testing/capability-health.fixture';

function setup({
  push,
  roomLibrary = of({ kind: 'prepared' }),
  trust = of({ kind: 'prepared' }),
  identity = of({ kind: 'prepared' }),
  notifications = of({ kind: 'prepared' }),
  roomAdministration = of({ kind: 'prepared' }),
}: {
  readonly push?: Observable<NativePushLifetimeEvent>;
  readonly roomLibrary?: Observable<RoomLibraryLifetimeEvent>;
  readonly trust?: Observable<TrustLifetimeEvent>;
  readonly identity?: Observable<IdentityLifetimeEvent>;
  readonly notifications?: Observable<NotificationLifetimeEvent>;
  readonly roomAdministration?: Observable<RoomAdministrationLifetimeEvent>;
} = {}) {
  const deepLinks = new Subject<{ readonly url: string }>();
  const backIntents = new Subject<{ readonly canGoBack: boolean }>();
  const notificationEvents = new Subject<NotificationRuntimeEvent>();
  const pushActivations = new Subject<NativePushLifetimeEvent>();
  const lifecycleEvents = new Subject<
    { readonly kind: 'active' } | { readonly kind: 'background' }
  >();
  const memoryRelease = new Subject<never>();
  const timelineTrim = new Subject<never>();
  const navigate = vi.fn().mockResolvedValue(true);
  const workspaceNavigate = vi.fn<WorkspaceNavigationService['navigate']>(() =>
    of({ kind: 'ready', change: 'committed' } as const),
  );
  const closeAuthentication = vi.fn<
    HostDeepLinksService['closeAuthentication']
  >(() => of({ kind: 'completed' as const }));
  const locationBack = vi.fn();
  const background = vi.fn<HostBackService['background']>(() =>
    of({ kind: 'completed' as const }),
  );
  const appLockStatus = signal<AppLockStatus>('off');
  const dialogOpen = signal(false);
  const hasDialog = vi.fn(() => dialogOpen());
  const closeTopmost = vi.fn(() => false);
  const workspaceActive = signal(false);
  const workspaceSurface = signal<WorkspaceSurface | null>(null);
  const conversationOverList = signal(false);
  const routedSurface = signal<WorkspaceSurface | null>(null);
  const workspaceOwnsOverlay = vi.fn(() => false);
  const workspaceBack = vi.fn(() => of({ kind: 'unhandled' as const }));
  const setHistoryGesturesEnabled = vi.fn();
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<UnrecoverableStateEvent>();
  const checkForUpdate = vi.fn().mockResolvedValue(true);
  const hostUpdateCheck = vi.fn<HostUpdatesService['check']>(() =>
    of({ kind: 'completed' as const }),
  );
  const activateUpdate = vi.fn().mockResolvedValue(true);
  const showToast = vi.fn();
  const roomProjectionDemand = signal(true);
  const activeRoomId = signal<string | null>('!room:example.org');
  const recoverTrust = vi.fn(() => of({ kind: 'success' as const }));
  const recoverNotifications = vi.fn(() => of({ kind: 'success' as const }));
  const recoverPresentation = vi.fn(() => of({ kind: 'success' as const }));
  const recoverRoomAdministration = vi.fn(() =>
    of({ kind: 'success' as const }),
  );

  TestBed.configureTestingModule({
    providers: [
      TrinityApplicationSessionAdapter,
      MockProvider(Router, { navigate }),
      MockProvider(Location, { back: locationBack }),
      MockProvider(BadgeCoordinator, { run: () => EMPTY }),
      MockProvider(NotificationService, {
        run: () => notificationEvents,
        recoverPresentation,
      }),
      MockProvider(NativePushLifetime, {
        run: () => push ?? pushActivations,
        recover: () => of({ kind: 'success' as const }),
      }),
      MockProvider(PushHandoffService, {
        run: () => EMPTY,
        clearRoom: () => of(void 0),
        writeNotificationText: () => of(void 0),
        clearDelivered: () => of(void 0),
        notificationTextLost: EMPTY,
      }),
      MockProvider(ConversationRuntime, {
        focused: signal(null).asReadonly() as never,
      }),
      MockProvider(NavigationFocusService, { run: () => EMPTY }),
      MockProvider(WorkspaceRoutedSurfaceAdapter, {
        roomProjectionDemand: roomProjectionDemand.asReadonly(),
        activeRoomId: activeRoomId.asReadonly(),
        owns: (surface: WorkspaceSurface) => surface === routedSurface(),
        run: () => EMPTY,
      }),
      MockProvider(WorkspaceApplicationSurfacePresenterAdapter, {
        run: () => EMPTY,
      }),
      MockProvider(SpaceRoomOrderService, { run: () => EMPTY }),
      MockProvider(RoomLibraryLifetime, {
        run: () => roomLibrary,
      }),
      MockProvider(TrustLifetime, {
        run: () => trust,
        recover: recoverTrust,
      }),
      MockProvider(TrustAccountStatusService, { run: () => EMPTY }),
      MockProvider(TrustUsersService, { runProjection: () => EMPTY }),
      MockProvider(DeviceConfirmationCoordinator, { run: () => EMPTY }),
      MockProvider(IdentityLifetime, { run: () => identity }),
      MockProvider(NotificationLifetime, {
        run: () => notifications,
        recover: recoverNotifications,
      }),
      MockProvider(RoomAdministrationLifetime, {
        run: () => roomAdministration,
        recover: recoverRoomAdministration,
      }),
      MockProvider(HostDeepLinksService, {
        support: () => of({ kind: 'supported' as const }),
        received: deepLinks,
        closeAuthentication,
      }),
      MockProvider(HostBackService, {
        support: () => of({ kind: 'supported' as const }),
        intents: backIntents,
        background,
      }),
      MockProvider(HostLifecycleService, { events: lifecycleEvents }),
      MockProvider(BackgroundMemoryRelease, { run: () => memoryRelease }),
      MockProvider(WhatsNewLauncherAdapter, { runPending: () => EMPTY }),
      MockProvider(UnprotectedStorageNotice, {
        runPendingNotice: () => EMPTY,
      }),
      MockProvider(LiveTimelineTrimmer, { run: () => timelineTrim }),
      MockProvider(HostUpdatesService, { check: hostUpdateCheck }),
      MockProvider(TrnSurfaceService, {
        openState: dialogOpen,
        hasOpen: hasDialog,
        closeTopmost,
      }),
      MockProvider(WorkspaceBackService, {
        hasActive: computed(
          () => workspaceActive() || workspaceSurface() !== null,
        ),
        activeSurface: workspaceSurface,
        activeOwnsTopmostOverlay: workspaceOwnsOverlay,
        back: workspaceBack,
      }),
      MockProvider(WorkspaceNavigationService, {
        navigate: workspaceNavigate,
        conversationOverList: conversationOverList.asReadonly(),
      }),
      MockProvider(NativeNavigationService, { setHistoryGesturesEnabled }),
      {
        provide: SwUpdate,
        useValue: {
          isEnabled: true,
          versionUpdates,
          unrecoverable,
          checkForUpdate,
          activateUpdate,
        },
      },
      MockProvider(TrnToastService, { show: showToast }),
      // App lock is off: taps open at once (its waiting is NotificationSessionService's).
      MockProvider(AppLockService, {
        status: appLockStatus.asReadonly(),
        whenUnlocked: () => of(undefined),
        // Read by the notification session's push mirror.
        effectiveNotificationText:
          signal<NotificationText>('show').asReadonly(),
      }),
    ],
  });
  return {
    adapter: TestBed.inject(TrinityApplicationSessionAdapter),
    deepLinks,
    backIntents,
    notificationEvents,
    pushActivations,
    lifecycleEvents,
    memoryRelease,
    timelineTrim,
    navigate,
    workspaceNavigate,
    closeAuthentication,
    locationBack,
    background,
    appLockStatus,
    dialogOpen,
    hasDialog,
    closeTopmost,
    workspaceActive,
    workspaceSurface,
    conversationOverList,
    routedSurface,
    workspaceOwnsOverlay,
    workspaceBack,
    setHistoryGesturesEnabled,
    versionUpdates,
    unrecoverable,
    checkForUpdate,
    hostUpdateCheck,
    activateUpdate,
    showToast,
    health: TestBed.inject(CapabilityHealthService),
    recoverTrust,
    recoverPresentation,
    recoverRoomAdministration,
  };
}

function trustHealth(
  context: symbol,
  over: Partial<TrustCapabilityHealth> = {},
): TrustCapabilityHealth {
  return healthFact({
    capability: 'trust',
    operation: 'projection',
    context,
    code: 'trust-reconciliation-failed',
    ...over,
  });
}

function notificationRuleHealth(context: symbol): NotificationRuleHealth {
  return healthFact({
    capability: 'notifications',
    operation: 'room-rules',
    context,
    code: 'room-rules-reconciliation-failed',
  });
}

function roomAdministrationHealth(context: symbol): RoomAdministrationHealth {
  return healthFact({
    capability: 'room-administration',
    operation: 'members',
    context,
    generation: 3,
    code: 'room-administration-reconciliation-failed',
  });
}

let lifetime: Subscription | undefined;

describe('TrinityApplicationSessionAdapter', () => {
  let locationStub: ReturnType<typeof stubLocation> | null = null;

  afterEach(() => {
    lifetime?.unsubscribe();
    vi.useRealTimers();
    locationStub?.restore();
    locationStub = null;
    TestBed.resetTestingModule();
  });

  it('prepares Room Library before readiness opens the live session', () => {
    const preparation = new Subject<RoomLibraryLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup({ roomLibrary: preparation });
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(preparation.observed).toBe(true);
    expect(test.deepLinks.observed).toBe(false);
    expect(test.notificationEvents.observed).toBe(false);
    expect(test.backIntents.observed).toBe(false);
    expect(test.lifecycleEvents.observed).toBe(false);
    expect(test.memoryRelease.observed).toBe(false);
    expect(test.timelineTrim.observed).toBe(false);
    expect(test.hostUpdateCheck).not.toHaveBeenCalled();

    preparation.next({ kind: 'prepared' });
    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(test.deepLinks.observed).toBe(false);
    expect(test.notificationEvents.observed).toBe(false);

    readiness.next();
    readiness.complete();
    expect(test.deepLinks.observed).toBe(true);
    expect(test.notificationEvents.observed).toBe(true);
    expect(test.backIntents.observed).toBe(true);
    expect(test.lifecycleEvents.observed).toBe(true);
    expect(test.memoryRelease.observed).toBe(true);
    expect(test.timelineTrim.observed).toBe(true);
    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();

    lifetime.unsubscribe();
    expect(test.memoryRelease.observed).toBe(false);
    expect(test.timelineTrim.observed).toBe(false);
    expect(preparation.observed).toBe(false);
    expect(test.deepLinks.observed).toBe(false);
    expect(test.notificationEvents.observed).toBe(false);
  });

  it('owns Back before readiness and shares that listener through the running transition', () => {
    const readiness = new Subject<void>();
    const test = setup();
    const startupOwner = test.adapter.runInteractions().subscribe();
    const sessionOwner = test.adapter.run(readiness).subscribe();

    expect(test.backIntents.observed).toBe(true);
    test.dialogOpen.set(true);
    test.closeTopmost.mockReturnValue(true);
    test.backIntents.next({ canGoBack: true });
    expect(test.closeTopmost).toHaveBeenCalledOnce();
    test.dialogOpen.set(false);
    expect(test.locationBack).not.toHaveBeenCalled();

    readiness.next();
    test.backIntents.next({ canGoBack: true });
    expect(test.locationBack).toHaveBeenCalledOnce();

    startupOwner.unsubscribe();
    sessionOwner.unsubscribe();
  });

  it('maps blocked Room Library preparation without opening live streams', () => {
    const test = setup({
      roomLibrary: of({
        kind: 'blocked',
        diagnostic: {
          code: 'room-library-projection-preparation-failed',
        },
      }),
    });
    const events: unknown[] = [];

    test.adapter.run(of(void 0)).subscribe((event) => events.push(event));

    expect(events).toEqual([
      {
        kind: 'blocked',
        recovery: 'retry-startup',
        diagnostic: {
          code: 'room-library-projection-preparation-failed',
        },
      },
    ]);
    expect(test.deepLinks.observed).toBe(false);
    expect(test.notificationEvents.observed).toBe(false);
    expect(test.backIntents.observed).toBe(false);
    expect(test.lifecycleEvents.observed).toBe(false);
  });

  it('classifies a required Room Library failure after readiness and releases the session', () => {
    const roomLibrary = new Subject<RoomLibraryLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup({ roomLibrary });
    const events: unknown[] = [];
    const completed = vi.fn();
    lifetime = test.adapter.run(readiness).subscribe({
      next: (event) => events.push(event),
      complete: completed,
    });
    roomLibrary.next({ kind: 'prepared' });
    readiness.next();
    expect(test.deepLinks.observed).toBe(true);

    roomLibrary.next({
      kind: 'blocked',
      diagnostic: { code: 'room-library-projection-preparation-failed' },
    });

    expect(events).toEqual([
      { kind: 'prepared' },
      {
        kind: 'blocked',
        recovery: 'retry-startup',
        diagnostic: { code: 'room-library-projection-preparation-failed' },
      },
    ]);
    expect(completed).toHaveBeenCalledOnce();
    expect(lifetime.closed).toBe(true);
    expect(roomLibrary.observed).toBe(false);
    expect(test.deepLinks.observed).toBe(false);
  });

  it('releases optional projection lifetimes when preparation blocks', () => {
    const roomLibrary = new Subject<RoomLibraryLifetimeEvent>();
    const trust = new Subject<TrustLifetimeEvent>();
    const identity = new Subject<IdentityLifetimeEvent>();
    const notifications = new Subject<NotificationLifetimeEvent>();
    const roomAdministration = new Subject<RoomAdministrationLifetimeEvent>();
    const test = setup({
      roomLibrary,
      trust,
      identity,
      notifications,
      roomAdministration,
    });
    const events: unknown[] = [];

    test.adapter.run(of(void 0)).subscribe((event) => events.push(event));
    trust.next({ kind: 'prepared' });
    identity.next({ kind: 'prepared' });
    notifications.next({ kind: 'prepared' });
    roomAdministration.next({ kind: 'prepared' });
    roomLibrary.next({
      kind: 'blocked',
      diagnostic: { code: 'room-library-projection-preparation-failed' },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'blocked',
        diagnostic: { code: 'room-library-projection-preparation-failed' },
      }),
    ]);
    expect(roomLibrary.observed).toBe(false);
    expect(trust.observed).toBe(false);
    expect(identity.observed).toBe(false);
    expect(notifications.observed).toBe(false);
    expect(roomAdministration.observed).toBe(false);
  });

  it('retains all optional capability lifetimes across readiness until teardown', () => {
    const trust = new Subject<TrustLifetimeEvent>();
    const identity = new Subject<IdentityLifetimeEvent>();
    const notifications = new Subject<NotificationLifetimeEvent>();
    const roomAdministration = new Subject<RoomAdministrationLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup({ trust, identity, notifications, roomAdministration });
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(trust.observed).toBe(true);
    expect(identity.observed).toBe(true);
    expect(notifications.observed).toBe(true);
    expect(roomAdministration.observed).toBe(true);
    expect(events).toEqual([{ kind: 'prepared' }]);

    readiness.next();
    expect(trust.observed).toBe(true);
    expect(identity.observed).toBe(true);
    expect(notifications.observed).toBe(true);
    expect(roomAdministration.observed).toBe(true);

    lifetime.unsubscribe();
    expect(trust.observed).toBe(false);
    expect(identity.observed).toBe(false);
    expect(notifications.observed).toBe(false);
    expect(roomAdministration.observed).toBe(false);
  });

  it('owns the per-account trust summaries for the whole session', () => {
    const test = setup();
    const accountTrust = new Subject<never>();
    vi.spyOn(TestBed.inject(TrustAccountStatusService), 'run').mockReturnValue(
      accountTrust,
    );
    const readiness = new Subject<void>();

    lifetime = test.adapter.run(readiness).subscribe();
    expect(accountTrust.observed).toBe(true);

    readiness.next();
    expect(accountTrust.observed).toBe(true);

    lifetime.unsubscribe();
    expect(accountTrust.observed).toBe(false);
  });

  it("retains other users' trust for the whole session", () => {
    const test = setup();
    const userTrust = new Subject<never>();
    vi.spyOn(
      TestBed.inject(TrustUsersService),
      'runProjection',
    ).mockReturnValue(userTrust);
    const readiness = new Subject<void>();

    lifetime = test.adapter.run(readiness).subscribe();
    expect(userTrust.observed).toBe(true);

    readiness.next();
    expect(userTrust.observed).toBe(true);

    lifetime.unsubscribe();
    expect(userTrust.observed).toBe(false);
  });

  it('runs the new-device check from before any sign-in until the session ends', () => {
    const test = setup();
    const check = new Subject<never>();
    vi.spyOn(
      TestBed.inject(DeviceConfirmationCoordinator),
      'run',
    ).mockReturnValue(check);
    const readiness = new Subject<void>();

    lifetime = test.adapter.run(readiness).subscribe();
    // Before readiness: the sign-in page is shown before the session is live.
    expect(check.observed).toBe(true);

    readiness.next();
    expect(check.observed).toBe(true);

    lifetime.unsubscribe();
    expect(check.observed).toBe(false);
  });

  it('does not let an unsettled optional lifetime hold required preparation open', () => {
    const readiness = new Subject<void>();
    const optional = new Subject<TrustLifetimeEvent>();
    const test = setup({ trust: optional });
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(optional.observed).toBe(true);

    readiness.next();
    expect(optional.observed).toBe(true);
    lifetime.unsubscribe();
    expect(optional.observed).toBe(false);
  });

  it('registers Room Administration health and targeted recovery without a legacy warning', () => {
    const readiness = new Subject<void>();
    const context = Symbol();
    const test = setup({
      notifications: of(
        { kind: 'health' as const, fact: notificationRuleHealth(context) },
        { kind: 'prepared' as const },
      ),
      roomAdministration: of(
        {
          kind: 'health' as const,
          fact: roomAdministrationHealth(context),
        },
        { kind: 'prepared' as const },
      ),
    });
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(events).toEqual([{ kind: 'prepared' }]);

    readiness.next();

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(test.health.problems()).toEqual([
      expect.objectContaining({
        capability: 'notifications',
        operation: 'room-rules',
        code: 'room-rules-reconciliation-failed',
      }),
      expect.objectContaining({
        capability: 'room-administration',
        operation: 'members',
        code: 'room-administration-reconciliation-failed',
      }),
    ]);
    const roomProblem = test.health
      .problems()
      .find((problem) => problem.capability === 'room-administration')!;
    test.health.recover(roomProblem).subscribe();
    expect(test.recoverRoomAdministration).toHaveBeenCalledWith(
      'members',
      context,
      3,
    );
    expect(lifetime.closed).toBe(false);
  });

  it('restarts Notification and Room Administration lifetimes without retaining listeners', () => {
    let notificationSubscriptions = 0;
    let notificationTeardowns = 0;
    let administrationSubscriptions = 0;
    let administrationTeardowns = 0;
    const notifications = new Observable<NotificationLifetimeEvent>(
      (subscriber) => {
        notificationSubscriptions += 1;
        subscriber.next({ kind: 'prepared' });
        return () => (notificationTeardowns += 1);
      },
    );
    const roomAdministration = new Observable<RoomAdministrationLifetimeEvent>(
      (subscriber) => {
        administrationSubscriptions += 1;
        subscriber.next({ kind: 'prepared' });
        return () => (administrationTeardowns += 1);
      },
    );
    const test = setup({ notifications, roomAdministration });

    const first = test.adapter.run(of(void 0)).subscribe();
    expect(notificationSubscriptions).toBe(1);
    expect(administrationSubscriptions).toBe(1);
    first.unsubscribe();
    expect(notificationTeardowns).toBe(1);
    expect(administrationTeardowns).toBe(1);

    const second = test.adapter.run(of(void 0)).subscribe();
    expect(notificationSubscriptions).toBe(2);
    expect(administrationSubscriptions).toBe(2);
    second.unsubscribe();
    expect(notificationTeardowns).toBe(2);
    expect(administrationTeardowns).toBe(2);
  });

  it('registers scoped Trust health and recovery without a permanent warning', async () => {
    const context = Symbol();
    const trust = new Subject<TrustLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup({ trust });
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    trust.next({ kind: 'health', fact: trustHealth(context) });
    trust.next({ kind: 'prepared' });
    expect(events).toEqual([{ kind: 'prepared' }]);
    readiness.next();

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(test.health.problems()).toHaveLength(1);
    const problem = test.health.problems()[0];
    await lastValueFrom(test.health.recover(problem));
    expect(test.recoverTrust).toHaveBeenCalledWith(context, 1);
  });

  it('reports a late Trust degradation without preparing or restarting live work again', () => {
    const trust = new Subject<TrustLifetimeEvent>();
    const identity = new Subject<IdentityLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup({ trust, identity });
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    trust.next({ kind: 'prepared' });
    identity.next({ kind: 'prepared' });
    readiness.next();
    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();

    trust.next({ kind: 'health', fact: trustHealth(Symbol()) });

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(test.health.problems()).toHaveLength(1);
    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();
    expect(test.deepLinks.observed).toBe(true);
    expect(lifetime.closed).toBe(false);
  });

  it('keeps broken lifetime adapters on the Observable error channel', () => {
    const failure = new Error('broken Trust lifetime adapter');
    const error = vi.fn();
    const test = setup({ trust: throwError(() => failure) });

    test.adapter.run(of(void 0)).subscribe({ error });

    expect(error).toHaveBeenCalledWith(failure);
  });

  it('forwards valid SSO and OIDC callbacks and ignores unrelated links', async () => {
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({
      url: 'dev.trinityproject.trinity://sso-callback?loginToken=TOK&sso_state=NONCE',
    });
    test.deepLinks.next({
      url: 'dev.trinityproject.trinity:/sso-callback?code=CODE&state=STATE',
    });
    test.deepLinks.next({
      url: 'dev.trinityproject.trinity://elsewhere?loginToken=IGNORED',
    });

    await vi.waitFor(() => expect(test.navigate).toHaveBeenCalledTimes(2));
    expect(test.navigate).toHaveBeenNthCalledWith(1, ['/sso-callback'], {
      queryParams: { loginToken: 'TOK', sso_state: 'NONCE' },
    });
    expect(test.navigate).toHaveBeenNthCalledWith(2, ['/sso-callback'], {
      queryParams: { code: 'CODE', state: 'STATE' },
    });
    expect(test.closeAuthentication).toHaveBeenCalledTimes(2);
  });

  it('keeps the provider iss on an OIDC callback', async () => {
    // The callback page checks that the sign-in response comes from the provider it
    // started with (RFC 9207), so the deep link must not drop `iss` on the way there.
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({
      url: 'dev.trinityproject.trinity:/sso-callback?code=CODE&state=STATE&iss=https%3A%2F%2Fop.example%2F',
    });

    await vi.waitFor(() => expect(test.navigate).toHaveBeenCalledTimes(1));
    expect(test.navigate).toHaveBeenCalledWith(['/sso-callback'], {
      queryParams: { code: 'CODE', state: 'STATE', iss: 'https://op.example/' },
    });
  });

  it('hands a valid room link to the Rooms shell and leaves SSO untouched', async () => {
    const test = setup();
    const inbound = TestBed.inject(InboundRoomLinkService);
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({
      url: 'dev.trinityproject.trinity://matrix.to/#/%21room%3Aexample.org?via=example.org',
    });

    expect(inbound.pending()).toEqual({
      kind: 'room',
      roomIdOrAlias: '!room:example.org',
      via: ['example.org'],
    });
    expect(test.navigate).not.toHaveBeenCalled();
    expect(test.closeAuthentication).not.toHaveBeenCalled();
  });

  it('keeps only the newest unopened room link', () => {
    const test = setup();
    const inbound = TestBed.inject(InboundRoomLinkService);
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({
      url: 'dev.trinityproject.trinity://matrix.to/#/!a:example.org',
    });
    test.deepLinks.next({
      url: 'dev.trinityproject.trinity://matrix.to/#/!b:example.org',
    });

    expect(inbound.pending()?.roomIdOrAlias).toBe('!b:example.org');
  });

  it.each([
    'dev.trinityproject.trinity://evil.example/#/!room:example.org',
    'eu.qwky.trinity://matrix.to/#/!room:example.org',
    'eu.qwky.trinity://sso-callback?loginToken=OLD',
    'dev.trinityproject.trinity://matrix.to/#/@user:example.org',
    'dev.trinityproject.trinity://matrix.to/#/not-a-room',
    `dev.trinityproject.trinity://matrix.to/#/!${'a'.repeat(5000)}:example.org`,
    'not a url',
  ])('ignores hostile or unsupported link %s', (url) => {
    const test = setup();
    const inbound = TestBed.inject(InboundRoomLinkService);
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({ url });

    expect(inbound.pending()).toBeNull();
    expect(test.navigate).not.toHaveBeenCalled();
    expect(test.closeAuthentication).not.toHaveBeenCalled();
  });

  it('keeps a failed authentication close contextual while completing the deep link', async () => {
    const test = setup();
    test.closeAuthentication.mockReturnValueOnce(
      of({
        kind: 'unavailable',
        reason: 'host-rejected',
        diagnostic: { code: 'private-host-response' },
      }),
    );
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({
      url: 'dev.trinityproject.trinity://sso-callback?loginToken=TOKEN',
    });

    await vi.waitFor(() => expect(test.navigate).toHaveBeenCalledOnce());
    expect(test.health.incidents()).toContainEqual(
      expect.objectContaining({
        capability: 'host',
        operation: 'authentication-handoff',
        code: 'authentication-close-failed',
      }),
    );
    expect(JSON.stringify(test.health.incidents())).not.toContain('private');
    expect(lifetime.closed).toBe(false);
  });

  it('reports released deep-link and Back ownership and reattaches both streams', async () => {
    vi.useFakeTimers();
    let deepLinkAttachments = 0;
    let backAttachments = 0;
    const test = setup();
    ngMocks.stubMember(
      TestBed.inject(HostDeepLinksService),
      'received',
      new Observable<{ readonly url: string }>((subscriber) => {
        deepLinkAttachments++;
        subscriber.complete();
      }),
    );
    ngMocks.stubMember(
      TestBed.inject(HostBackService),
      'intents',
      new Observable<{ readonly canGoBack: boolean }>((subscriber) => {
        backAttachments++;
        subscriber.complete();
      }),
    );

    lifetime = test.adapter.run(of(void 0)).subscribe();
    expect(test.health.incidents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'deep-links',
          code: 'deep-link-listener-ownership-released',
        }),
        expect.objectContaining({
          operation: 'back',
          code: 'host-back-listener-ownership-released',
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(deepLinkAttachments).toBe(2);
    expect(backAttachments).toBe(2);
    lifetime.unsubscribe();
    vi.useRealTimers();
  });

  it('keeps unsupported deep-link and Back streams dormant without incidents', async () => {
    vi.useFakeTimers();
    const test = setup();
    ngMocks.stubMember(TestBed.inject(HostDeepLinksService), 'support', () =>
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );
    ngMocks.stubMember(TestBed.inject(HostBackService), 'support', () =>
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );

    lifetime = test.adapter.run(of(void 0)).subscribe();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(test.deepLinks.observed).toBe(false);
    expect(test.backIntents.observed).toBe(false);
    expect(test.health.incidents()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'deep-links' }),
        expect.objectContaining({ operation: 'back' }),
      ]),
    );
    expect(test.showToast).not.toHaveBeenCalledWith(
      'A host navigation action could not be completed.',
      expect.anything(),
    );
    lifetime.unsubscribe();
    vi.useRealTimers();
  });

  it('retries failed and empty host support probes before attaching streams', async () => {
    vi.useFakeTimers();
    const test = setup();
    const deepLinkSupport = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => new Error('private deep-link failure')),
      )
      .mockReturnValue(of({ kind: 'supported' as const }));
    const backSupport = vi
      .fn()
      .mockReturnValueOnce(EMPTY)
      .mockReturnValue(of({ kind: 'supported' as const }));
    ngMocks.stubMember(
      TestBed.inject(HostDeepLinksService),
      'support',
      deepLinkSupport,
    );
    ngMocks.stubMember(TestBed.inject(HostBackService), 'support', backSupport);

    lifetime = test.adapter.run(of(void 0)).subscribe();
    expect(deepLinkSupport).toHaveBeenCalledOnce();
    expect(backSupport).toHaveBeenCalledOnce();
    expect(test.deepLinks.observed).toBe(false);
    expect(test.backIntents.observed).toBe(false);
    expect(test.health.incidents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'deep-links',
          code: 'deep-link-support-check-failed',
        }),
        expect.objectContaining({
          operation: 'back',
          code: 'host-back-support-check-failed',
        }),
      ]),
    );
    expect(JSON.stringify(test.health.incidents())).not.toContain('private');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(deepLinkSupport).toHaveBeenCalledTimes(2);
    expect(backSupport).toHaveBeenCalledTimes(2);
    expect(test.deepLinks.observed).toBe(true);
    expect(test.backIntents.observed).toBe(true);
    lifetime.unsubscribe();
    vi.useRealTimers();
  });

  it('submits typed notification activation to semantic Workspace navigation', async () => {
    const test = setup();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.notificationEvents.next({
      kind: 'activated',
      destination: {
        accountId: '@background:example.org',
        roomId: '!room:example.org',
        eventId: '$event',
      },
    });

    await vi.waitFor(() =>
      expect(test.workspaceNavigate).toHaveBeenCalledWith({
        kind: 'notification',
        accountId: '@background:example.org',
        roomId: '!room:example.org',
        eventId: '$event',
      }),
    );
    expect(test.navigate).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('owns native push from synchronous startup activation through teardown and restart', async () => {
    let subscriptions = 0;
    let teardowns = 0;
    const pushSession = new Observable<NativePushLifetimeEvent>(
      (subscriber) => {
        subscriptions++;
        subscriber.next({
          kind: 'activated',
          destination: {
            accountId: '@background:example.org',
            roomId: '!room:example.org',
            eventId: '$event',
          },
        });
        return () => teardowns++;
      },
    );
    const test = setup({ push: pushSession });
    const firstLifetime = test.adapter.run(of(void 0)).subscribe();

    await vi.waitFor(() =>
      expect(test.workspaceNavigate).toHaveBeenCalledWith({
        kind: 'notification',
        accountId: '@background:example.org',
        roomId: '!room:example.org',
        eventId: '$event',
      }),
    );
    firstLifetime.unsubscribe();
    expect(teardowns).toBe(1);

    test.workspaceNavigate.mockClear();
    const secondLifetime = test.adapter.run(of(void 0)).subscribe();
    await vi.waitFor(() =>
      expect(test.workspaceNavigate).toHaveBeenCalledOnce(),
    );
    expect(subscriptions).toBe(2);
    secondLifetime.unsubscribe();
    expect(teardowns).toBe(2);
  });

  it('reports rejected notification navigation without ending the session', async () => {
    const test = setup();
    test.workspaceNavigate.mockReturnValueOnce(
      of({ kind: 'unavailable', reason: 'navigation-rejected' }),
    );
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.notificationEvents.next({
      kind: 'activated',
      destination: {
        accountId: '@me:example.org',
        roomId: '!missing:example.org',
        eventId: '$event',
      },
    });

    await vi.waitFor(() =>
      expect(test.health.incidents()).toContainEqual(
        expect.objectContaining({
          capability: 'notifications',
          operation: 'navigation',
          code: 'notification-navigation-rejected',
        }),
      ),
    );
    expect(test.showToast).toHaveBeenCalledWith(
      'That notification destination could not be opened.',
      { duration: 4000, variant: 'danger' },
    );
    expect(lifetime.closed).toBe(false);
  });

  it('reports broken notification navigation without ending the session', async () => {
    const test = setup();
    test.workspaceNavigate.mockReturnValueOnce(
      new Observable((subscriber) => subscriber.error(new Error('broken'))),
    );
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.notificationEvents.next({
      kind: 'activated',
      destination: {
        accountId: '@me:example.org',
        roomId: '!room:example.org',
        eventId: '$event',
      },
    });

    await vi.waitFor(() =>
      expect(test.health.incidents()).toContainEqual(
        expect.objectContaining({ code: 'notification-navigation-failed' }),
      ),
    );
    expect(lifetime.closed).toBe(false);
  });

  it('reports presentation failures without navigating or ending the session', () => {
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.notificationEvents.next({
      kind: 'incident',
      incident: {
        context: Symbol(),
        capability: 'notifications',
        operation: 'presentation-command',
        code: 'notification-presentation-failed',
      },
    });

    expect(test.health.incidents()).toContainEqual(
      expect.objectContaining({
        capability: 'notifications',
        operation: 'presentation-command',
        code: 'notification-presentation-failed',
      }),
    );
    expect(test.showToast).toHaveBeenCalledWith(
      'A notification could not be shown.',
      { duration: 4000, variant: 'danger' },
    );
    expect(test.workspaceNavigate).not.toHaveBeenCalled();
    expect(lifetime.closed).toBe(false);
  });

  it('registers exact notification-presentation health recovery', async () => {
    const context = Symbol();
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.notificationEvents.next({
      kind: 'health',
      fact: healthFact({
        capability: 'notifications',
        operation: 'presentation',
        context,
        generation: 3,
        ownership: 'released',
        code: 'notification-activation-ownership-released',
      }),
    });

    const problem = test.health.problems()[0];
    await lastValueFrom(test.health.recover(problem));

    expect(test.recoverPresentation).toHaveBeenCalledWith(context, 3);
    expect(lifetime.closed).toBe(false);
  });

  it('keeps Back priority at dialog, Workspace surface, history, then background', () => {
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.dialogOpen.set(true);
    test.backIntents.next({ canGoBack: true });
    expect(test.closeTopmost).toHaveBeenCalledOnce();
    expect(test.locationBack).not.toHaveBeenCalled();

    test.dialogOpen.set(false);
    test.workspaceActive.set(true);
    test.backIntents.next({ canGoBack: true });
    expect(test.workspaceBack).toHaveBeenCalledOnce();
    expect(test.locationBack).not.toHaveBeenCalled();

    test.workspaceActive.set(false);
    test.backIntents.next({ canGoBack: true });
    expect(test.locationBack).toHaveBeenCalledOnce();

    test.backIntents.next({ canGoBack: false });
    expect(test.background).toHaveBeenCalledOnce();
  });

  it.each<AppLockStatus>(['locked', 'unknown'])(
    'sends the app to the background on Back while App lock covers it (%s)',
    (status) => {
      const test = setup();
      test.appLockStatus.set(status);
      lifetime = test.adapter.run(of(void 0)).subscribe();

      // A dialog, a Workspace surface and history are all behind the lock screen.
      test.dialogOpen.set(true);
      test.workspaceActive.set(true);
      test.backIntents.next({ canGoBack: true });

      expect(test.closeTopmost).not.toHaveBeenCalled();
      expect(test.workspaceBack).not.toHaveBeenCalled();
      expect(test.locationBack).not.toHaveBeenCalled();
      expect(test.background).toHaveBeenCalledOnce();
    },
  );

  it('drops Back while locked where the host cannot background the app', () => {
    const test = setup();
    test.appLockStatus.set('locked');
    test.background.mockReturnValueOnce(
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.dialogOpen.set(true);
    test.backIntents.next({ canGoBack: true });

    expect(test.closeTopmost).not.toHaveBeenCalled();
    expect(test.locationBack).not.toHaveBeenCalled();
    expect(test.health.incidents()).toEqual([]);
    expect(lifetime.closed).toBe(false);
  });

  it('handles Back as before once App lock is unlocked', () => {
    const test = setup();
    test.appLockStatus.set('unlocked');
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.dialogOpen.set(true);
    test.backIntents.next({ canGoBack: true });
    expect(test.closeTopmost).toHaveBeenCalledOnce();
    expect(test.background).not.toHaveBeenCalled();

    test.dialogOpen.set(false);
    test.backIntents.next({ canGoBack: true });
    expect(test.locationBack).toHaveBeenCalledOnce();
    expect(test.background).not.toHaveBeenCalled();
  });

  it('reports a rejected host background action as an incident without ending Back ownership', () => {
    const test = setup();
    test.background.mockReturnValueOnce(
      of({
        kind: 'unavailable',
        reason: 'host-rejected',
        diagnostic: { code: 'private-background' },
      }),
    );
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.backIntents.next({ canGoBack: false });

    expect(test.health.incidents()).toContainEqual(
      expect.objectContaining({
        capability: 'host',
        operation: 'back',
        code: 'host-background-failed',
      }),
    );
    expect(lifetime.closed).toBe(false);
  });

  it('offers an overlay owned by Workspace before the generic dialog stack', () => {
    const test = setup();
    test.dialogOpen.set(true);
    test.workspaceActive.set(true);
    test.workspaceOwnsOverlay.mockReturnValue(true);
    lifetime = test.adapter.run(of(void 0)).subscribe();

    test.backIntents.next({ canGoBack: true });

    expect(test.workspaceBack).toHaveBeenCalledOnce();
    expect(test.closeTopmost).not.toHaveBeenCalled();
    expect(test.locationBack).not.toHaveBeenCalled();
  });

  it('owns native gesture policy only for the active session', () => {
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(true);

    test.dialogOpen.set(true);
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(false);

    lifetime.unsubscribe();
    const callsAfterStop = test.setHistoryGesturesEnabled.mock.calls.length;
    test.dialogOpen.set(false);
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenCalledTimes(
      callsAfterStop,
    );
  });

  it('keeps the native Back gesture on a routed Settings page until a dialog or panel covers it', () => {
    const test = setup();
    const routedSettings: WorkspaceSurface = {
      layer: 'application',
      surface: { kind: 'settings', section: 'appearance' },
    };
    test.routedSurface.set(routedSettings);
    test.workspaceSurface.set(routedSettings);
    lifetime = test.adapter.run(of(void 0)).subscribe();
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(true);

    test.dialogOpen.set(true);
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(false);
    test.dialogOpen.set(false);
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(true);

    test.workspaceSurface.set({ layer: 'room', surface: { kind: 'threads' } });
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(false);
    test.workspaceSurface.set(routedSettings);
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(true);
  });

  it.each(['setup', 'unlock', 'verify'] as const)(
    'keeps the native Back gesture on the routed Encryption %s page',
    (flow) => {
      const test = setup();
      const routedTrust: WorkspaceSurface = {
        layer: 'application',
        surface: { kind: 'trust', flow },
      };
      test.routedSurface.set(routedTrust);
      test.workspaceSurface.set(routedTrust);
      lifetime = test.adapter.run(of(void 0)).subscribe();
      TestBed.tick();

      expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(true);
    },
  );

  it('turns the native Back gesture on over a Conversation pushed over its list (#1113)', () => {
    const test = setup();
    test.workspaceSurface.set({
      layer: 'conversation',
      surface: { kind: 'conversation', accountId: 'a1', roomId: '!r:hs' },
    });
    test.conversationOverList.set(true);
    lifetime = test.adapter.run(of(void 0)).subscribe();
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(true);

    // A panel over it, or a dialog, still owns Back.
    test.workspaceSurface.set({ layer: 'room', surface: { kind: 'threads' } });
    TestBed.tick();
    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(false);
  });

  it('keeps the native Back gesture off over a phone Conversation, which Workspace dismisses to the list', () => {
    const test = setup();
    test.workspaceSurface.set({
      layer: 'conversation',
      surface: { kind: 'conversation', accountId: 'a1', roomId: '!r:hs' },
    });
    lifetime = test.adapter.run(of(void 0)).subscribe();
    TestBed.tick();

    expect(test.setHistoryGesturesEnabled).toHaveBeenLastCalledWith(false);
  });

  it('offers, activates and reloads a ready service-worker version', async () => {
    locationStub = stubLocation();
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();
    test.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    });

    expect(test.showToast).toHaveBeenCalledOnce();
    const [message, options] = test.showToast.mock.calls[0];
    expect(message).toContain('new version');
    expect(options).toMatchObject({
      duration: 0,
      action: { label: 'Reload' },
    });
    options?.action?.onClick();
    await vi.waitFor(() => expect(test.activateUpdate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(locationStub?.calls).toContain('reload'));
  });

  it('checks on foreground and stops update reactions after teardown', () => {
    locationStub = stubLocation();
    const test = setup();
    lifetime = test.adapter.run(of(void 0)).subscribe();

    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();
    test.lifecycleEvents.next({ kind: 'active' });
    expect(test.hostUpdateCheck).toHaveBeenCalledTimes(2);

    lifetime.unsubscribe();
    test.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    });
    test.unrecoverable.next({
      type: 'UNRECOVERABLE_STATE',
      reason: 'cache gone',
    });
    test.lifecycleEvents.next({ kind: 'active' });

    expect(test.showToast).not.toHaveBeenCalled();
    expect(test.hostUpdateCheck).toHaveBeenCalledTimes(2);
    expect(locationStub.calls).not.toContain('reload');
  });

  it('projects a rejected initial host update check as recoverable health', () => {
    const test = setup();
    test.hostUpdateCheck.mockReturnValueOnce(
      of({
        kind: 'rejected',
        diagnostic: { code: 'host-update-failed' },
      }),
    );
    const events: unknown[] = [];
    lifetime = test.adapter
      .run(of(void 0))
      .subscribe((event) => events.push(event));

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(test.health.problems()).toEqual([
      expect.objectContaining({
        capability: 'updates',
        operation: 'check',
        code: 'update-check-failed',
      }),
    ]);
  });
});

function stubLocation(): {
  readonly calls: string[];
  readonly restore: () => void;
} {
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  const calls: string[] = [];
  Object.defineProperty(window, 'location', {
    value: { reload: () => calls.push('reload') },
    writable: true,
    configurable: true,
  });
  return {
    calls,
    restore: () => {
      if (original) Object.defineProperty(window, 'location', original);
    },
  };
}
