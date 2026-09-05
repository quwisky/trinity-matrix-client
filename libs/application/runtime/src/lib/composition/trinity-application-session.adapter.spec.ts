import { Location } from '@angular/common';
import { signal } from '@angular/core';
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
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  NotificationLifetime,
  NotificationLifetimeError,
  NotificationService,
  PushService,
  type NativePushActivation,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
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
  RoomAdministrationLifetimeError,
} from '@trinity/data-access/room-administration';
import { TrustLifetime, TrustOperationError } from '@trinity/data-access/trust';
import { NativeNavigationService } from '@trinity/platform-native';
import {
  HostBackService,
  HostDeepLinksService,
  HostLifecycleService,
  HostUpdatesService,
} from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { EMPTY, Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';
import { TrinityApplicationSessionAdapter } from './trinity-application-session.adapter';

interface SessionHarness {
  readonly adapter: TrinityApplicationSessionAdapter;
  readonly deepLinks: Subject<{ readonly url: string }>;
  readonly backIntents: Subject<{ readonly canGoBack: boolean }>;
  readonly notificationEvents: Subject<NotificationRuntimeEvent>;
  readonly pushActivations: Subject<NativePushActivation>;
  readonly lifecycleEvents: Subject<
    { readonly kind: 'active' } | { readonly kind: 'background' }
  >;
  readonly navigate: ReturnType<typeof vi.fn>;
  readonly workspaceNavigate: ReturnType<typeof vi.fn>;
  readonly closeAuthentication: ReturnType<typeof vi.fn>;
  readonly locationBack: ReturnType<typeof vi.fn>;
  readonly background: ReturnType<typeof vi.fn>;
  readonly dialogOpen: ReturnType<typeof signal<boolean>>;
  readonly hasDialog: ReturnType<typeof vi.fn>;
  readonly closeTopmost: ReturnType<typeof vi.fn>;
  readonly workspaceActive: ReturnType<typeof signal<boolean>>;
  readonly workspaceOwnsOverlay: ReturnType<typeof vi.fn>;
  readonly workspaceBack: ReturnType<typeof vi.fn>;
  readonly setHistoryGesturesEnabled: ReturnType<typeof vi.fn>;
  readonly versionUpdates: Subject<VersionEvent>;
  readonly unrecoverable: Subject<UnrecoverableStateEvent>;
  readonly checkForUpdate: ReturnType<typeof vi.fn>;
  readonly hostUpdateCheck: ReturnType<typeof vi.fn>;
  readonly activateUpdate: ReturnType<typeof vi.fn>;
  readonly showToast: ReturnType<typeof vi.fn>;
}

function setup(
  pushSession?: Observable<NativePushActivation>,
  roomLibrarySession: Observable<RoomLibraryLifetimeEvent> = of({
    kind: 'prepared',
  }),
  trustSession: Observable<void> = of(void 0),
  identitySession: Observable<IdentityLifetimeEvent> = of({ kind: 'prepared' }),
  notificationSession: Observable<void> = of(void 0),
  roomAdministrationSession: Observable<void> = of(void 0),
): SessionHarness {
  const deepLinks = new Subject<{ readonly url: string }>();
  const backIntents = new Subject<{ readonly canGoBack: boolean }>();
  const notificationEvents = new Subject<NotificationRuntimeEvent>();
  const pushActivations = new Subject<NativePushActivation>();
  const lifecycleEvents = new Subject<
    { readonly kind: 'active' } | { readonly kind: 'background' }
  >();
  const navigate = vi.fn().mockResolvedValue(true);
  const workspaceNavigate = vi.fn(() =>
    of({ kind: 'ready', change: 'committed' } as const),
  );
  const closeAuthentication = vi.fn(() => of({ kind: 'completed' as const }));
  const locationBack = vi.fn();
  const background = vi.fn(() => of({ kind: 'completed' as const }));
  const dialogOpen = signal(false);
  const hasDialog = vi.fn(() => dialogOpen());
  const closeTopmost = vi.fn(() => false);
  const workspaceActive = signal(false);
  const workspaceOwnsOverlay = vi.fn(() => false);
  const workspaceBack = vi.fn(() => of({ kind: 'unhandled' as const }));
  const setHistoryGesturesEnabled = vi.fn();
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<UnrecoverableStateEvent>();
  const checkForUpdate = vi.fn().mockResolvedValue(true);
  const hostUpdateCheck = vi.fn(() => of({ kind: 'completed' as const }));
  const activateUpdate = vi.fn().mockResolvedValue(true);
  const showToast = vi.fn();
  const roomProjectionDemand = signal(true);

  TestBed.configureTestingModule({
    providers: [
      TrinityApplicationSessionAdapter,
      MockProvider(Router, { navigate }),
      MockProvider(Location, { back: locationBack }),
      MockProvider(BadgeCoordinator, { run: () => EMPTY }),
      MockProvider(NotificationService, { run: () => notificationEvents }),
      MockProvider(PushService, { run: () => pushSession ?? pushActivations }),
      MockProvider(NavigationFocusService, { run: () => EMPTY }),
      MockProvider(WorkspaceRoutedSurfaceAdapter, {
        roomProjectionDemand: roomProjectionDemand.asReadonly(),
        run: () => EMPTY,
      }),
      MockProvider(WorkspaceApplicationSurfacePresenterAdapter, {
        run: () => EMPTY,
      }),
      MockProvider(SpaceRoomOrderService, { run: () => EMPTY }),
      MockProvider(RoomLibraryLifetime, {
        run: () => roomLibrarySession,
      }),
      MockProvider(TrustLifetime, { run: () => trustSession }),
      MockProvider(IdentityLifetime, { run: () => identitySession }),
      MockProvider(NotificationLifetime, { run: () => notificationSession }),
      MockProvider(RoomAdministrationLifetime, {
        run: () => roomAdministrationSession,
      }),
      MockProvider(HostDeepLinksService, {
        received: deepLinks,
        closeAuthentication,
      }),
      MockProvider(HostBackService, { intents: backIntents, background }),
      MockProvider(HostLifecycleService, { events: lifecycleEvents }),
      MockProvider(HostUpdatesService, { check: hostUpdateCheck }),
      MockProvider(TrnDialogService, {
        openState: dialogOpen,
        hasOpen: hasDialog,
        closeTopmost,
      }),
      MockProvider(WorkspaceBackService, {
        hasActive: workspaceActive,
        activeOwnsTopmostOverlay: workspaceOwnsOverlay,
        back: workspaceBack,
      }),
      MockProvider(WorkspaceNavigationService, { navigate: workspaceNavigate }),
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
    ],
  });
  return {
    adapter: TestBed.inject(TrinityApplicationSessionAdapter),
    deepLinks,
    backIntents,
    notificationEvents,
    pushActivations,
    lifecycleEvents,
    navigate,
    workspaceNavigate,
    closeAuthentication,
    locationBack,
    background,
    dialogOpen,
    hasDialog,
    closeTopmost,
    workspaceActive,
    workspaceOwnsOverlay,
    workspaceBack,
    setHistoryGesturesEnabled,
    versionUpdates,
    unrecoverable,
    checkForUpdate,
    hostUpdateCheck,
    activateUpdate,
    showToast,
  };
}

describe('TrinityApplicationSessionAdapter', () => {
  let locationStub: ReturnType<typeof stubLocation> | null = null;

  afterEach(() => {
    locationStub?.restore();
    locationStub = null;
    TestBed.resetTestingModule();
  });

  it('prepares Room Library before readiness opens the live session', () => {
    const preparation = new Subject<RoomLibraryLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup(undefined, preparation);
    const events: unknown[] = [];
    const lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(preparation.observed).toBe(true);
    expect(test.deepLinks.observed).toBe(false);
    expect(test.notificationEvents.observed).toBe(false);
    expect(test.backIntents.observed).toBe(false);
    expect(test.lifecycleEvents.observed).toBe(false);
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
    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();

    lifetime.unsubscribe();
    expect(preparation.observed).toBe(false);
    expect(test.deepLinks.observed).toBe(false);
    expect(test.notificationEvents.observed).toBe(false);
  });

  it('maps blocked Room Library preparation without opening live streams', () => {
    const test = setup(
      undefined,
      of({
        kind: 'blocked',
        diagnostic: {
          code: 'room-library-projection-preparation-failed',
        },
      }),
    );
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
    const test = setup(undefined, roomLibrary);
    const events: unknown[] = [];
    const completed = vi.fn();
    const lifetime = test.adapter.run(readiness).subscribe({
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
    const trust = new Subject<void>();
    const identity = new Subject<IdentityLifetimeEvent>();
    const notifications = new Subject<void>();
    const roomAdministration = new Subject<void>();
    const test = setup(
      undefined,
      roomLibrary,
      trust,
      identity,
      notifications,
      roomAdministration,
    );
    const events: unknown[] = [];

    test.adapter.run(of(void 0)).subscribe((event) => events.push(event));
    trust.next();
    identity.next({ kind: 'prepared' });
    notifications.next();
    roomAdministration.next();
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
    const trust = new Subject<void>();
    const identity = new Subject<IdentityLifetimeEvent>();
    const notifications = new Subject<void>();
    const roomAdministration = new Subject<void>();
    const readiness = new Subject<void>();
    const test = setup(
      undefined,
      of({ kind: 'prepared' }),
      trust,
      identity,
      notifications,
      roomAdministration,
    );
    const events: unknown[] = [];
    const lifetime = test.adapter
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

  it('does not let an unsettled optional lifetime hold required preparation open', () => {
    const readiness = new Subject<void>();
    const optional = new Subject<void>();
    const test = setup(
      undefined,
      of({ kind: 'prepared' }),
      optional,
      of({ kind: 'prepared' }),
      of(void 0),
      of(void 0),
    );
    const events: unknown[] = [];
    const lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(optional.observed).toBe(true);

    readiness.next();
    expect(optional.observed).toBe(true);
    lifetime.unsubscribe();
    expect(optional.observed).toBe(false);
  });

  it('reports optional Notification and Room Administration preparation failures', () => {
    const readiness = new Subject<void>();
    const test = setup(
      undefined,
      of({ kind: 'prepared' }),
      of(void 0),
      of({ kind: 'prepared' }),
      throwError(() => new NotificationLifetimeError()),
      throwError(() => new RoomAdministrationLifetimeError()),
    );
    const events: unknown[] = [];
    const lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(events).toEqual([{ kind: 'prepared' }]);

    readiness.next();

    expect(events).toEqual([
      { kind: 'prepared' },
      {
        kind: 'warning',
        warning: expect.objectContaining({
          scope: 'notifications',
          diagnostic: { code: 'room-notification-projection-unavailable' },
        }),
      },
      {
        kind: 'warning',
        warning: expect.objectContaining({
          scope: 'room-administration',
          diagnostic: { code: 'room-administration-projection-unavailable' },
        }),
      },
    ]);
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('restarts Notification and Room Administration lifetimes without retaining listeners', () => {
    let notificationSubscriptions = 0;
    let notificationTeardowns = 0;
    let administrationSubscriptions = 0;
    let administrationTeardowns = 0;
    const notifications = new Observable<void>((subscriber) => {
      notificationSubscriptions += 1;
      subscriber.next();
      return () => (notificationTeardowns += 1);
    });
    const roomAdministration = new Observable<void>((subscriber) => {
      administrationSubscriptions += 1;
      subscriber.next();
      return () => (administrationTeardowns += 1);
    });
    const test = setup(
      undefined,
      of({ kind: 'prepared' }),
      of(void 0),
      of({ kind: 'prepared' }),
      notifications,
      roomAdministration,
    );

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

  it('reports optional Trust failures after readiness', () => {
    const trustFailure = new TrustOperationError(
      'refresh-health',
      'server-failure',
      'retry',
      'Trust is temporarily unavailable.',
    );
    const readiness = new Subject<void>();
    const test = setup(
      undefined,
      of({ kind: 'prepared' }),
      throwError(() => trustFailure),
    );
    const events: unknown[] = [];
    const lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    expect(events).toEqual([{ kind: 'prepared' }]);

    readiness.next();

    expect(events).toEqual([
      { kind: 'prepared' },
      {
        kind: 'warning',
        warning: {
          stage: 'session',
          scope: 'trust',
          diagnostic: { code: 'trust-projection-unavailable' },
          recovery: 'retry-startup',
        },
      },
    ]);
    lifetime.unsubscribe();
  });

  it('reports a late optional failure without preparing or restarting live work again', () => {
    const trust = new Subject<void>();
    const identity = new Subject<IdentityLifetimeEvent>();
    const readiness = new Subject<void>();
    const test = setup(undefined, of({ kind: 'prepared' }), trust, identity);
    const events: unknown[] = [];
    const lifetime = test.adapter
      .run(readiness)
      .subscribe((event) => events.push(event));

    trust.next();
    identity.next({ kind: 'prepared' });
    readiness.next();
    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();

    trust.error(
      new TrustOperationError(
        'refresh-health',
        'server-failure',
        'retry',
        'Trust is temporarily unavailable.',
      ),
    );

    expect(events).toEqual([
      { kind: 'prepared' },
      {
        kind: 'warning',
        warning: expect.objectContaining({
          scope: 'trust',
          diagnostic: { code: 'trust-projection-unavailable' },
        }),
      },
    ]);
    expect(test.hostUpdateCheck).toHaveBeenCalledOnce();
    expect(test.deepLinks.observed).toBe(true);
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('keeps broken lifetime adapters on the Observable error channel', () => {
    const failure = new Error('broken Trust lifetime adapter');
    const error = vi.fn();
    const test = setup(
      undefined,
      of({ kind: 'prepared' }),
      throwError(() => failure),
    );

    test.adapter.run(of(void 0)).subscribe({ error });

    expect(error).toHaveBeenCalledWith(failure);
  });

  it('forwards valid SSO and OIDC callbacks and ignores unrelated links', async () => {
    const test = setup();
    const lifetime = test.adapter.run(of(void 0)).subscribe();

    test.deepLinks.next({
      url: 'eu.qwky.trinity://sso-callback?loginToken=TOK&sso_state=NONCE',
    });
    test.deepLinks.next({
      url: 'eu.qwky.trinity:/sso-callback?code=CODE&state=STATE',
    });
    test.deepLinks.next({
      url: 'eu.qwky.trinity://elsewhere?loginToken=IGNORED',
    });

    await vi.waitFor(() => expect(test.navigate).toHaveBeenCalledTimes(2));
    expect(test.navigate).toHaveBeenNthCalledWith(1, ['/sso-callback'], {
      queryParams: { loginToken: 'TOK', sso_state: 'NONCE' },
    });
    expect(test.navigate).toHaveBeenNthCalledWith(2, ['/sso-callback'], {
      queryParams: { code: 'CODE', state: 'STATE' },
    });
    expect(test.closeAuthentication).toHaveBeenCalledTimes(2);
    lifetime.unsubscribe();
  });

  it('submits typed notification activation to semantic Workspace navigation', async () => {
    const test = setup();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const lifetime = test.adapter.run(of(void 0)).subscribe();

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
    lifetime.unsubscribe();
  });

  it('owns native push from synchronous startup activation through teardown and restart', async () => {
    let subscriptions = 0;
    let teardowns = 0;
    const pushSession = new Observable<NativePushActivation>((subscriber) => {
      subscriptions++;
      subscriber.next({
        accountId: '@background:example.org',
        roomId: '!room:example.org',
        eventId: '$event',
      });
      return () => teardowns++;
    });
    const test = setup(pushSession);
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
    const warnings: unknown[] = [];
    const lifetime = test.adapter
      .run(of(void 0))
      .subscribe((value) => warnings.push(value));

    test.notificationEvents.next({
      kind: 'activated',
      destination: {
        accountId: '@me:example.org',
        roomId: '!missing:example.org',
        eventId: '$event',
      },
    });

    await vi.waitFor(() =>
      expect(warnings).toContainEqual(
        expect.objectContaining({
          kind: 'warning',
          warning: expect.objectContaining({
            scope: 'workspace',
            diagnostic: { code: 'notification-navigation-rejected' },
          }),
        }),
      ),
    );
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('reports broken notification navigation without ending the session', async () => {
    const test = setup();
    test.workspaceNavigate.mockReturnValueOnce(
      new Observable((subscriber) => subscriber.error(new Error('broken'))),
    );
    const warnings: unknown[] = [];
    const lifetime = test.adapter
      .run(of(void 0))
      .subscribe((value) => warnings.push(value));

    test.notificationEvents.next({
      kind: 'activated',
      destination: {
        accountId: '@me:example.org',
        roomId: '!room:example.org',
        eventId: '$event',
      },
    });

    await vi.waitFor(() =>
      expect(warnings).toContainEqual(
        expect.objectContaining({
          kind: 'warning',
          warning: expect.objectContaining({
            scope: 'workspace',
            diagnostic: { code: 'notification-navigation-failed' },
          }),
        }),
      ),
    );
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('reports presentation failures without navigating or ending the session', () => {
    const test = setup();
    const warnings: unknown[] = [];
    const lifetime = test.adapter
      .run(of(void 0))
      .subscribe((value) => warnings.push(value));

    test.notificationEvents.next({
      kind: 'warning',
      diagnostic: { code: 'notification-presentation-failed' },
    });

    expect(warnings).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        warning: expect.objectContaining({
          scope: 'host',
          diagnostic: { code: 'notification-presentation-failed' },
        }),
      }),
    );
    expect(test.workspaceNavigate).not.toHaveBeenCalled();
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('keeps Back priority at dialog, Workspace surface, history, then background', () => {
    const test = setup();
    const lifetime = test.adapter.run(of(void 0)).subscribe();

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
    lifetime.unsubscribe();
  });

  it('offers an overlay owned by Workspace before the generic dialog stack', () => {
    const test = setup();
    test.dialogOpen.set(true);
    test.workspaceActive.set(true);
    test.workspaceOwnsOverlay.mockReturnValue(true);
    const lifetime = test.adapter.run(of(void 0)).subscribe();

    test.backIntents.next({ canGoBack: true });

    expect(test.workspaceBack).toHaveBeenCalledOnce();
    expect(test.closeTopmost).not.toHaveBeenCalled();
    expect(test.locationBack).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('owns native gesture policy only for the active session', () => {
    const test = setup();
    const lifetime = test.adapter.run(of(void 0)).subscribe();
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

  it('offers, activates and reloads a ready service-worker version', async () => {
    locationStub = stubLocation();
    const test = setup();
    const lifetime = test.adapter.run(of(void 0)).subscribe();
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
    lifetime.unsubscribe();
  });

  it('checks on foreground and stops update reactions after teardown', () => {
    locationStub = stubLocation();
    const test = setup();
    const lifetime = test.adapter.run(of(void 0)).subscribe();

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

  it('projects a rejected initial host update check as a runtime warning', () => {
    const test = setup();
    test.hostUpdateCheck.mockReturnValueOnce(
      of({
        kind: 'rejected',
        diagnostic: { code: 'host-update-failed' },
      }),
    );
    const warnings: unknown[] = [];
    const lifetime = test.adapter
      .run(of(void 0))
      .subscribe((warning) => warnings.push(warning));

    expect(warnings).toEqual([
      { kind: 'prepared' },
      expect.objectContaining({
        kind: 'warning',
        warning: expect.objectContaining({
          scope: 'updates',
          diagnostic: { code: 'update-check-failed' },
        }),
      }),
    ]);
    lifetime.unsubscribe();
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
