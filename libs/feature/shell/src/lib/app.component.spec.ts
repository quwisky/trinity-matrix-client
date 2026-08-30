import { inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  SwUpdate,
  provideServiceWorker,
  type UnrecoverableStateEvent,
  type VersionEvent,
} from '@angular/service-worker';
import { App } from '@capacitor/app';
import { VerificationService } from '@trinity/data-access/crypto';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  WorkspaceBackService,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import { render } from '@trinity/testing';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { AppComponent } from './app.component';

vi.mock('@capacitor/browser', () => ({
  Browser: { close: vi.fn().mockResolvedValue(undefined), open: vi.fn() },
}));

// Captures the 'backButton' listener so tests can invoke it directly, and stubs
// the other App calls the native-only branch of ngOnInit makes. `vi.mock` factories
// are hoisted above other module code, so the array has to be created via
// `vi.hoisted` for the factory below to see it.
const { backButtonListeners, nativeGestureCalls } = vi.hoisted(() => ({
  backButtonListeners: [] as Array<(state: { canGoBack: boolean }) => void>,
  nativeGestureCalls: [] as boolean[],
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, cb: (state: unknown) => void) => {
      if (event === 'backButton') {
        backButtonListeners.push(cb as (state: { canGoBack: boolean }) => void);
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
    minimizeApp: vi.fn().mockResolvedValue(undefined),
    getLaunchUrl: vi.fn().mockResolvedValue(null),
  },
}));

// Native-only branch gate: forced true so the backButton listener registers.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'ios',
    isNativePlatform: () => true,
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({
    setGesturesEnabled: ({ enabled }: { enabled: boolean }) => {
      nativeGestureCalls.push(enabled);
      return Promise.resolve();
    },
  }),
}));

// AppComponent's template mounts <trn-verification-host>, which injects these.
// MockProvider auto-spies the services; the signal-backed members are the only
// state the host reads, so they're supplied as real signals via the overrides.
// (The host also injects TrnDialogService, but that's providedIn root and never
// opens a dialog here — active() stays null — so the real one is fine unprovided.)
const hostProviders = [
  MockProvider(MatrixClientService, { syncState: signal(null) }),
  MockProvider(VerificationService, { active: signal(null) }),
];

const roomSurface = {
  layer: 'room',
  surface: { kind: 'threads' },
} as const satisfies WorkspaceSurface;
const applicationSurface = {
  layer: 'application',
  surface: { kind: 'settings', section: null },
} as const satisfies WorkspaceSurface;

