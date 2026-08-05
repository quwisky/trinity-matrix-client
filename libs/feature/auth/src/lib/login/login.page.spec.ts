import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '@trinity/data-access/auth';
import { SessionStorageService } from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login.page';
import { SsoStateStore } from '../sso-state.store';
import { OidcStateStore } from '../oidc-state.store';

async function renderLogin(
  auth: Partial<AuthService>,
  opts: { add?: boolean; reauth?: string; record?: unknown } = {},
): Promise<{
  cmp: LoginPage;
  router: Router;
  ssoStore: SsoStateStore;
  oidcStore: OidcStateStore;
}> {
  const queryParamMap = {
    has: (key: string) => key === 'add' && !!opts.add,
    get: (key: string) => (key === 'reauth' ? (opts.reauth ?? null) : null),
  };
  const { fixture } = await render(LoginPage, {
    providers: [
      MockProvider(AuthService, auth),
      MockProvider(Router),
      MockProvider(SsoStateStore),
      MockProvider(OidcStateStore, {
        save: vi.fn().mockResolvedValue(undefined),
      }),
      MockProvider(SessionStorageService, {
        record: vi.fn(() => of(opts.record ?? null) as never),
      }),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap } } },
    ],
  });
  return {
    cmp: fixture.componentInstance,
    router: TestBed.inject(Router),
    ssoStore: TestBed.inject(SsoStateStore),
    oidcStore: TestBed.inject(OidcStateStore),
  };
}

