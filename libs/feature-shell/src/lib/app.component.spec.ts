import { signal } from '@angular/core';
import { Dialog, type DialogRef } from '@angular/cdk/dialog';
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { App } from '@capacitor/app';
import { VerificationService } from '@trinity/data-access-crypto';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';

vi.mock('@capacitor/browser', () => ({
  Browser: { close: vi.fn().mockResolvedValue(undefined), open: vi.fn() },
}));

// Captures the 'backButton' listener so tests can invoke it directly, and stubs
// the other App calls the native-only branch of ngOnInit makes. `vi.mock` factories
// are hoisted above other module code, so the array has to be created via
// `vi.hoisted` for the factory below to see it.
const { backButtonListeners } = vi.hoisted(() => ({
  backButtonListeners: [] as Array<(state: { canGoBack: boolean }) => void>,
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
  Capacitor: { isNativePlatform: () => true },
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

  // Android hardware back button (native only, see ngOnInit): close the top open
  // CDK overlay if one owns the screen, else step back through router history if
  // possible, else minimize the app. Exercised through the actual listener
  // registered with the (mocked) Capacitor App plugin, not a refactored helper.
  describe('native back button handling', () => {
    let dialogOpenDialogs: DialogRef<unknown, unknown>[];
    let locationBack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      backButtonListeners.length = 0;
      dialogOpenDialogs = [];
      locationBack = vi.fn();
      vi.mocked(App.minimizeApp).mockClear();
    });

    async function create() {
      const { fixture } = await render(AppComponent, {
        providers: [
          provideRouter([]),
          provideServiceWorker('ngsw-worker.js', { enabled: false }),
          ...hostProviders,
          MockProvider(Dialog, { openDialogs: dialogOpenDialogs }),
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

    it('closes the top open dialog instead of navigating back or minimizing', async () => {
      const listener = await create();
      const closeTop = vi.fn();
      dialogOpenDialogs.push(
        { close: vi.fn() } as unknown as DialogRef<unknown, unknown>,
        { close: closeTop } as unknown as DialogRef<unknown, unknown>,
      );

      listener({ canGoBack: true });

      expect(closeTop).toHaveBeenCalled();
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
});