describe('AppComponent', () => {
  it('should create the app', async () => {
    const { fixture } = await render(AppComponent, {
      providers: [
        provideRouter([]),
        provideServiceWorker('ngsw-worker.js', { enabled: false }),
        ...hostProviders,
      ],
    });

    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('handleDeepLink', () => {
    async function create() {
      // provideRouter powers <router-outlet>; hostProviders for trn-verification-host
      const { fixture } = await render(AppComponent, {
        providers: [
          provideRouter([]),
          provideServiceWorker('ngsw-worker.js', { enabled: false }),
          ...hostProviders,
        ],
      });
      const cmp = fixture.componentInstance;
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigate')
        .mockResolvedValue(true);
      return { cmp, navigate };
    }

    it('routes an sso-callback deep link to the callback page with token + state', async () => {
      const { cmp, navigate } = await create();

      cmp.handleDeepLink(
        'eu.qwky.trinity://sso-callback?loginToken=TOK&sso_state=NONCE',
      );

      expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
        queryParams: { loginToken: 'TOK', sso_state: 'NONCE' },
      });
    });

    it('routes an OIDC callback deep link with code + state', async () => {
      const { cmp, navigate } = await create();

      cmp.handleDeepLink(
        'eu.qwky.trinity://sso-callback?code=CODE&state=STATE1',
      );

      // Only the OIDC params are forwarded (no loginToken/sso_state), so the callback
      // page takes its OIDC branch.
      expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
        queryParams: { code: 'CODE', state: 'STATE1' },
      });
    });

    // RFC 8252 §7.1 shape: no authority, so the callback lands in the path, not the
    // host. This is what the OIDC provider actually redirects back to.
    it('routes an OIDC callback deep link with no authority (single slash)', async () => {
      const { cmp, navigate } = await create();

      cmp.handleDeepLink(
        'eu.qwky.trinity:/sso-callback?code=CODE&state=STATE1',
      );

      expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
        queryParams: { code: 'CODE', state: 'STATE1' },
      });
    });

    it('forwards an OIDC error param so the callback can surface it', async () => {
      const { cmp, navigate } = await create();

      cmp.handleDeepLink(
        'eu.qwky.trinity://sso-callback?error=access_denied&error_description=nope',
      );

      expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
        queryParams: { error: 'access_denied', error_description: 'nope' },
      });
    });

    it('ignores a deep link without a login token, code or error', async () => {
      const { cmp, navigate } = await create();
      cmp.handleDeepLink('eu.qwky.trinity://sso-callback');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('ignores an unrelated deep link', async () => {
      const { cmp, navigate } = await create();
      cmp.handleDeepLink('eu.qwky.trinity://elsewhere?loginToken=TOK');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('ignores a malformed URL', async () => {
      const { cmp, navigate } = await create();
      cmp.handleDeepLink('not a url');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('registers the Electron deep-link bridge and routes its URLs', async () => {
      let captured: ((url: string) => void) | undefined;
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
        isElectron: true,
        onDeepLink: (cb: (url: string) => void) => {
          captured = cb;
          return () => undefined;
        },
      };
      try {
        const { cmp, navigate } = await create();
        cmp.ngOnInit();

        expect(captured).toBeTypeOf('function');
        captured?.('eu.qwky.trinity://sso-callback?loginToken=TOK&sso_state=S');

        expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
          queryParams: { loginToken: 'TOK', sso_state: 'S' },
        });
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });
  });

  describe('iOS history gesture coordination', () => {
    async function create() {
      nativeGestureCalls.length = 0;
      const openState = signal(false);
      await render(AppComponent, {
        providers: [
          provideRouter([]),
          provideServiceWorker('ngsw-worker.js', { enabled: false }),
          ...hostProviders,
          MockProvider(TrnDialogService, {
            openState,
            hasOpen: () => openState(),
            closeTopmost: () => false,
          }),
        ],
      });
      TestBed.tick();
      return { openState, back: TestBed.inject(WorkspaceBackService) };
    }

    it('enables native history swipes when no surface can intercept Back', async () => {
      await create();

      expect(nativeGestureCalls.at(-1)).toBe(true);
    });

    it('disables native history swipes for an overlay and restores them after close', async () => {
      const { openState } = await create();
      nativeGestureCalls.length = 0;

      openState.set(true);
      TestBed.tick();
      expect(nativeGestureCalls).toEqual([false]);

      openState.set(false);
      TestBed.tick();
      expect(nativeGestureCalls).toEqual([false, true]);
    });

    it('keeps native gestures disabled until both dialog and panel are closed', async () => {
      const { openState, back } = await create();
      const panelOpen = signal(false);
      back.register({
        surface: () => (panelOpen() ? roomSurface : null),
        dismiss: () => of('dismissed'),
      });
      nativeGestureCalls.length = 0;

      panelOpen.set(true);
      TestBed.tick();
      expect(nativeGestureCalls).toEqual([false]);

      openState.set(true);
      panelOpen.set(false);
      TestBed.tick();
      expect(nativeGestureCalls).toEqual([false]);

      openState.set(false);
      TestBed.tick();
      expect(nativeGestureCalls).toEqual([false, true]);
    });
  });

  // Android hardware back button (native only, see ngOnInit): dismiss the topmost
  // overlay if one owns the screen, else step back through router history if
  // possible, else minimize the app. Exercised through the actual listener
  // registered with the (mocked) Capacitor App plugin, not a refactored helper.
  //
  // Which end of the overlay stack gets closed is TrnDialogService's business and is
  // asserted against the real CDK stack in trn-dialog.service.spec.ts. What belongs
  // here is only the branch: overlay wins over navigation, which wins over minimize.
  describe('native back button handling', () => {
    let closeTopmost: Mock;
    let hasOpen: Mock;
    let locationBack: Mock;

    beforeEach(() => {
      backButtonListeners.length = 0;
      closeTopmost = vi.fn(() => false);
      hasOpen = vi.fn(() => false);
      locationBack = vi.fn();
      vi.mocked(App.minimizeApp).mockClear();
    });

    async function create() {
      const { fixture } = await render(AppComponent, {
        providers: [
          provideRouter([]),
          provideServiceWorker('ngsw-worker.js', { enabled: false }),
          ...hostProviders,
          MockProvider(TrnDialogService, {
            closeTopmost,
            hasOpen,
            openState: signal(false),
          }),
          MockProvider(Location, { back: locationBack }),
        ],
      });
      const cmp = fixture.componentInstance;
      cmp.ngOnInit();
      const listener = backButtonListeners.at(-1);
      if (!listener) {
        throw new Error('backButton listener was not registered');
      }
      return listener;
    }

    it('dismisses an open overlay instead of navigating back or minimizing', async () => {
      const listener = await create();
      hasOpen.mockReturnValue(true);
      closeTopmost.mockReturnValue(true);

      listener({ canGoBack: true });

      expect(closeTopmost).toHaveBeenCalled();
      expect(locationBack).not.toHaveBeenCalled();
      expect(App.minimizeApp).not.toHaveBeenCalled();
    });

    it('closes a registered panel after a dialog, and before leaving the page', async () => {
      // The chain has a third rung now: a feature can register something Back should close.
      // The rooms shell's right-hand panel is an inline block, not a CDK dialog, so
      // `hasOpen()` above cannot see it — Back used to walk straight past an open panel and
      // out of the room, which it has always done for the members drawer.
      const listener = await create();
      const panel = vi.fn();
      TestBed.inject(WorkspaceBackService).register({
        surface: () => roomSurface,
        dismiss: () => {
          panel();
          return of('dismissed');
        },
      });

      listener({ canGoBack: true });

      expect(panel).toHaveBeenCalled();
      expect(locationBack).not.toHaveBeenCalled();
      expect(App.minimizeApp).not.toHaveBeenCalled();
    });

    it('leaves the page when the registered panel has nothing open', async () => {
      // The other half, and the one that keeps Back usable: an interceptor that declines
      // must not swallow the press.
      const listener = await create();
      TestBed.inject(WorkspaceBackService).register({
        surface: () => null,
        dismiss: () => of('dismissed'),
      });

      listener({ canGoBack: true });

      expect(locationBack).toHaveBeenCalled();
    });

    it('asks a dialog before a registered panel, not the other way round', async () => {
      // Ordering, asserted rather than assumed: a dialog opened OVER a panel is the more
      // recent thing, so it goes first.
      const listener = await create();
      const panel = vi.fn();
      TestBed.inject(WorkspaceBackService).register({
        surface: () => roomSurface,
        dismiss: () => {
          panel();
          return of('dismissed');
        },
      });
      hasOpen.mockReturnValue(true);
      closeTopmost.mockReturnValue(true);

      listener({ canGoBack: true });

      expect(closeTopmost).toHaveBeenCalled();
      expect(panel).not.toHaveBeenCalled();
    });

    it('offers a semantic application dialog to Workspace before Room surfaces', async () => {
      const listener = await create();
      const application = vi.fn();
      const room = vi.fn();
      TestBed.inject(WorkspaceBackService).register({
        surface: () => roomSurface,
        dismiss: () => {
          room();
          return of('dismissed');
        },
      });
      TestBed.inject(WorkspaceBackService).register({
        surface: () => applicationSurface,
        dismiss: () => {
          application();
          return of('dismissed');
        },
        ownsTopmostOverlay: () => true,
      });
      hasOpen.mockReturnValue(true);

      listener({ canGoBack: true });

      expect(application).toHaveBeenCalled();
      expect(room).not.toHaveBeenCalled();
      expect(closeTopmost).not.toHaveBeenCalled();
    });

    it('swallows the press when an overlay refuses to close, rather than navigating under it', async () => {
      // The branch is on "is something open", NOT on "did it close". A dialog can decline
      // — `disableClose` on the encryption and verification flows, or a `closePredicate` —
      // and treating that refusal as "nothing here" would step the router backwards
      // beneath a modal the user is still looking at, or minimize the app out from under
      // it. Gating on `closeTopmost()`'s return alone is exactly that bug, which is why
      // this asserts the navigation did NOT happen while close reported false.
      const listener = await create();
      hasOpen.mockReturnValue(true);
      closeTopmost.mockReturnValue(false);

      listener({ canGoBack: true });

      expect(closeTopmost).toHaveBeenCalled();
      expect(locationBack).not.toHaveBeenCalled();
      expect(App.minimizeApp).not.toHaveBeenCalled();
    });

    it('steps back through router history when there is no open dialog', async () => {
      const listener = await create();

      listener({ canGoBack: true });

      expect(locationBack).toHaveBeenCalled();
      expect(App.minimizeApp).not.toHaveBeenCalled();
    });

    it('minimizes the app when there is no dialog and nowhere left to go back to', async () => {
      const listener = await create();

      listener({ canGoBack: false });

      expect(App.minimizeApp).toHaveBeenCalled();
      expect(locationBack).not.toHaveBeenCalled();
    });
  });

  // ngsw is version-locked per client: a running tab serves the build it booted with
  // until something activates the new one, so a tab open for a week would otherwise
  // never receive a shipped fix.
  describe('service-worker updates', () => {
    let versionUpdates: Subject<VersionEvent>;
    let unrecoverable: Subject<UnrecoverableStateEvent>;
    let swUpdate: {
      isEnabled: boolean;
      versionUpdates: Subject<VersionEvent>;
      unrecoverable: Subject<UnrecoverableStateEvent>;
      checkForUpdate: Mock;
      activateUpdate: Mock;
    };
    let locationStub: ReturnType<typeof stubLocation>;
    let showToast: Mock;

    beforeEach(() => {
      showToast = vi.fn();
      versionUpdates = new Subject<VersionEvent>();
      unrecoverable = new Subject<UnrecoverableStateEvent>();
      swUpdate = {
        isEnabled: true,
        versionUpdates,
        unrecoverable,
        checkForUpdate: vi.fn().mockResolvedValue(true),
        activateUpdate: vi.fn().mockResolvedValue(true),
      };
      locationStub = stubLocation();
    });

    afterEach(() => locationStub.restore());

    async function create() {
      const { fixture } = await render(AppComponent, {
        providers: [
          provideRouter([]),
          provideServiceWorker('ngsw-worker.js', { enabled: false }),
          { provide: SwUpdate, useValue: swUpdate },
          MockProvider(TrnToastService, { show: showToast }),
          ...hostProviders,
        ],
      });
      return fixture;
    }

    function readyEvent(): VersionEvent {
      return {
        type: 'VERSION_READY',
        currentVersion: { hash: 'old' },
        latestVersion: { hash: 'new' },
      };
    }

    it('offers a reload when a new version is ready', async () => {
      await create();

      versionUpdates.next(readyEvent());

      expect(showToast).toHaveBeenCalledTimes(1);
      const [message, options] = showToast.mock.calls[0];
      expect(message).toContain('new version');
      expect(options?.action?.label).toBe('Reload');
      // The prompt must survive until it is answered — a 3s auto-dismiss would make
      // the update unreachable for anyone not watching the corner of the screen.
      // `0` is TrnToastService's "keep until dismissed"; it maps to sonner's Infinity,
      // which trn-toast.service.spec.ts asserts.
      expect(options?.duration).toBe(0);
    });

    it('activates the waiting version and reloads when the action is taken', async () => {
      await create();
      versionUpdates.next(readyEvent());

      const options = showToast.mock.calls[0][1];
      options?.action?.onClick();
      await Promise.resolve();
      await Promise.resolve();

      expect(swUpdate.activateUpdate).toHaveBeenCalled();
      expect(locationStub.calls).toContain('reload');
    });

    it('reloads anyway when activation fails, so the next boot picks the version up', async () => {
      swUpdate.activateUpdate.mockRejectedValue(new Error('discarded'));
      await create();
      versionUpdates.next(readyEvent());

      showToast.mock.calls[0][1]?.action?.onClick();
      await Promise.resolve();
      await Promise.resolve();

      expect(locationStub.calls).toContain('reload');
    });

    it('ignores version events that are not a ready build', async () => {
      await create();

      versionUpdates.next({
        type: 'VERSION_DETECTED',
        version: { hash: 'new' },
      });

      expect(showToast).not.toHaveBeenCalled();
    });

    it('re-checks for a deploy when the tab returns to the foreground', async () => {
      await create();

      document.dispatchEvent(new Event('visibilitychange'));

      expect(swUpdate.checkForUpdate).toHaveBeenCalled();
    });

    it('does not re-check while the tab is hidden', async () => {
      await create();
      // Shadow the prototype getter on the instance, then drop the own property again.
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      try {
        document.dispatchEvent(new Event('visibilitychange'));
      } finally {
        delete (document as unknown as Record<string, unknown>)[
          'visibilityState'
        ];
      }

      expect(swUpdate.checkForUpdate).not.toHaveBeenCalled();
    });

    // The only untied subscribe in the app used to live here; a destroyed shell must
    // stop reacting, or the pattern gets copied into a component that IS destroyed.
    it('stops reacting to service-worker events once destroyed', async () => {
      const fixture = await create();

      fixture.destroy();
      unrecoverable.next({
        type: 'UNRECOVERABLE_STATE',
        reason: 'cache gone',
      });
      versionUpdates.next(readyEvent());
      document.dispatchEvent(new Event('visibilitychange'));

      expect(locationStub.calls).not.toContain('reload');
      expect(showToast).not.toHaveBeenCalled();
      expect(swUpdate.checkForUpdate).not.toHaveBeenCalled();
    });
  });
});