describe('LoginPage', () => {
  it('discovers the homeserver and surfaces its login flows', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of(['m.login.password', 'm.login.sso'])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.baseUrl()).toBe('https://hs.example');
    expect(cmp.passwordSupported()).toBe(true);
    expect(cmp.ssoSupported()).toBe(true);
    expect(cmp.oidcSupported()).toBe(false);
  });

  it('hides password/SSO when the homeserver does not offer them', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of([])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.passwordSupported()).toBe(false);
    expect(cmp.ssoSupported()).toBe(false);
    // A homeserver offering no supported method must surface an explanation rather
    // than leaving the user on a blank card.
    expect(cmp.error()).toBe(
      "This homeserver doesn't offer a sign-in method Trinity supports.",
    );
  });

  it('still surfaces OIDC when the legacy loginFlows() probe fails', async () => {
    // An OIDC-native homeserver may not serve /login at all; a rejected getSupportedFlows
    // must not abort discovery and hide the working OIDC provider.
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => throwError(() => new Error('404'))),
      getDelegatedAuthConfig: vi.fn(() => of({ issuer: 'https://op' })),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.baseUrl()).toBe('https://hs.example');
    expect(cmp.oidcSupported()).toBe(true);
    expect(cmp.error()).toBeNull();
  });

  it('prefers OIDC and suppresses password/SSO when the homeserver delegates auth', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      // A migrating homeserver may still advertise password + SSO…
      getSupportedFlows: vi.fn(() => of(['m.login.password', 'm.login.sso'])),
      // …but OIDC metadata being present means the provider owns credentials.
      getDelegatedAuthConfig: vi.fn(() => of({ issuer: 'https://op' })),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.oidcSupported()).toBe(true);
    expect(cmp.passwordSupported()).toBe(false);
    expect(cmp.ssoSupported()).toBe(false);
  });

  it('surfaces a discovery error and stays on step 1', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() =>
        throwError(() => new Error('no .well-known')),
      ),
      getSupportedFlows: vi.fn(),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.error()).toBe('no .well-known');
    expect(cmp.baseUrl()).toBeNull();
  });

  it('logs in with a password and navigates to rooms', async () => {
    const loginWithPassword = vi.fn(() => of(undefined));
    const { cmp, router } = await renderLogin({
      loginWithPassword,
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');
    cmp.credentialsForm.username().value.set('alice');
    cmp.credentialsForm.password().value.set('hunter2');

    cmp.loginPassword();

    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://hs.example',
      'alice',
      'hunter2',
      'replace',
      undefined, // no device id → a fresh (not re-auth) login
    );
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('logs in in add mode when /login?add is set', async () => {
    const loginWithPassword = vi.fn(() => of(undefined));
    const { cmp } = await renderLogin(
      { loginWithPassword } as unknown as Partial<AuthService>,
      { add: true },
    );
    cmp.baseUrl.set('https://hs.example');
    cmp.credentialsForm.username().value.set('bob');
    cmp.credentialsForm.password().value.set('hunter2');

    expect(cmp.addMode).toBe(true);
    cmp.loginPassword();

    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://hs.example',
      'bob',
      'hunter2',
      'add',
      undefined,
    );
  });

  it('re-auth mode prefills the account and reuses its device (add + deviceId)', async () => {
    const loginWithPassword = vi.fn(() => of(undefined));
    const getSupportedFlows = vi.fn(() => of(['m.login.password']));
    const { cmp } = await renderLogin(
      {
        loginWithPassword,
        getSupportedFlows,
        getDelegatedAuthConfig: vi.fn(() => of(null)),
      } as unknown as Partial<AuthService>,
      {
        reauth: '@bob:hs',
        record: {
          baseUrl: 'https://hs.example',
          userId: '@bob:hs',
          deviceId: 'OLDDEV',
        },
      },
    );

    // The constructor loaded the record: homeserver known, username locked in.
    expect(cmp.reauthUserId()).toBe('@bob:hs');
    expect(cmp.baseUrl()).toBe('https://hs.example');
    expect(cmp.credentialsForm.username().value()).toBe('@bob:hs');
    expect(getSupportedFlows).toHaveBeenCalledWith('https://hs.example');

    cmp.credentialsForm.password().value.set('hunter2');
    cmp.loginPassword();

    // Re-auth logs in ADD mode, re-authenticating the EXISTING device.
    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://hs.example',
      '@bob:hs',
      'hunter2',
      'add',
      'OLDDEV',
    );
  });

  it('surfaces a password-login error without navigating', async () => {
    const { cmp, router } = await renderLogin({
      loginWithPassword: vi.fn(() => throwError(() => new Error('bad creds'))),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.error()).toBe('bad creds');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('starts SSO with a state nonce stashed and bound to the callback redirect', async () => {
    const getSsoUrl = vi.fn(
      () => 'https://hs.example/_matrix/sso?redirectUrl=x',
    );
    const { cmp, ssoStore } = await renderLogin({
      getSsoUrl,
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    await cmp.startSso();

    // The nonce + homeserver are persisted via the store (Preferences) so a native
    // cold-start callback can still validate — not in sessionStorage.
    expect(ssoStore.save).toHaveBeenCalledTimes(1);
    const [state, savedBaseUrl] = vi.mocked(ssoStore.save).mock.calls[0] as [
      string,
      string,
    ];
    expect(savedBaseUrl).toBe('https://hs.example');
    expect(state).toBeTruthy();
    // The state round-trips via the redirect URL handed to the homeserver.
    const redirect = getSsoUrl.mock.calls[0][1] as string;
    expect(redirect).toContain('/sso-callback?sso_state=');
    expect(redirect).toContain(state);
  });

  it('re-auth SSO stashes an add-mode nonce bound to the existing device', async () => {
    const getSsoUrl = vi.fn(() => 'https://hs.example/sso');
    const getSupportedFlows = vi.fn(() => of(['m.login.sso']));
    const { cmp, ssoStore } = await renderLogin(
      {
        getSsoUrl,
        getSupportedFlows,
        getDelegatedAuthConfig: vi.fn(() => of(null)),
      } as unknown as Partial<AuthService>,
      {
        reauth: '@bob:hs',
        record: {
          baseUrl: 'https://hs.example',
          userId: '@bob:hs',
          deviceId: 'OLDDEV',
        },
      },
    );

    // The constructor loaded the record: the homeserver comes from the stored account.
    expect(cmp.baseUrl()).toBe('https://hs.example');

    await cmp.startSso();

    // The SSO round-trip re-authenticates the EXISTING device: the stash carries add
    // mode + OLDDEV, so the homeserver mints no new device and no re-verification runs.
    expect(ssoStore.save).toHaveBeenCalledTimes(1);
    const [state, savedBaseUrl, mode, deviceId] = vi.mocked(ssoStore.save).mock
      .calls[0] as [string, string, string, string];
    expect(savedBaseUrl).toBe('https://hs.example');
    expect(mode).toBe('add');
    expect(deviceId).toBe('OLDDEV');
    expect(state).toBeTruthy();
  });

  it('uses the eu.qwky.trinity:// scheme and opens externally on Electron', async () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const getSsoUrl = vi.fn(() => 'https://hs.example/sso');
      const { cmp } = await renderLogin({
        getSsoUrl,
      } as unknown as Partial<AuthService>);
      cmp.baseUrl.set('https://hs.example');

      await cmp.startSso();

      const redirect = getSsoUrl.mock.calls[0][1] as string;
      expect(redirect).toContain('eu.qwky.trinity://sso-callback?sso_state=');
      expect(open).toHaveBeenCalledWith('https://hs.example/sso', '_blank');
    } finally {
      open.mockRestore();
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    }
  });

  describe('OIDC (next-gen auth)', () => {
    /**
     * What OidcClientService hands back: the URL plus the PKCE context the caller is now
     * the sole custodian of (matrix-js-sdk 42 persists none of it itself).
     */
    const OIDC_REQUEST = {
      url: 'https://op/authorize?client_id=abc&state=STATE1',
      state: 'STATE1',
      clientId: 'CLIENT1',
      deviceId: 'DEVICE1',
      codeVerifier: 'VERIFIER1',
    };

    /** An OIDC-native login page: discovered homeserver + provider metadata. */
    async function renderOidcReady(
      buildOidcAuthorizationRequest: ReturnType<typeof vi.fn>,
    ) {
      const rendered = await renderLogin({
        buildOidcAuthorizationRequest,
      } as unknown as Partial<AuthService>);
      rendered.cmp.baseUrl.set('https://hs.example');
      rendered.cmp.oidcMetadata.set({ issuer: 'https://op' } as never);
      return rendered;
    }

    it('re-authenticates the stored device instead of minting a new one', async () => {
      const buildOidcAuthorizationRequest = vi.fn(() => of(OIDC_REQUEST));
      const { cmp } = await renderLogin(
        {
          buildOidcAuthorizationRequest,
          getDelegatedAuthConfig: vi.fn(() =>
            of({ issuer: 'https://op' } as never),
          ),
          getSupportedFlows: vi.fn(() => of([])),
        } as unknown as Partial<AuthService>,
        {
          reauth: '@bob:hs',
          record: {
            baseUrl: 'https://hs.example',
            userId: '@bob:hs',
            deviceId: 'OLDDEV',
          },
        },
      );
      cmp.oidcMetadata.set({ issuer: 'https://op' } as never);

      cmp.startOidc();
      await Promise.resolve();

      // Re-auth exists to recover a soft-logged-out account WITHOUT the user verifying a
      // fresh device. matrix-js-sdk 41 could not express this — the authorize helper took
      // no device id and always generated one — so an OIDC re-auth silently produced a new
      // device and demanded re-verification. v42's OAuth2 context accepts one.
      const params = buildOidcAuthorizationRequest.mock.calls[0][0] as {
        deviceId?: string;
      };
      expect(params.deviceId).toBe('OLDDEV');
    });

    it('builds the authorization request, stashes the sign-in state, then redirects (web)', async () => {
      const buildOidcAuthorizationRequest = vi.fn(() => of(OIDC_REQUEST));
      const { cmp, oidcStore } = await renderOidcReady(
        buildOidcAuthorizationRequest,
      );

      cmp.startOidc();
      // Let the awaited stash write settle before asserting the redirect ordering.
      await Promise.resolve();
      await Promise.resolve();

      // The client registers as `web` with the origin callback (no extra query params).
      const params = buildOidcAuthorizationRequest.mock.calls[0][0] as {
        applicationType: string;
        redirectUri: string;
      };
      expect(params.applicationType).toBe('web');
      expect(params.redirectUri).toContain('/sso-callback');
      // The whole PKCE context — including the code_verifier — is stashed before the
      // redirect ON WEB TOO. matrix-js-sdk 42 persists no sign-in state of its own, so
      // this stash is the only copy; skipping it on web would simply break web login.
      expect(oidcStore.save).toHaveBeenCalledTimes(1);
      expect(vi.mocked(oidcStore.save).mock.calls[0][0]).toMatchObject({
        state: 'STATE1',
        baseUrl: 'https://hs.example',
        issuer: 'https://op',
        redirectUri: params.redirectUri,
        clientId: 'CLIENT1',
        deviceId: 'DEVICE1',
        codeVerifier: 'VERIFIER1',
      });
    });

    it('sends prompt=create for registration when the provider supports it', async () => {
      const request = {
        ...OIDC_REQUEST,
        url: 'https://op/authorize?state=STATE1',
      };
      const buildOidcAuthorizationRequest = vi.fn(() => of(request));
      const { cmp } = await renderLogin({
        buildOidcAuthorizationRequest,
      } as unknown as Partial<AuthService>);
      cmp.baseUrl.set('https://hs.example');
      cmp.oidcMetadata.set({
        issuer: 'https://op',
        prompt_values_supported: ['create'],
      } as never);

      expect(cmp.oidcRegistrationSupported()).toBe(true);
      cmp.startOidc('create');
      await Promise.resolve();

      const params = buildOidcAuthorizationRequest.mock.calls[0][0] as {
        prompt?: string;
      };
      expect(params.prompt).toBe('create');
    });

    it('registers as native + opens externally on Electron', async () => {
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
        isElectron: true,
      };
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      try {
        const request = {
          ...OIDC_REQUEST,
          url: 'https://op/authorize?state=STATE1',
        };
        const buildOidcAuthorizationRequest = vi.fn(() => of(request));
        const { cmp, oidcStore } = await renderOidcReady(
          buildOidcAuthorizationRequest,
        );

        cmp.startOidc();
        await Promise.resolve();
        await Promise.resolve();

        const params = buildOidcAuthorizationRequest.mock.calls[0][0] as {
          applicationType: string;
          redirectUri: string;
        };
        expect(params.applicationType).toBe('native');
        // RFC 8252 §7.1: a private-use scheme redirect has NO authority, so only a
        // single slash follows the scheme. `//sso-callback` would put the path in the
        // authority position, which strict providers reject at dynamic registration.
        expect(params.redirectUri).toBe('eu.qwky.trinity:/sso-callback');
        expect(open).toHaveBeenCalledWith(request.url, '_blank');
        // Native/Electron durably stash the PKCE context against a cold-start callback
        // in a different browsing context — the same write web now performs.
        expect(vi.mocked(oidcStore.save).mock.calls[0][0]).toMatchObject({
          redirectUri: 'eu.qwky.trinity:/sso-callback',
          clientId: 'CLIENT1',
          deviceId: 'DEVICE1',
          codeVerifier: 'VERIFIER1',
        });
      } finally {
        open.mockRestore();
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });
  });
});
