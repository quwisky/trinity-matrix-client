import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import {
  AuthService,
  FactoryResetService,
  type OidcAuthorizationParams,
} from '@trinity/data-access/auth';
import {
  AppRestartService,
  SessionStorageService,
} from '@trinity/platform-native';
import { TrnAlertService } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { LoginPage } from './login.page';
import { SsoStateStore } from '../sso-state.store';
import { OidcStateStore } from '../oidc-state.store';

async function renderLogin(
  auth: Partial<AuthService>,
  opts: {
    add?: boolean;
    reauth?: string;
    record?: unknown;
    oidcStore?: Partial<OidcStateStore>;
    /** Accounts the registry reports, which the erase confirmation names. */
    stored?: { userId: string }[];
    /** Make the registry read fail, as a wedged install would. */
    listFails?: boolean;
    /** What the alert's typed confirmation returns (null = cancelled). */
    typed?: string | null;
    /** What the wipe reports back. */
    report?: { blocked: string[]; failed: string[] };
  } = {},
): Promise<{
  fixture: Awaited<ReturnType<typeof render<LoginPage>>>['fixture'];
  cmp: LoginPage;
  router: Router;
  ssoStore: SsoStateStore;
  oidcStore: OidcStateStore;
  alert: TrnAlertService;
  reset: FactoryResetService;
  restart: AppRestartService;
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
        peek: vi.fn().mockResolvedValue({}),
        ...opts.oidcStore,
      }),
      MockProvider(SessionStorageService, {
        record: vi.fn(() => of(opts.record ?? null) as never),
        list: vi.fn(() =>
          opts.listFails
            ? throwError(() => new Error('registry unreadable'))
            : (of(opts.stored ?? []) as never),
        ),
        clearAll: vi.fn(() => of([]) as never),
      }),
      MockProvider(TrnAlertService, {
        prompt: vi.fn().mockResolvedValue(opts.typed ?? null),
      }),
      MockProvider(FactoryResetService, {
        clearAllData: vi.fn(() =>
          of({
            blocked: opts.report?.blocked ?? [],
            failed: opts.report?.failed ?? [],
            enumerated: true,
          }),
        ),
      }),
      MockProvider(AppRestartService, { restart: vi.fn() }),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap } } },
    ],
  });
  return {
    fixture,
    cmp: fixture.componentInstance,
    router: TestBed.inject(Router),
    ssoStore: TestBed.inject(SsoStateStore),
    oidcStore: TestBed.inject(OidcStateStore),
    alert: TestBed.inject(TrnAlertService),
    reset: TestBed.inject(FactoryResetService),
    restart: TestBed.inject(AppRestartService),
  };
}

