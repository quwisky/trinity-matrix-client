import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationError,
  Router,
  type Event as RouterEvent,
} from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { NavigationFocusService } from '../navigation-focus.service';
import { CapabilityHealthService } from '../capability-health.service';
import {
  AppearanceEffects,
  AppearancePreferences,
  type AppearanceHydrationOutcome,
} from '@trinity/application/appearance';
import { BadgeCoordinator } from '@trinity/application/badge';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  AccountRuntimeService,
  type AccountRestoreResult,
} from '@trinity/data-access/accounts';
import { GifSettingsService } from '@trinity/data-access/gif';
import {
  IdentityLifetime,
  type IdentityLifetimeEvent,
} from '@trinity/data-access/identity';
import {
  NotificationLifetime,
  NativePushLifetime,
  NotificationService,
  PushGatewayService,
  PushService,
} from '@trinity/data-access/notifications';
import { RoomAdministrationLifetime } from '@trinity/data-access/room-administration';
import {
  AccountScopeService,
  RoomLibraryLifetime,
  type RoomOrderRuntimeEvent,
  type RoomOrderHydrationOutcome,
  type RoomLibraryLifetimeEvent,
  SpaceRoomOrderService,
} from '@trinity/data-access/room-library';
import {
  TrustLifetime,
  type TrustLifetimeEvent,
} from '@trinity/data-access/trust';
import {
  ComposerSettingsService,
  AppConfigService,
  DateTimeFormatService,
  DraftStoreService,
  FeatureFlagsService,
  KeyboardShortcutsService,
  MessageGestureSettingsService,
  NativeNavigationService,
  PrivacySettingsService,
  ShellLayoutService,
  StoragePersistenceService,
  SystemLineSettingsService,
} from '@trinity/platform-native';
import {
  HOST_OPERATIONS,
  HostBackService,
  HostCapabilitiesService,
  HostDeepLinksService,
  HostUpdatesService,
  type HostCapabilityManifest,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import {
  EMPTY,
  NEVER,
  Observable,
  Subject,
  firstValueFrom,
  of,
  toArray,
} from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { TrinityApplicationRuntimeAdapter } from './trinity-application-runtime.adapter';
import { APPLICATION_STARTUP_PRODUCER_POLICIES } from '../application-startup.policy';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';

describe('TrinityApplicationRuntimeAdapter', () => {
  let events: Subject<RouterEvent>;
  let initialNavigation: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let restoreAccounts: Mock<() => Observable<AccountRestoreResult>>;
  let retryInactiveAccount: Mock<AccountRuntimeService['retryInactiveAccount']>;
  let hostManifest: Subject<HostCapabilityManifest>;
  let appearanceHydrate: Mock<() => Observable<AppearanceHydrationOutcome>>;
  let appearanceRecover: Mock<AppearancePreferences['recoverHydration']>;
  let badgeSession: Subject<HostOperationOutcome>;
  let appearanceSession: Subject<never>;
  let notificationSession: Subject<never>;
  let focusSession: Subject<void>;
  let routedSession: Subject<void>;
  let surfaceSession: Subject<void>;
  let orderSession: Subject<RoomOrderRuntimeEvent>;
  let roomLibrarySession: Subject<RoomLibraryLifetimeEvent>;
  let trustSession: Subject<TrustLifetimeEvent>;
  let identitySession: Subject<IdentityLifetimeEvent>;
  let deepLinks: Subject<{ readonly url: string }>;
  let backIntents: Subject<{ readonly canGoBack: boolean }>;
  let versionUpdates: Subject<never>;
  let unrecoverable: Subject<never>;
  let dialogOpen: ReturnType<typeof signal<boolean>>;
  let workspaceActive: ReturnType<typeof signal<boolean>>;
  let setHistoryGesturesEnabled: Mock<
    NativeNavigationService['setHistoryGesturesEnabled']
  >;
  let signOutAccount: Mock<AccountRuntimeService['signOutAccount']>;
  let resetInstallation: Mock<AccountRuntimeService['resetInstallation']>;
  let resetPreferences: Mock<AppConfigService['resetToDefaults']>;
  let retryResetPreferences: Mock<AppConfigService['retryResetToDefaults']>;
  let activeAccountId: ReturnType<typeof signal<string | null>>;
  let updateCheck: Mock<HostUpdatesService['check']>;
  let hydrateOrder: Mock<() => Observable<RoomOrderHydrationOutcome>>;
  let requestPersistence: Mock<StoragePersistenceService['requestPersistence']>;
  let health: CapabilityHealthService;
  let adapter: TrinityApplicationRuntimeAdapter;

  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    events = new Subject<RouterEvent>();
    initialNavigation = vi.fn();
    navigateByUrl = vi.fn().mockResolvedValue(true);
    restoreAccounts = vi.fn<() => Observable<AccountRestoreResult>>(() =>
      of({
        kind: 'no-accounts' as const,
        accounts: [],
        metrics: {
          durationMs: 0,
          activeTerminalMs: null,
          terminalAccounts: 0,
          totalAccounts: 0,
        },
      }),
    );
    retryInactiveAccount = vi.fn(() => of({ kind: 'unavailable' as const }));
    hostManifest = new Subject<HostCapabilityManifest>();
    appearanceHydrate = vi.fn<() => Observable<AppearanceHydrationOutcome>>(
      () => of({ kind: 'ready', hydrated: 6 }),
    );
    appearanceRecover = vi.fn<AppearancePreferences['recoverHydration']>(() =>
      of({ kind: 'ready', hydrated: 6 }),
    );
    badgeSession = new Subject<HostOperationOutcome>();
    appearanceSession = new Subject<never>();
    notificationSession = new Subject<never>();
    focusSession = new Subject<void>();
    routedSession = new Subject<void>();
    surfaceSession = new Subject<void>();
    orderSession = new Subject<RoomOrderRuntimeEvent>();
    roomLibrarySession = new Subject<RoomLibraryLifetimeEvent>();
    trustSession = new Subject<TrustLifetimeEvent>();
    identitySession = new Subject<IdentityLifetimeEvent>();
    deepLinks = new Subject<{ readonly url: string }>();
    backIntents = new Subject<{ readonly canGoBack: boolean }>();
    versionUpdates = new Subject<never>();
    unrecoverable = new Subject<never>();
    dialogOpen = signal(false);
    workspaceActive = signal(false);
    setHistoryGesturesEnabled =
      vi.fn<NativeNavigationService['setHistoryGesturesEnabled']>();
    signOutAccount = vi.fn<AccountRuntimeService['signOutAccount']>(() =>
      of({
        kind: 'ready' as const,
        accountId: '@active:example.org',
        activeAccountId: null,
        remainingAccountIds: [],
      }),
    );
    resetInstallation = vi.fn<AccountRuntimeService['resetInstallation']>(() =>
      of({ kind: 'ready' as const }),
    );
    resetPreferences = vi.fn<AppConfigService['resetToDefaults']>(() =>
      of({ kind: 'completed', attempt: 1, entries: [] }),
    );
    retryResetPreferences = vi.fn<AppConfigService['retryResetToDefaults']>(
      () => of({ kind: 'completed', attempt: 2, entries: [] }),
    );
    activeAccountId = signal<string | null>('@active:example.org');
    updateCheck = vi.fn<HostUpdatesService['check']>(() =>
      of({ kind: 'completed' as const }),
    );
    hydrateOrder = vi.fn<() => Observable<RoomOrderHydrationOutcome>>(() =>
      of({ kind: 'ready', accounts: [] }),
    );
    requestPersistence = vi.fn<StoragePersistenceService['requestPersistence']>(
      () => of(true),
    );
    const promiseInit = () => ({ init: vi.fn().mockResolvedValue(undefined) });
    TestBed.configureTestingModule({
      providers: [
        TrinityApplicationRuntimeAdapter,
        {
          provide: Router,
          useValue: {
            events,
            url: '/rooms',
            initialNavigation,
            navigateByUrl,
            navigate: vi.fn().mockResolvedValue(true),
          },
        },
        MockProvider(Location, { path: () => '/rooms', back: vi.fn() }),
        MockProvider(HostCapabilitiesService, { manifest: () => hostManifest }),
        MockProvider(AccountRuntimeService, {
          restoreSavedAccounts: restoreAccounts,
          retryInactiveAccount,
          activeAccountId,
          signOutAccount,
          resetInstallation,
        }),
        MockProvider(PushService, {
          run: () => EMPTY,
        }),
        MockProvider(NativePushLifetime, {
          run: () => EMPTY,
          recover: () => of({ kind: 'success' as const }),
        }),
        MockProvider(BadgeCoordinator, { run: () => badgeSession }),
        MockProvider(NotificationService, { run: () => notificationSession }),
        MockProvider(SwUpdate, {
          isEnabled: true,
          unrecoverable,
          versionUpdates,
          checkForUpdate: vi.fn().mockResolvedValue(false),
        }),
        MockProvider(TrnToastService),
        MockProvider(TrnDialogService, {
          openState: dialogOpen,
          hasOpen: () => false,
        }),
        MockProvider(WorkspaceBackService, {
          hasActive: workspaceActive,
          activeOwnsTopmostOverlay: () => false,
        }),
        MockProvider(WorkspaceNavigationService, {
          navigate: () => of({ kind: 'ready', change: 'committed' }),
        }),
        MockProvider(NativeNavigationService, { setHistoryGesturesEnabled }),
        MockProvider(HostDeepLinksService, { received: deepLinks }),
        MockProvider(HostBackService, { intents: backIntents }),
        MockProvider(HostUpdatesService, { check: updateCheck }),
        MockProvider(NavigationFocusService, { run: () => focusSession }),
        MockProvider(WorkspaceRoutedSurfaceAdapter, {
          roomProjectionDemand: signal(true).asReadonly(),
          run: () => routedSession,
        }),
        MockProvider(WorkspaceApplicationSurfacePresenterAdapter, {
          run: () => surfaceSession,
        }),
        MockProvider(AppearanceEffects, { run: () => appearanceSession }),
        MockProvider(AppearancePreferences, {
          hydrate: appearanceHydrate,
          recoverHydration: appearanceRecover,
        }),
        MockProvider(ShellLayoutService, promiseInit()),
        MockProvider(FeatureFlagsService, promiseInit()),
        MockProvider(PrivacySettingsService, {
          init: () => of({ kind: 'ready' as const, hydrated: 3 }),
          recoverHydration: () => of({ kind: 'ready' as const, hydrated: 1 }),
        }),
        MockProvider(DraftStoreService, promiseInit()),
        MockProvider(SystemLineSettingsService, promiseInit()),
        MockProvider(ComposerSettingsService, promiseInit()),
        MockProvider(MessageGestureSettingsService, promiseInit()),
        MockProvider(DateTimeFormatService, promiseInit()),
        MockProvider(KeyboardShortcutsService, promiseInit()),
        MockProvider(GifSettingsService, promiseInit()),
        MockProvider(AccountScopeService, {
          init: () => of({ kind: 'ready' as const, hydrated: 1 }),
          recoverHydration: () => of({ kind: 'ready' as const, hydrated: 1 }),
        }),
        MockProvider(AppConfigService, {
          resetToDefaults: resetPreferences,
          retryResetToDefaults: retryResetPreferences,
        }),
        MockProvider(PushGatewayService, promiseInit()),
        MockProvider(SpaceRoomOrderService, {
          hydrateKnownAccounts: hydrateOrder,
          knownAccountIds: () => ['@active:example.org'],
          retryHydration: () =>
            of({ accountId: '@active:example.org', kind: 'ready' as const }),
          run: () => orderSession,
        }),
        MockProvider(RoomLibraryLifetime, {
          run: () => roomLibrarySession,
        }),
        MockProvider(TrustLifetime, { run: () => trustSession }),
        MockProvider(IdentityLifetime, { run: () => identitySession }),
        MockProvider(NotificationLifetime, {
          run: () => of({ kind: 'prepared' as const }),
          recover: () => of({ kind: 'success' as const }),
        }),
        MockProvider(RoomAdministrationLifetime, { run: () => of(void 0) }),
        MockProvider(StoragePersistenceService, {
          requestPersistence,
        }),
      ],
    });
    adapter = TestBed.inject(TrinityApplicationRuntimeAdapter);
    health = TestBed.inject(CapabilityHealthService);
  });

  it('keeps preference hydration cold', async () => {
    const hydration = adapter.hydratePreferences();
    expect(appearanceHydrate).not.toHaveBeenCalled();

    await firstValueFrom(hydration);

    expect(appearanceHydrate).toHaveBeenCalledOnce();
  });

  it('keeps declared preference defaults when one initializer rejects', async () => {
    appearanceHydrate.mockReturnValueOnce(
      new Observable((subscriber) =>
        subscriber.error(new Error('preferences unavailable')),
      ),
    );
    await expect(firstValueFrom(adapter.hydratePreferences())).resolves.toEqual(
      {
        kind: 'ready',
        settlements: [
          {
            producer: 'preference-hydration',
            stage: 'preference-hydration',
            status: 'degraded',
            diagnostic: { code: 'preference-hydration-degraded' },
          },
        ],
      },
    );
    expect(health.problems()[0]).toMatchObject({
      capability: 'preferences',
      operation: 'hydrate-appearance',
      code: 'appearance-hydration-failed',
    });

    await expect(
      firstValueFrom(adapter.establishSessionCapabilities()),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it('publishes scoped health and exact recovery for partial Appearance hydration', async () => {
    const failures = [
      {
        preferenceId: 'design-system.theme',
        recovery: 'reset-preference' as const,
        diagnostic: { code: 'preference-migration-rejected' as const },
      },
    ];
    appearanceHydrate.mockReturnValueOnce(
      of({
        kind: 'partial',
        hydrated: 5,
        failures,
        warning: {
          code: 'appearance-preference-hydration-partial',
          recovery: 'reset-preferences',
        },
      }),
    );

    await expect(firstValueFrom(adapter.hydratePreferences())).resolves.toEqual(
      {
        kind: 'ready',
        settlements: [
          {
            producer: 'preference-hydration',
            stage: 'preference-hydration',
            status: 'degraded',
            diagnostic: { code: 'preference-hydration-degraded' },
          },
        ],
      },
    );
    const problem = health.problems()[0]!;
    expect(problem).toMatchObject({
      capability: 'preferences',
      operation: 'hydrate-appearance',
      code: 'appearance-preference-hydration-partial',
    });
    await expect(
      firstValueFrom(health.recover(problem).pipe(toArray())),
    ).resolves.toEqual([{ kind: 'pending' }, { kind: 'success' }]);
    expect(appearanceRecover).toHaveBeenCalledWith(failures);
  });

  it('keeps a rejected badge probe as scoped optional health', async () => {
    const operations = Object.fromEntries(
      HOST_OPERATIONS.map((operation) => [
        operation,
        operation === 'badge'
          ? {
              kind: 'unavailable',
              reason: 'host-rejected',
              diagnostic: { code: 'badge-probe-timeout' },
            }
          : { kind: 'supported' },
      ]),
    ) as HostCapabilityManifest['operations'];
    const negotiation = firstValueFrom(adapter.negotiateHost());

    hostManifest.next({ protocolVersion: 1, operations });
    hostManifest.complete();

    await expect(negotiation).resolves.toEqual({ kind: 'ready' });
    await expect(
      firstValueFrom(adapter.establishSessionCapabilities()),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(health.problems()).toEqual([
      expect.objectContaining({
        capability: 'badge',
        operation: 'support',
        code: 'badge-support-unavailable',
      }),
    ]);
  });

  it('accepts unsupported optional host operations', async () => {
    const operations = Object.fromEntries(
      HOST_OPERATIONS.map((operation) => [
        operation,
        { kind: 'unavailable', reason: 'not-supported' },
      ]),
    ) as HostCapabilityManifest['operations'];
    const negotiation = firstValueFrom(adapter.negotiateHost());
    hostManifest.next({ protocolVersion: 1, operations });
    hostManifest.complete();
    await expect(negotiation).resolves.toEqual({ kind: 'ready' });
  });

  it('blocks when the required host contract cannot be established', async () => {
    const negotiation = firstValueFrom(adapter.negotiateHost());
    hostManifest.error(new Error('bridge unavailable'));

    await expect(negotiation).resolves.toEqual({
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'host-negotiation-failed' },
    });
  });

  it('settles ordering health and persistence independently', async () => {
    hydrateOrder.mockReturnValueOnce(
      of({
        kind: 'partial',
        accounts: [
          {
            accountId: '@active:example.org',
            kind: 'defaulted',
            diagnostic: { code: 'room-order-storage-unavailable' },
          },
        ],
      }),
    );
    requestPersistence.mockReturnValueOnce(of(false));

    await expect(
      firstValueFrom(adapter.establishSessionCapabilities()),
    ).resolves.toMatchObject({
      kind: 'ready',
      warnings: [
        expect.objectContaining({
          scope: 'storage',
          diagnostic: { code: 'storage-persistence-denied' },
        }),
      ],
      settlements: [
        expect.objectContaining({
          producer: 'room-order',
          status: 'degraded',
          diagnostic: { code: 'room-order-hydration-degraded' },
        }),
        expect.objectContaining({
          producer: 'browser-storage-persistence',
          status: 'degraded',
          diagnostic: { code: 'storage-persistence-denied' },
        }),
      ],
    });
    expect(hydrateOrder).toHaveBeenCalledOnce();
    expect(requestPersistence).toHaveBeenCalledOnce();
    expect(
      health
        .problems()
        .find((problem) => problem.capability === 'room-library'),
    ).toMatchObject({
      operation: 'hydrate-order',
      code: 'room-order-storage-unavailable',
    });
  });

  it('bounds unresponsive optional startup siblings with exact identities', async () => {
    vi.useFakeTimers();
    hydrateOrder.mockReturnValueOnce(NEVER);
    requestPersistence.mockReturnValueOnce(NEVER);
    const outcome = firstValueFrom(adapter.establishSessionCapabilities());

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES['room-order'].budgetMs,
    );

    await expect(outcome).resolves.toMatchObject({
      kind: 'ready',
      warnings: [
        expect.objectContaining({
          diagnostic: { code: 'storage-persistence-timeout' },
        }),
      ],
      settlements: [
        expect.objectContaining({
          producer: 'room-order',
          status: 'degraded',
          diagnostic: { code: 'room-order-hydration-degraded' },
        }),
        expect.objectContaining({
          producer: 'browser-storage-persistence',
          status: 'degraded',
          diagnostic: { code: 'storage-persistence-timeout' },
        }),
      ],
    });
  });

  it('keeps the initial update check out of pre-readiness capabilities', async () => {
    updateCheck.mockReturnValueOnce(
      of({
        kind: 'rejected',
        diagnostic: { code: 'host-update-failed' },
      }),
    );
    const establishment = adapter.establishSessionCapabilities();

    expect(updateCheck).not.toHaveBeenCalled();
    await expect(firstValueFrom(establishment)).resolves.toMatchObject({
      kind: 'ready',
    });
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it('maps partial and required Account outcomes without leaking account ids', async () => {
    restoreAccounts.mockReturnValueOnce(
      of({
        kind: 'restored-with-inactive-failures',
        activeAccountId: '@active:example.org',
        accounts: [
          {
            kind: 'ready',
            accountId: '@active:example.org',
            role: 'active',
            durationMs: 1,
          },
          {
            kind: 'failed',
            failure: 'transient-network',
            accountId: '@private:example.org',
            role: 'inactive',
            durationMs: 1,
          },
        ],
        metrics: {
          durationMs: 1,
          activeTerminalMs: 1,
          terminalAccounts: 2,
          totalAccounts: 2,
        },
      }),
    );
    await expect(firstValueFrom(adapter.restoreAccounts())).resolves.toEqual({
      kind: 'ready',
    });
    const problem = health.problems()[0]!;
    expect(problem).toMatchObject({
      capability: 'accounts',
      operation: 'restore',
      code: 'account-restore-transient-network',
    });
    expect(
      JSON.stringify(health.diagnostics('startup', 1, '0.1.0', 'web')),
    ).not.toContain('@private:example.org');

    retryInactiveAccount.mockReturnValueOnce(
      of({
        kind: 'ready',
        accountId: '@private:example.org',
        role: 'inactive',
        durationMs: 2,
      }),
    );
    await expect(
      firstValueFrom(health.recover(problem).pipe(toArray())),
    ).resolves.toEqual([{ kind: 'pending' }, { kind: 'success' }]);
    expect(retryInactiveAccount).toHaveBeenCalledWith('@private:example.org');

    restoreAccounts.mockReturnValueOnce(
      of({
        kind: 'active-account-unavailable',
        activeAccountId: '@secret:example.org',
        accounts: [],
        metrics: {
          durationMs: 1,
          activeTerminalMs: 1,
          terminalAccounts: 1,
          totalAccounts: 1,
        },
      }),
    );
    const blocked = await firstValueFrom(adapter.restoreAccounts());
    expect(blocked).toEqual({
      kind: 'blocked',
      recovery: 'reauthenticate',
      diagnostic: { code: 'active-account-unavailable' },
    });
    expect(JSON.stringify(blocked)).not.toContain('@secret:example.org');

    activeAccountId.set(null);
    await firstValueFrom(adapter.recover('reauthenticate'));
    expect(signOutAccount).toHaveBeenCalledWith('@secret:example.org');
  });

  it('falls back to a safe root before blocking Workspace restoration', async () => {
    initialNavigation.mockImplementationOnce(() => {
      events.next(new NavigationError(1, '/rooms', new Error('offline')));
    });
    await expect(firstValueFrom(adapter.restoreWorkspace())).resolves.toEqual({
      kind: 'ready',
      warnings: [
        expect.objectContaining({
          scope: 'workspace',
          diagnostic: { code: 'workspace-safe-root-fallback' },
        }),
      ],
    });
    expect(navigateByUrl).toHaveBeenNthCalledWith(1, '/', {
      replaceUrl: true,
    });

    await expect(firstValueFrom(adapter.restoreWorkspace())).resolves.toEqual({
      kind: 'ready',
    });

    navigateByUrl
      .mockRejectedValueOnce(new Error('router rejected'))
      .mockResolvedValueOnce(false);
    await expect(firstValueFrom(adapter.restoreWorkspace())).resolves.toEqual({
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'workspace-navigation-failed' },
    });

    expect(initialNavigation).toHaveBeenCalledOnce();
    expect(navigateByUrl).toHaveBeenCalledTimes(4);
    expect(navigateByUrl).toHaveBeenNthCalledWith(2, '/rooms', {
      replaceUrl: true,
    });
    expect(navigateByUrl).toHaveBeenNthCalledWith(3, '/rooms', {
      replaceUrl: true,
    });
    expect(navigateByUrl).toHaveBeenNthCalledWith(4, '/', {
      replaceUrl: true,
    });
  });

  it('bounds an unresponsive saved destination before trying the safe root', async () => {
    vi.useFakeTimers();
    const restoration = firstValueFrom(adapter.restoreWorkspace());

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES.workspace.attemptBudgetMs,
    );

    await expect(restoration).resolves.toEqual({
      kind: 'ready',
      warnings: [
        expect.objectContaining({
          diagnostic: { code: 'workspace-safe-root-fallback' },
        }),
      ],
    });
    expect(navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
  });

  it('executes typed recovery commands before startup is retried', async () => {
    await expect(
      firstValueFrom(adapter.recover('reauthenticate')),
    ).resolves.toEqual({ kind: 'ready' });
    expect(signOutAccount).toHaveBeenCalledWith('@active:example.org');

    await expect(
      firstValueFrom(adapter.recover('reset-preferences')),
    ).resolves.toEqual({ kind: 'ready' });
    expect(resetPreferences).toHaveBeenCalledOnce();

    await expect(
      firstValueFrom(adapter.recover('reset-installation')),
    ).resolves.toEqual({ kind: 'ready' });
    expect(resetInstallation).toHaveBeenCalledOnce();
  });

  it('retries only the outstanding entries from a partial preference reset', async () => {
    resetPreferences.mockReturnValueOnce(
      of({
        kind: 'partial',
        attempt: 41,
        entries: [
          { entry: 'appearance.theme', status: 'completed' },
          {
            entry: 'privacy.readReceipts',
            status: 'failed',
            diagnostic: { code: 'config-reset-entry-failed' },
          },
        ],
      }),
    );

    await expect(
      firstValueFrom(adapter.recover('reset-preferences')),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'recovery-failed' });
    await expect(
      firstValueFrom(adapter.recover('reset-preferences')),
    ).resolves.toEqual({ kind: 'ready' });

    expect(resetPreferences).toHaveBeenCalledOnce();
    expect(retryResetPreferences).toHaveBeenCalledWith(41);
  });

  it('owns every concrete session stream across teardown and restart', () => {
    const events: unknown[] = [];
    const readiness = new Subject<void>();
    const first = adapter
      .runSession(readiness)
      .subscribe((value) => events.push(value));
    TestBed.tick();

    expect(roomLibrarySession.observed).toBe(true);
    expect(trustSession.observed).toBe(true);
    expect(identitySession.observed).toBe(true);
    expect([
      badgeSession.observed,
      notificationSession.observed,
      focusSession.observed,
      routedSession.observed,
      surfaceSession.observed,
      orderSession.observed,
      deepLinks.observed,
      backIntents.observed,
      versionUpdates.observed,
      unrecoverable.observed,
    ]).toEqual(Array(10).fill(false));
    roomLibrarySession.next({ kind: 'prepared' });
    trustSession.next({ kind: 'prepared' });
    identitySession.next({ kind: 'prepared' });
    expect(events).toEqual([{ kind: 'prepared' }]);
    readiness.next();
    readiness.complete();
    TestBed.tick();
    expect([
      badgeSession.observed,
      notificationSession.observed,
      focusSession.observed,
      routedSession.observed,
      surfaceSession.observed,
      orderSession.observed,
      deepLinks.observed,
      backIntents.observed,
      versionUpdates.observed,
      unrecoverable.observed,
    ]).toEqual(Array(10).fill(true));
    expect(setHistoryGesturesEnabled).toHaveBeenCalled();

    badgeSession.next({
      kind: 'rejected',
      diagnostic: { code: 'badge-write-rejected' },
    });
    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(health.incidents()).toEqual([
      expect.objectContaining({
        capability: 'badge',
        operation: 'write',
        code: 'badge-write-failed',
      }),
    ]);

    first.unsubscribe();
    expect(roomLibrarySession.observed).toBe(false);
    expect(trustSession.observed).toBe(false);
    expect(identitySession.observed).toBe(false);
    expect([
      badgeSession.observed,
      notificationSession.observed,
      focusSession.observed,
      routedSession.observed,
      surfaceSession.observed,
      orderSession.observed,
      deepLinks.observed,
      backIntents.observed,
      versionUpdates.observed,
      unrecoverable.observed,
    ]).toEqual(Array(10).fill(false));
    const gestureCalls = setHistoryGesturesEnabled.mock.calls.length;
    dialogOpen.set(true);
    TestBed.tick();
    expect(setHistoryGesturesEnabled).toHaveBeenCalledTimes(gestureCalls);

    const secondReadiness = new Subject<void>();
    const second = adapter.runSession(secondReadiness).subscribe();
    roomLibrarySession.next({ kind: 'prepared' });
    trustSession.next({ kind: 'prepared' });
    identitySession.next({ kind: 'prepared' });
    secondReadiness.next();
    TestBed.tick();
    expect(badgeSession.observed).toBe(true);
    expect(notificationSession.observed).toBe(true);
    expect(orderSession.observed).toBe(true);
    second.unsubscribe();
    expect(badgeSession.observed).toBe(false);
    expect(notificationSession.observed).toBe(false);
    expect(orderSession.observed).toBe(false);
  });

  it('owns Appearance effects in the post-hydration preference lifetime', () => {
    const first = adapter.runPreferenceLifetime().subscribe();
    expect(appearanceSession.observed).toBe(true);

    first.unsubscribe();
    expect(appearanceSession.observed).toBe(false);

    const second = adapter.runPreferenceLifetime().subscribe();
    expect(appearanceSession.observed).toBe(true);
    second.unsubscribe();
    expect(appearanceSession.observed).toBe(false);
  });
});