/**
 * Swap `window.location` for a recorder: jsdom implements no navigation, and
 * test-setup.base.ts filters its "Not implemented" noise — so a missing reload would
 * otherwise be unobservable in both directions.
 */
function stubLocation() {
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
      if (original) {
        Object.defineProperty(window, 'location', original);
      }
    },
  };
}

describe('AppComponent boot screen', () => {
  /** A route that resolves immediately, so navigation completes within the test. */
  async function create() {
    const result = await render(AppComponent, {
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        provideServiceWorker('ngsw-worker.js', { enabled: false }),
        ...hostProviders,
      ],
    });
    return result;
  }

  const bootScreen = (container: HTMLElement) =>
    container.querySelector('[data-testid=app-booting]');

  it('shows a boot screen before any route has resolved', async () => {
    // The gap this fills: Angular clears index.html's splash as soon as the ROOT component
    // renders, which is well before `authGuard` has finished restoring the session. Without
    // this the app went straight from a splash to an empty screen.
    const { container } = await create();

    expect(bootScreen(container)).not.toBeNull();
    expect(container.textContent).toContain('Restoring your session…');
  });

  it('announces itself to assistive tech rather than being a silent blank', async () => {
    const { container } = await create();

    expect(bootScreen(container)?.getAttribute('role')).toBe('status');
    expect(bootScreen(container)?.getAttribute('aria-live')).toBe('polite');
  });

  it('gets out of the way once a route has rendered', async () => {
    const { container, fixture } = await create();
    expect(bootScreen(container)).not.toBeNull();

    await TestBed.inject(Router).navigate(['/anything']);
    fixture.detectChanges();

    expect(bootScreen(container)).toBeNull();
  });

  it('does not linger through the redirect a guard performs', async () => {
    // Shaped like the real `authGuard`, which returns `true` or a UrlTree for /login and
    // NEVER a bare `false`. That distinction is the test: a UrlTree CANCELS the first
    // navigation and has the router start a second one of its own, so treating the cancel
    // as "done" would drop the boot screen into the gap between the two and show a blank
    // frame. `false` merely ends the navigation, and asserting against it proved nothing
    // about the path a signed-out user actually takes.
    const { container, fixture } = await render(AppComponent, {
      providers: [
        provideRouter([
          {
            path: 'guarded',
            children: [],
            canActivate: [() => inject(Router).createUrlTree(['/login'])],
          },
          { path: 'login', children: [] },
        ]),
        provideServiceWorker('ngsw-worker.js', { enabled: false }),
        ...hostProviders,
      ],
    });
    const router = TestBed.inject(Router);

    await router.navigate(['/guarded']);
    fixture.detectChanges();

    // The redirect really happened, so the assertion below is about the second navigation
    // ending rather than about the first one never starting.
    expect(router.url).toBe('/login');
    expect(bootScreen(container)).toBeNull();
  });

  it('gets out of the way when the route fails to load', async () => {
    // The everyday version: a lazy chunk that 404s after a deploy. That navigation ends in
    // NavigationError and never in NavigationEnd, so a boot screen waiting only for the
    // latter never leaves — the user is left staring at "Restoring your session…" with no
    // way to tell that anything went wrong. Hence `navigated` accepting both.
    const { container, fixture } = await render(AppComponent, {
      providers: [
        provideRouter([
          {
            path: 'broken',
            loadComponent: () => Promise.reject(new Error('chunk load failed')),
          },
        ]),
        provideServiceWorker('ngsw-worker.js', { enabled: false }),
        ...hostProviders,
      ],
    });
    const router = TestBed.inject(Router);

    await expect(router.navigate(['/broken'])).rejects.toThrow(
      'chunk load failed',
    );
    fixture.detectChanges();

    expect(bootScreen(container)).toBeNull();
  });
});
