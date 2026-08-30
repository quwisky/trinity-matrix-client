import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  SwUpdate,
  type UnrecoverableStateEvent,
  type VersionEvent,
} from '@angular/service-worker';
import { NavigationFocusService } from '@trinity/application/runtime';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import { AppBadgeService } from '@trinity/data-access/notifications';
import { SpaceRoomOrderService } from '@trinity/data-access/rooms';
import { NativeNavigationService } from '@trinity/platform-native';
import { HostBackService, HostDeepLinksService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { EMPTY, Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';
import { TrinityApplicationSessionAdapter } from './trinity-application-session.adapter';

interface SessionHarness {
  readonly adapter: TrinityApplicationSessionAdapter;
  readonly deepLinks: Subject<{ readonly url: string }>;
  readonly backIntents: Subject<{ readonly canGoBack: boolean }>;
  readonly navigate: ReturnType<typeof vi.fn>;
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
  readonly activateUpdate: ReturnType<typeof vi.fn>;
  readonly showToast: ReturnType<typeof vi.fn>;
}

function setup(): SessionHarness {
  const deepLinks = new Subject<{ readonly url: string }>();
  const backIntents = new Subject<{ readonly canGoBack: boolean }>();
  const navigate = vi.fn().mockResolvedValue(true);
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
  const activateUpdate = vi.fn().mockResolvedValue(true);
  const showToast = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      TrinityApplicationSessionAdapter,
      MockProvider(Router, { navigate }),
      MockProvider(Location, { back: locationBack }),
      MockProvider(AppBadgeService, { run: () => EMPTY }),
      MockProvider(NavigationFocusService, { run: () => EMPTY }),
      MockProvider(WorkspaceRoutedSurfaceAdapter, { run: () => EMPTY }),
      MockProvider(WorkspaceApplicationSurfacePresenterAdapter, {
        run: () => EMPTY,
      }),
      MockProvider(SpaceRoomOrderService, { run: () => EMPTY }),
      MockProvider(HostDeepLinksService, {
        received: deepLinks,
        closeAuthentication,
      }),
      MockProvider(HostBackService, { intents: backIntents, background }),
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
    navigate,
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

  it('forwards valid SSO and OIDC callbacks and ignores unrelated links', async () => {
    const test = setup();
    const lifetime = test.adapter.run().subscribe();

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

  it('keeps Back priority at dialog, Workspace surface, history, then background', () => {
    const test = setup();
    const lifetime = test.adapter.run().subscribe();

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
    const lifetime = test.adapter.run().subscribe();

    test.backIntents.next({ canGoBack: true });

    expect(test.workspaceBack).toHaveBeenCalledOnce();
    expect(test.closeTopmost).not.toHaveBeenCalled();
    expect(test.locationBack).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('owns native gesture policy only for the active session', () => {
    const test = setup();
    const lifetime = test.adapter.run().subscribe();
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
    const lifetime = test.adapter.run().subscribe();
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
    const lifetime = test.adapter.run().subscribe();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(test.checkForUpdate).toHaveBeenCalledOnce();

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
    document.dispatchEvent(new Event('visibilitychange'));

    expect(test.showToast).not.toHaveBeenCalled();
    expect(test.checkForUpdate).toHaveBeenCalledOnce();
    expect(locationStub.calls).not.toContain('reload');
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
