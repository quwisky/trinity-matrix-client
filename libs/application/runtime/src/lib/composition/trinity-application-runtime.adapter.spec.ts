import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationEnd,
  NavigationError,
  Router,
  type Event as RouterEvent,
} from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { NavigationFocusService } from '../navigation-focus.service';
import { BadgeCoordinator } from '@trinity/application/badge';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  AccountRuntimeService,
  type AccountRestoreResult,
} from '@trinity/data-access/accounts';
import { GifSettingsService } from '@trinity/data-access/gif';
import {
  NotificationService,
  PushGatewayService,
  PushService,
} from '@trinity/data-access/notifications';
import {
  AccountScopeService,
  SpaceRoomOrderService,
} from '@trinity/data-access/room-library';
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
  ThemeService,
} from '@trinity/platform-native';
import {
  HostBackService,
  HostCapabilitiesService,
  HostDeepLinksService,
  HostUpdatesService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { EMPTY, Observable, Subject, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TrinityApplicationRuntimeAdapter } from './trinity-application-runtime.adapter';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';

describe('TrinityApplicationRuntimeAdapter', () => {
  let events: Subject<RouterEvent>;
  let initialNavigation: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let restoreAccounts: Mock<() => Observable<AccountRestoreResult>>;
  let themeInit: Mock<() => Promise<void>>;
  let badgeSession: Subject<HostOperationOutcome>;
  let notificationSession: Subject<never>;
  let focusSession: Subject<void>;
  let routedSession: Subject<void>;
  let surfaceSession: Subject<void>;
  let orderSession: Subject<void>;
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
  let activeAccountId: ReturnType<typeof signal<string | null>>;
  let updateCheck: Mock<HostUpdatesService['check']>;
  let adapter: TrinityApplicationRuntimeAdapter;

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
    themeInit = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    badgeSession = new Subject<HostOperationOutcome>();
    notificationSession = new Subject<never>();
    focusSession = new Subject<void>();
    routedSession = new Subject<void>();
    surfaceSession = new Subject<void>();
    orderSession = new Subject<void>();
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
      of(void 0),
    );
    activeAccountId = signal<string | null>('@active:example.org');
    updateCheck = vi.fn<HostUpdatesService['check']>(() =>
      of({ kind: 'completed' as const }),
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
        MockProvider(HostCapabilitiesService, { manifest: () => EMPTY }),
        MockProvider(AccountRuntimeService, {
          restoreSavedAccounts: restoreAccounts,
          activeAccountId,
          signOutAccount,
          resetInstallation,
        }),
        MockProvider(PushService, {
          run: () => EMPTY,
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
        MockProvider(NativeNavigationService, { setHistoryGesturesEnabled }),
        MockProvider(HostDeepLinksService, { received: deepLinks }),
        MockProvider(HostBackService, { intents: backIntents }),
        MockProvider(HostUpdatesService, { check: updateCheck }),
        MockProvider(NavigationFocusService, { run: () => focusSession }),
        MockProvider(WorkspaceRoutedSurfaceAdapter, {
          run: () => routedSession,
        }),
        MockProvider(WorkspaceApplicationSurfacePresenterAdapter, {
          run: () => surfaceSession,
        }),
        MockProvider(ThemeService, { init: themeInit }),
        MockProvider(ShellLayoutService, promiseInit()),
        MockProvider(FeatureFlagsService, promiseInit()),
        MockProvider(PrivacySettingsService, {
          init: () => of({ kind: 'ready' as const, hydrated: 3 }),
        }),
        MockProvider(DraftStoreService, promiseInit()),
        MockProvider(SystemLineSettingsService, promiseInit()),
        MockProvider(ComposerSettingsService, promiseInit()),
        MockProvider(MessageGestureSettingsService, promiseInit()),
        MockProvider(DateTimeFormatService, promiseInit()),
        MockProvider(KeyboardShortcutsService, promiseInit()),
        MockProvider(GifSettingsService, promiseInit()),
        MockProvider(AccountScopeService, { init: () => of(void 0) }),
        MockProvider(AppConfigService, { resetToDefaults: resetPreferences }),
        MockProvider(PushGatewayService, promiseInit()),
        MockProvider(SpaceRoomOrderService, {
          hydrateKnownAccounts: () => of(void 0),
          run: () => orderSession,
        }),
        MockProvider(StoragePersistenceService, {
          requestPersistence: vi.fn(() => of(true)),
        }),
      ],
    });
    adapter = TestBed.inject(TrinityApplicationRuntimeAdapter);
  });

  it('keeps preference hydration cold', async () => {
    const hydration = adapter.hydratePreferences();
    expect(themeInit).not.toHaveBeenCalled();

    await firstValueFrom(hydration);

    expect(themeInit).toHaveBeenCalledOnce();
  });

  it('maps required preference failure and keeps optional session capabilities non-blocking', async () => {
    themeInit.mockRejectedValueOnce(new Error('preferences unavailable'));
    await expect(firstValueFrom(adapter.hydratePreferences())).resolves.toEqual(
      {
        kind: 'blocked',
        recovery: 'reset-preferences',
        diagnostic: { code: 'preference-hydration-failed' },
      },
    );

    await expect(
      firstValueFrom(adapter.establishSessionCapabilities()),
    ).resolves.toEqual({ kind: 'ready' });
    expect(updateCheck).toHaveBeenCalledOnce();
  });

  it('routes the cold initial update check through the shared host contract', async () => {
    updateCheck.mockReturnValueOnce(
      of({
        kind: 'rejected',
        diagnostic: { code: 'host-update-failed' },
      }),
    );
    const establishment = adapter.establishSessionCapabilities();

    expect(updateCheck).not.toHaveBeenCalled();
    await expect(firstValueFrom(establishment)).resolves.toEqual({
      kind: 'ready',
      warnings: [
        expect.objectContaining({
          scope: 'updates',
          diagnostic: { code: 'update-check-failed' },
        }),
      ],
    });
    expect(updateCheck).toHaveBeenCalledOnce();
  });

  it('maps partial and required Account outcomes without leaking account ids', async () => {
    restoreAccounts.mockReturnValueOnce(
      of({
        kind: 'restored-with-inactive-failures',
        activeAccountId: '@active:example.org',
        accounts: [],
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
      warnings: [
        expect.objectContaining({
          scope: 'accounts',
          diagnostic: { code: 'inactive-account-restore-failed' },
        }),
      ],
    });

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

  it('subscribes before initial navigation and retries Workspace restoration explicitly', async () => {
    initialNavigation.mockImplementationOnce(() => {
      events.next(new NavigationError(1, '/rooms', new Error('offline')));
    });
    await expect(firstValueFrom(adapter.restoreWorkspace())).resolves.toEqual({
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'workspace-navigation-failed' },
    });

    navigateByUrl.mockImplementationOnce(() => {
      events.next(new NavigationEnd(2, '/rooms', '/rooms'));
      return Promise.resolve(true);
    });
    await expect(firstValueFrom(adapter.restoreWorkspace())).resolves.toEqual({
      kind: 'ready',
    });

    navigateByUrl.mockRejectedValueOnce(new Error('router rejected'));
    await expect(firstValueFrom(adapter.restoreWorkspace())).resolves.toEqual({
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'workspace-navigation-failed' },
    });

    expect(initialNavigation).toHaveBeenCalledOnce();
    expect(navigateByUrl).toHaveBeenCalledTimes(2);
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
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

  it('owns every concrete session stream across teardown and restart', () => {
    const warnings: unknown[] = [];
    const first = adapter
      .runSession()
      .subscribe((value) => warnings.push(value));
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
    expect(warnings).toEqual([
      expect.objectContaining({
        stage: 'session',
        scope: 'badge',
        diagnostic: { code: 'badge-update-failed' },
      }),
    ]);

    first.unsubscribe();
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

    const second = adapter.runSession().subscribe();
    TestBed.tick();
    expect(badgeSession.observed).toBe(true);
    expect(notificationSession.observed).toBe(true);
    expect(orderSession.observed).toBe(true);
    second.unsubscribe();
    expect(badgeSession.observed).toBe(false);
    expect(notificationSession.observed).toBe(false);
    expect(orderSession.observed).toBe(false);
  });
});