describe('LoginPage', () => {
  it('renders its page title as the first and only heading', async () => {
    const { fixture } = await renderLogin(
      {} as unknown as Partial<AuthService>,
    );
    const root = fixture.nativeElement as HTMLElement;
    const outline = Array.from(
      root.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6'),
    ).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent?.trim(),
    }));

    expect(outline).toEqual([{ level: 1, text: 'Sign in to Trinity' }]);
  });

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
      (_baseUrl: string, _redirectUrl: string) =>
        'https://hs.example/_matrix/sso?redirectUrl=x',
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
    const getSsoUrl = vi.fn(
      (_baseUrl: string, _redirectUrl: string) => 'https://hs.example/sso',
    );
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

  describe('clear all data', () => {
    it('erases and restarts once the word is typed', async () => {
      const { cmp, reset, restart } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: 'ERASE' },
      );

      await cmp.clearAllData();

      expect(reset.clearAllData).toHaveBeenCalled();
      expect(restart.restart).toHaveBeenCalled();
    });

    it('renders the button, disabled only while erasing', async () => {
      // Every other test here calls the method directly, so without this one the button
      // could be deleted from the template — or wired to a different handler — and the
      // whole describe block would stay green.
      const { fixture, cmp } = await renderLogin(
        {} as unknown as Partial<AuthService>,
      );
      const button = (): HTMLButtonElement | null =>
        fixture.nativeElement.querySelector('[data-testid="clear-all-data"]');

      expect(button()).not.toBeNull();
      expect(button()?.disabled).toBe(false);

      cmp.erasing.set(true);
      fixture.detectChanges();

      expect(button()?.disabled).toBe(true);
    });

    it('does not use the Helm destructive variant, which would out-weigh signing in', async () => {
      // The fast canary for the one wrong edit this button attracts: reaching for
      // `variant="destructive"`, the only thing in hlm-button that emits `bg-destructive`.
      // It used to fail contrast on this card as well; the tint is pinned opaque now, so
      // what remains is weighting — a filled control reads as this screen's primary action,
      // and that is the sign-in button, not the escape hatch. Deliberately a NEGATIVE
      // assertion: any restyling that keeps the label red without the tint still passes, so
      // this does not red on a legitimate refactor. What the label positively renders as is
      // measured where it can actually be seen, in clear-all-data.spec.mts — jsdom has no
      // Tailwind and no theme tokens, so nothing here can check a colour.
      const { fixture } = await renderLogin(
        {} as unknown as Partial<AuthService>,
      );
      const button: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="clear-all-data"]',
      );

      expect(button.className).not.toContain('bg-destructive');
    });

    it('erases nothing when the word is mistyped, and says so', async () => {
      // Silence here is indistinguishable from a broken button, and this is the screen
      // someone reaches when things are already broken.
      const { cmp, reset, restart } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: 'yes please' },
      );

      await cmp.clearAllData();

      expect(reset.clearAllData).not.toHaveBeenCalled();
      expect(restart.restart).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/Type ERASE exactly/);
    });

    it('erases nothing and stays quiet when cancelled', async () => {
      const { cmp, reset } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: null },
      );

      await cmp.clearAllData();

      expect(reset.clearAllData).not.toHaveBeenCalled();
      expect(cmp.error()).toBeNull(); // they changed their mind; nagging would be rude
    });

    it('restarts even when something could not be deleted', async () => {
      // Residue is not a reason to strand the user on a page whose data is already gone.
      // The wipe finished; what is left is an orphan the next cold start sweeps.
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { cmp, restart } = await renderLogin(
          {} as unknown as Partial<AuthService>,
          {
            typed: 'ERASE',
            report: {
              blocked: ['matrix-js-sdk:trinity-sync:@a:hs'],
              failed: ['other-db'],
            },
          },
        );

        await cmp.clearAllData();

        expect(restart.restart).toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.any(String), [
          'matrix-js-sdk:trinity-sync:@a:hs',
          'other-db',
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it('stays clickable while the page is busy discovering a dead homeserver', async () => {
      // The failure this button exists for puts the page in `busy` for a full HTTP
      // timeout — and on /login?reauth= from first paint. Asserted through the RENDERED
      // button, not by comparing the two signals: `erasing` is independent of `busy` by
      // construction, so a signal-level assertion cannot fail, while re-adding
      // `|| busy()` to the template binding is the one-line change that would actually
      // disable the escape hatch exactly when it is needed.
      const { fixture, cmp } = await renderLogin(
        {} as unknown as Partial<AuthService>,
      );
      const button = (): HTMLButtonElement | null =>
        fixture.nativeElement.querySelector('[data-testid="clear-all-data"]');

      cmp.busy.set(true);
      fixture.detectChanges();

      expect(button()?.disabled).toBe(false);
    });

    it('warns that accounts may be signed out when the registry cannot be read', async () => {
      // A registry too broken to read is one of the states this button is for. Saying
      // nothing would read as "no accounts signed in" and let someone erase live ones
      // having seen the gentlest version of the dialog.
      const { cmp, alert } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: null, listFails: true },
      );

      await cmp.clearAllData();

      const message = vi.mocked(alert.prompt).mock.calls[0][0].message ?? '';
      expect(message).toMatch(/Any accounts signed in on this device/);
    });

    it('names the signed-in accounts in the confirmation', async () => {
      // /login?add is reachable while accounts are live, and someone who came here to ADD
      // an account has to be told what erasing would take with it.
      const { cmp, alert } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        {
          add: true,
          typed: null,
          stored: [{ userId: '@a:hs' }, { userId: '@b:hs' }],
        },
      );

      await cmp.clearAllData();

      const message = vi.mocked(alert.prompt).mock.calls[0][0].message ?? '';
      expect(message).toContain('@a:hs');
      expect(message).toContain('@b:hs');
    });
  });

  it('uses the eu.qwky.trinity:// scheme and opens externally on Electron', async () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const getSsoUrl = vi.fn(
        (_baseUrl: string, _redirectUrl: string) => 'https://hs.example/sso',
      );
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
      buildOidcAuthorizationRequest: Mock,
      oidcStore?: Partial<OidcStateStore>,
    ) {
      const rendered = await renderLogin(
        {
          buildOidcAuthorizationRequest,
        } as unknown as Partial<AuthService>,
        oidcStore ? { oidcStore } : {},
      );
      rendered.cmp.baseUrl.set('https://hs.example');
      rendered.cmp.oidcMetadata.set({ issuer: 'https://op' } as never);
      return rendered;
    }

    it('sweeps an abandoned stash on landing', async () => {
      const peek = vi.fn().mockResolvedValue({});

      await renderLogin({} as unknown as Partial<AuthService>, {
        oidcStore: { peek },
      });

      // This read IS the sweep — peek() bins a stash past its TTL, and the TTL is only
      // ever enforced on read. The callback page is the only other reader, so without
      // this an abandoned sign-in leaves a plaintext PKCE code_verifier on disk until
      // some later save() happens to overwrite it. Deleting the line breaks a promise
      // the CHANGELOG makes to users, and nothing else here would notice.
      expect(peek).toHaveBeenCalledTimes(1);
    });

    it('does not raise an unhandled rejection when the sweep cannot read storage', async () => {
      // Nothing on this page depends on the sweep's answer, so a storage read that
      // rejects must be swallowed at the call site. Asserting the rendered state cannot
      // see this — the page looks identical either way — so listen for the rejection
      // itself. Node reports one only after the turn ends with no handler attached,
      // hence the macrotask below.
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        // A plain function, not vi.fn().mockRejectedValue: vitest attaches its own
        // handler to a mock's returned promise to record settledResults, which marks it
        // handled and would make this assertion pass no matter what the page does.
        const peek = (): Promise<never> =>
          Promise.reject(new Error('storage unavailable'));

        const { cmp } = await renderLogin(
          {} as unknown as Partial<AuthService>,
          { oidcStore: { peek } },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(rejections).toEqual([]);
        expect(cmp.error()).toBeNull();
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('re-authenticates the stored device instead of minting a new one', async () => {
      const buildOidcAuthorizationRequest = vi.fn(
        (_params: OidcAuthorizationParams) => of(OIDC_REQUEST),
      );
      const { cmp, oidcStore } = await renderLogin(
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
      // Reusing the device makes the identity check load-bearing: a provider that still
      // holds a browser session authorizes with no interaction, so on a homeserver with
      // two accounts this could come back as the other one and inherit OLDDEV. The
      // callback can only refuse that if the expectation travels in the stash.
      await Promise.resolve();
      expect(vi.mocked(oidcStore.save).mock.calls[0][0]).toMatchObject({
        expectedUserId: '@bob:hs',
      });
    });

    it('stashes no expectation for an ordinary login', async () => {
      // Any account the user picks is the right answer here, so an expectation would only
      // create a way to reject a perfectly good sign-in.
      const buildOidcAuthorizationRequest = vi.fn(
        (_params: OidcAuthorizationParams) => of(OIDC_REQUEST),
      );
      const { cmp, oidcStore } = await renderOidcReady(
        buildOidcAuthorizationRequest,
      );

      cmp.startOidc();
      await Promise.resolve();
      await Promise.resolve();

      expect(vi.mocked(oidcStore.save).mock.calls[0][0]).toMatchObject({
        expectedUserId: null,
      });
    });

    it('builds the authorization request, stashes the sign-in state, then redirects (web)', async () => {
      const buildOidcAuthorizationRequest = vi.fn(
        (_params: OidcAuthorizationParams) => of(OIDC_REQUEST),
      );
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

    it('redirects on web, and only after the stash is durably written', async () => {
      // Two gaps this closes. Nothing asserted the web redirect fires at all — emptying
      // that branch broke web sign-in with the suite green. And nothing asserted the
      // ORDERING, despite a sibling test named "...stashes the sign-in state, then
      // redirects": reversing the two left every assertion passing. If the redirect wins
      // the race, a native cold start or a fast provider can return before the
      // code_verifier is on disk, and the exchange has nothing to present.
      const original = Object.getOwnPropertyDescriptor(window, 'location');
      const locationStub = { href: '' };
      Object.defineProperty(window, 'location', {
        value: locationStub,
        writable: true,
        configurable: true,
      });
      try {
        let releaseSave: (() => void) | undefined;
        const savePending = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        const buildOidcAuthorizationRequest = vi.fn(
          (_params: OidcAuthorizationParams) => of(OIDC_REQUEST),
        );
        const { cmp } = await renderOidcReady(buildOidcAuthorizationRequest, {
          save: vi.fn(() => savePending),
        });

        cmp.startOidc();
        await Promise.resolve();
        await Promise.resolve();

        // The stash has not settled yet, so nothing may have navigated.
        expect(locationStub.href).toBe('');

        releaseSave?.();
        await Promise.resolve();
        await Promise.resolve();

        expect(locationStub.href).toBe(OIDC_REQUEST.url);
      } finally {
        if (original) Object.defineProperty(window, 'location', original);
      }
    });

    it('sends prompt=create for registration when the provider supports it', async () => {
      const request = {
        ...OIDC_REQUEST,
        url: 'https://op/authorize?state=STATE1',
      };
      const buildOidcAuthorizationRequest = vi.fn(
        (_params: OidcAuthorizationParams) => of(request),
      );
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
        const buildOidcAuthorizationRequest = vi.fn(
          (_params: OidcAuthorizationParams) => of(request),
        );
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
