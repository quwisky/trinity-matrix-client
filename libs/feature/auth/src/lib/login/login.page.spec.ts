import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  DefaultUrlSerializer,
  Router,
  type UrlCreationOptions,
  type UrlTree,
} from '@angular/router';
import {
  ReauthAccountMismatchError,
  UnacceptableAccountError,
  AuthService,
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  NewDeviceSignInCancelledError,
  OidcStateStore,
  QrSignInAvailability,
  QrSignInService,
  RegistrationService,
  SignInRedirectService,
  UnprotectedStorageDeclinedError,
  type NewDeviceState,
} from '@trinity/data-access/auth';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  ACCOUNT_DELETION_LAUNCHER,
  ACCOUNT_REMOVAL_LAUNCHER,
  AppRestartService,
  BUG_REPORT_LAUNCHER,
  QrCodeService,
  SessionStorageService,
  provideHostCapabilities,
  type AccountRemovalLauncher,
  type AccountRemovalOutcome,
} from '@trinity/platform-native';
import { TrnAlertService } from '@trinity/components/overlay';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import {
  EMPTY,
  NEVER,
  Subject,
  map,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login.page';

const platform = vi.hoisted(() => ({ android: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isNativeAndroid: () => platform.android,
}));
import { ConnectionError, MatrixError } from '@trinity/util/matrix';

const READY_OUTCOME = {
  kind: 'ready',
  accountId: '@me:hs',
  placement: 'active',
} as const;

async function renderLogin(
  auth: Partial<AuthService> & {
    discoverHomeserver?: (input: string) => Observable<string>;
  },
  opts: {
    add?: boolean;
    reauth?: string;
    /** `device=new` on a re-auth: sign in as a new device whatever the store holds. */
    newDevice?: boolean;
    record?: unknown;
    /** The device re-auth may reuse; defaults to the record's own. */
    reusableDevice?: string | null;
    oidcStore?: Partial<OidcStateStore>;
    /** Overrides for the redirect handoff (cold Observables that complete). */
    redirect?: Partial<SignInRedirectService>;
    /** Accounts the registry reports, which the erase confirmation names. */
    stored?: { userId: string }[];
    /** Make the registry read fail, as a wedged install would. */
    listFails?: boolean;
    /** What the alert's typed confirmation returns (null = cancelled). */
    typed?: string | null;
    /** What the wipe reports back. */
    report?: { blocked: string[]; failed: string[] };
    /** The app's Report a bug launcher; absent unless a test provides one. */
    bugReport?: { open: () => void };
    /** The account whose deletion led here, as the deletion launcher hands it over. */
    deleted?: string | WritableSignal<string | null>;
    /** Whether the homeserver supports QR sign-in; it does not unless a test says so. */
    qrSupported?: boolean;
    /** The states a QR sign-in emits; it never moves unless a test says so. */
    qrFlow?: Observable<NewDeviceState>;
    /** The navigation state the reset-password page leaves when it signs the person back in. */
    navigationState?: { passwordReset: true };
    /** `?homeserver=`, as the reset and registration pages hand back. */
    homeserver?: string;
    /** How the removal flow ends; the person keeps the account unless a test says so. */
    removal?: Observable<AccountRemovalOutcome>;
    /** Whether another account is live; none is unless a test says so. */
    liveAccount?: boolean;
  } = {},
): Promise<{
  fixture: Awaited<ReturnType<typeof render<LoginPage>>>['fixture'];
  cmp: LoginPage;
  router: Router;
  redirect: SignInRedirectService;
  oidcStore: OidcStateStore;
  alert: TrnAlertService;
  reset: AccountRuntimeService;
  restart: AppRestartService;
  removal: AccountRemovalLauncher;
}> {
  const queryParamMap = {
    has: (key: string) => key === 'add' && !!opts.add,
    get: (key: string) =>
      key === 'reauth'
        ? (opts.reauth ?? null)
        : key === 'device' && opts.newDevice
          ? 'new'
          : key === 'homeserver'
            ? (opts.homeserver ?? null)
            : null,
  };
  const discoverHomeserver = auth.discoverHomeserver;
  const { fixture } = await render(LoginPage, {
    providers: [
      provideHostCapabilities(),
      MockProvider(AuthService, auth),
      {
        provide: AUTHENTICATION_HOMESERVER_DISCOVERY,
        useValue: {
          discover: (input: string) =>
            (discoverHomeserver?.(input) ?? of(`https://${input}`)).pipe(
              map((baseUrl) => ({ domain: input, baseUrl })),
            ),
        },
      },
      MockProvider(RegistrationService, {
        getAvailability: vi.fn(() => of('unknown' as const)),
      }),
      MockProvider(Router, {
        // routerLink builds its href and watches events through the router.
        events: EMPTY,
        createUrlTree: (commands: unknown[], extras?: UrlCreationOptions) =>
          new DefaultUrlSerializer().parse(
            `${(commands as string[]).join('/')}?${new URLSearchParams(
              extras?.queryParams as Record<string, string>,
            )}`,
          ),
        serializeUrl: (tree: UrlTree) =>
          new DefaultUrlSerializer().serialize(tree),
        currentNavigation: () =>
          opts.navigationState
            ? { extras: { state: opts.navigationState } }
            : null,
      } as unknown as Partial<Router>),
      MockProvider(SignInRedirectService, {
        startSso: vi.fn(() => of(undefined)),
        startOidc: vi.fn(() => of(undefined)),
        ssoAvailable: vi.fn(() => true),
        ...opts.redirect,
      }),
      MockProvider(OidcStateStore, {
        save: vi.fn().mockResolvedValue(undefined),
        peek: vi.fn().mockResolvedValue({}),
        ...opts.oidcStore,
      }),
      MockProvider(SessionStorageService, {
        record: vi.fn(() => of(opts.record ?? null) as never),
        reusableDeviceId: vi.fn((record: { deviceId: string }) =>
          of(
            opts.reusableDevice === undefined
              ? record.deviceId
              : opts.reusableDevice,
          ),
        ),
        list: vi.fn(() =>
          opts.listFails
            ? throwError(() => new Error('registry unreadable'))
            : (of(opts.stored ?? []) as never),
        ),
        clearAll: vi.fn(() => of([]) as never),
      }),
      MockProvider(TrnAlertService, {
        prompt$: vi.fn(() => of(opts.typed ?? null)),
      }),
      MockProvider(AccountRuntimeService, {
        hasActiveAccount: signal(opts.liveAccount ?? false).asReadonly(),
        resetInstallation: vi.fn(() =>
          of(
            (opts.report?.blocked.length ?? 0) +
              (opts.report?.failed.length ?? 0) >
              0
              ? ({
                  kind: 'partial-cleanup' as const,
                  issues: [
                    {
                      scope: 'indexed-db' as const,
                      recovery: 'restart-application' as const,
                    },
                  ],
                } as const)
              : ({ kind: 'ready' as const } as const),
          ),
        ),
      }),
      MockProvider(AppRestartService, { restart: vi.fn() }),
      MockProvider(QrSignInAvailability, {
        supports: vi.fn(() => of(opts.qrSupported ?? false)),
      }),
      MockProvider(QrSignInService, {
        signInByShowingCode: vi.fn(() => opts.qrFlow ?? NEVER),
      }),
      MockProvider(QrCodeService),
      ...(opts.bugReport
        ? [{ provide: BUG_REPORT_LAUNCHER, useValue: opts.bugReport }]
        : []),
      ...(opts.deleted
        ? [
            {
              provide: ACCOUNT_DELETION_LAUNCHER,
              useValue: {
                deletedNotice:
                  typeof opts.deleted === 'string'
                    ? signal(opts.deleted).asReadonly()
                    : opts.deleted.asReadonly(),
                dismissDeletedNotice: vi.fn(),
              },
            },
          ]
        : []),
      {
        provide: ACCOUNT_REMOVAL_LAUNCHER,
        useValue: {
          remove: vi.fn(() => opts.removal ?? of({ kind: 'kept' as const })),
        },
      },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap } } },
    ],
  });
  return {
    fixture,
    cmp: fixture.componentInstance,
    router: TestBed.inject(Router),
    redirect: TestBed.inject(SignInRedirectService),
    oidcStore: TestBed.inject(OidcStateStore),
    alert: TestBed.inject(TrnAlertService),
    reset: TestBed.inject(AccountRuntimeService),
    restart: TestBed.inject(AppRestartService),
    removal: TestBed.inject(ACCOUNT_REMOVAL_LAUNCHER),
  };
}

describe('LoginPage', () => {
  it('renders the homeserver through the public field contract', async () => {
    const { fixture } = await renderLogin(
      {} as unknown as Partial<AuthService>,
    );
    const root = fixture.nativeElement as HTMLElement;
    const field = root.querySelector('trn-field');
    const label = field?.querySelector('label');
    const input = field?.querySelector('input');

    expect(label?.htmlFor).toBe('homeserver');
    expect(input?.id).toBe('homeserver');
    expect(label?.textContent?.trim()).toBe('Homeserver');
    expect(label?.getAttribute('data-emphasis')).toBe('strong');
  });

  it('reveals the password from a toggle inside the password field', async () => {
    const { fixture, cmp } = await renderLogin(
      {} as unknown as Partial<AuthService>,
    );
    cmp.baseUrl.set('https://hs.example');
    cmp.passwordSupported.set(true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('#password');
    const toggle = root.querySelector<HTMLButtonElement>(
      'trn-password-input button',
    );

    expect(input?.parentElement?.localName).toBe('trn-password-input');
    expect(input?.type).toBe('password');
    expect(toggle?.getAttribute('aria-label')).toBe('Show password');

    fireEvent.click(toggle as HTMLButtonElement);
    fixture.detectChanges();

    expect(input?.type).toBe('text');
    expect(toggle?.getAttribute('aria-label')).toBe('Hide password');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  });

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

  it('does not start a second discovery when Continue is pressed while one is running', async () => {
    const discoverHomeserver = vi.fn(() => NEVER);
    const { fixture } = await renderLogin({
      discoverHomeserver,
    } as unknown as Partial<AuthService>);
    const button = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLButtonElement>('.login-card__submit');

    button?.click();
    fixture.detectChanges();
    button?.click();

    expect(discoverHomeserver).toHaveBeenCalledTimes(1);
  });

  it('shows legacy registration only after its side-effect-free probe reports open', async () => {
    const getAvailability = vi.fn(() => of('open' as const));
    const { fixture, cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of(['m.login.password'])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
    } as unknown as Partial<AuthService>);
    vi.mocked(
      TestBed.inject(RegistrationService).getAvailability,
    ).mockImplementation(getAvailability);

    cmp.discover();
    await fixture.whenStable();

    expect(getAvailability).toHaveBeenCalledWith('https://hs.example');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="password-register"]',
      ),
    ).not.toBeNull();
  });

  it('does not probe legacy registration when delegated OIDC owns signup', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of(['m.login.password'])),
      getDelegatedAuthConfig: vi.fn(() => of({ issuer: 'https://op' })),
    } as unknown as Partial<AuthService>);
    const getAvailability = vi.mocked(
      TestBed.inject(RegistrationService).getAvailability,
    );

    cmp.discover();

    expect(getAvailability).not.toHaveBeenCalled();
    expect(cmp.registrationAvailability()).toBe('unknown');
  });

  it('carries the selected homeserver and add-account mode into registration', async () => {
    const { cmp, router } = await renderLogin(
      {} as unknown as Partial<AuthService>,
      { add: true },
    );
    cmp.registrationAvailability.set('open');
    cmp.homeserverForm.homeserver().value.set('example.org');

    cmp.startRegistration();

    expect(router.navigate).toHaveBeenCalledWith(['/register'], {
      queryParams: { homeserver: 'example.org', add: '' },
    });
  });

  describe("where this app cannot offer the homeserver's SSO (Android)", () => {
    const ANDROID_SSO_NOTICE =
      "This server's single sign-on isn't supported in the Android app yet. Sign in on the web or desktop app.";
    const OTHER_SSO_NOTICE =
      "This server's single sign-on isn't available in this app. Sign in on the web or desktop app.";

    beforeEach(() => (platform.android = true));
    afterEach(() => (platform.android = false));

    async function discoverWith(flows: string[]) {
      const rendered = await renderLogin(
        {
          discoverHomeserver: vi.fn(() => of('https://hs.example')),
          getSupportedFlows: vi.fn(() => of(flows)),
          getDelegatedAuthConfig: vi.fn(() => of(null)),
        } as unknown as Partial<AuthService>,
        { redirect: { ssoAvailable: vi.fn(() => false) } },
      );
      rendered.cmp.discover();
      rendered.fixture.detectChanges();
      return rendered;
    }

    it('hides Continue with SSO and says why, instead of the generic error', async () => {
      const { cmp, fixture } = await discoverWith(['m.login.sso']);
      const root = fixture.nativeElement as HTMLElement;

      expect(cmp.ssoSupported()).toBe(false);
      expect(root.textContent).not.toContain('Continue with SSO');
      expect(
        root
          .querySelector('[data-testid="sso-unavailable"]')
          ?.textContent?.trim(),
      ).toBe(ANDROID_SSO_NOTICE);
      expect(cmp.error()).toBeNull();
    });

    it('names no platform it is not running on', async () => {
      platform.android = false;
      const { fixture } = await discoverWith(['m.login.sso']);

      expect(
        (fixture.nativeElement as HTMLElement)
          .querySelector('[data-testid="sso-unavailable"]')
          ?.textContent?.trim(),
      ).toBe(OTHER_SSO_NOTICE);
    });

    it('keeps password sign-in beside the notice', async () => {
      const { cmp, fixture } = await discoverWith([
        'm.login.password',
        'm.login.sso',
      ]);
      const root = fixture.nativeElement as HTMLElement;

      expect(cmp.passwordSupported()).toBe(true);
      expect(root.querySelector('#password')).not.toBeNull();
      expect(
        root.querySelector('[data-testid="sso-unavailable"]'),
      ).not.toBeNull();
    });

    it('never starts SSO', async () => {
      const { cmp, redirect } = await discoverWith(['m.login.sso']);

      cmp.startSso();

      expect(redirect.startSso).not.toHaveBeenCalled();
    });

    it('says nothing on a homeserver without SSO', async () => {
      const { fixture } = await discoverWith(['m.login.password']);

      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="sso-unavailable"]',
        ),
      ).toBeNull();
    });
  });

  it('shows Continue with SSO where this app can offer it (web, desktop, iOS)', async () => {
    const { cmp, fixture } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of(['m.login.sso'])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
    } as unknown as Partial<AuthService>);

    cmp.discover();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Continue with SSO');
    expect(root.querySelector('[data-testid="sso-unavailable"]')).toBeNull();
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

  it('explains a failed homeserver discovery next to the homeserver field', async () => {
    const { cmp, fixture } = await renderLogin({
      discoverHomeserver: vi.fn(() =>
        throwError(() => new Error('Invalid homeserver discovery response')),
      ),
      getSupportedFlows: vi.fn(),
    } as unknown as Partial<AuthService>);

    cmp.discover();
    fixture.detectChanges();

    expect(cmp.baseUrl()).toBeNull();
    expect(cmp.homeserverError()).toBe(
      "We couldn't find a homeserver at that address. Check it and try again.",
    );
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('#homeserver');
    const described = root.querySelector(
      `#${input?.getAttribute('aria-describedby')}`,
    );
    expect(described?.textContent).toContain("We couldn't find a homeserver");
    expect(root.querySelector('trn-field')?.contains(described ?? null)).toBe(
      true,
    );
  });

  it('says the homeserver is unreachable when discovery hits a network error', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() =>
        throwError(() => new ConnectionError('fetch failed')),
      ),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.homeserverError()).toBe('Check your connection and try again.');
  });

  it('logs in with a password and navigates to rooms', async () => {
    const loginWithPassword = vi.fn(() => of(READY_OUTCOME));
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
      undefined, // and no expected user
      undefined, // nor a discovered server: the base URL was set directly
    );
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('passes the server the person entered on to a password sign-in', async () => {
    const loginWithPassword = vi.fn(() => of(READY_OUTCOME));
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://chat.provider.net')),
      getSupportedFlows: vi.fn(() => of(['m.login.password'])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
      loginWithPassword,
    } as unknown as Partial<AuthService>);
    cmp.homeserverForm.homeserver().value.set('example.com');
    cmp.discover();
    cmp.credentialsForm.username().value.set('x');
    cmp.credentialsForm.password().value.set('hunter2');

    cmp.loginPassword();

    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://chat.provider.net',
      'x',
      'hunter2',
      'replace',
      undefined,
      undefined,
      'example.com',
    );
  });

  it('logs in in add mode when /login?add is set', async () => {
    const loginWithPassword = vi.fn(() => of(READY_OUTCOME));
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
      undefined,
      undefined,
    );
  });

  it('re-auth mode prefills the account and reuses its device (add + deviceId)', async () => {
    const loginWithPassword = vi.fn(() => of(READY_OUTCOME));
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
      '@bob:hs', // the callback must return as this account
      undefined,
    );
  });

  it('re-auth signs in as a new device when the stored keys can no longer be unlocked', async () => {
    const loginWithPassword = vi.fn(() => of(READY_OUTCOME));
    const { cmp } = await renderLogin(
      {
        loginWithPassword,
        getSupportedFlows: vi.fn(() => of(['m.login.password'])),
        getDelegatedAuthConfig: vi.fn(() => of(null)),
      } as unknown as Partial<AuthService>,
      {
        reauth: '@bob:hs',
        record: {
          baseUrl: 'https://hs.example',
          userId: '@bob:hs',
          deviceId: 'OLDDEV',
          cryptoPrefix: 'trinity-crypto:@bob:hs:OLDDEV',
          cryptoStoreKeyed: true,
        },
        reusableDevice: null,
      },
    );

    cmp.credentialsForm.password().value.set('hunter2');
    cmp.loginPassword();

    // No device id: the server makes a new device, which gets a new store and key. The
    // sign-in is still bound to the account being reconnected.
    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://hs.example',
      '@bob:hs',
      'hunter2',
      'add',
      undefined,
      '@bob:hs',
      undefined,
    );
  });

  it('re-auth asked to replace the store signs in as a new device', async () => {
    const loginWithPassword = vi.fn(() => of(READY_OUTCOME));
    const { cmp } = await renderLogin(
      {
        loginWithPassword,
        getSupportedFlows: vi.fn(() => of(['m.login.password'])),
        getDelegatedAuthConfig: vi.fn(() => of(null)),
      } as unknown as Partial<AuthService>,
      {
        reauth: '@bob:hs',
        newDevice: true,
        record: {
          baseUrl: 'https://hs.example',
          userId: '@bob:hs',
          deviceId: 'OLDDEV',
        },
      },
    );

    cmp.credentialsForm.password().value.set('hunter2');
    cmp.loginPassword();

    // A store without a key stays unencrypted on its own device; only a new one gets a key.
    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://hs.example',
      '@bob:hs',
      'hunter2',
      'add',
      undefined,
      '@bob:hs',
      undefined,
    );
  });

  it('says a deleted account has been deleted rather than calling the password wrong', async () => {
    const { cmp, fixture } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(
          () =>
            new MatrixError(
              { errcode: 'M_USER_DEACTIVATED', error: 'deactivated' },
              403,
            ),
        ),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');
    cmp.passwordSupported.set(true);

    cmp.loginPassword();
    fixture.detectChanges();

    expect(cmp.credentialsError()).toBe('This account has been deleted.');
  });

  describe('forgot password', () => {
    async function discovered(
      flows: string[],
      oidc: object | null,
      opts: Parameters<typeof renderLogin>[1] = {},
    ) {
      const rendered = await renderLogin(
        {
          discoverHomeserver: vi.fn(() => of('https://hs.example')),
          getSupportedFlows: vi.fn(() => of(flows)),
          getDelegatedAuthConfig: vi.fn(() => of(oidc)),
        } as unknown as Partial<AuthService>,
        opts,
      );
      rendered.cmp.homeserverForm.homeserver().value.set('hs.example');
      rendered.cmp.discover();
      rendered.fixture.detectChanges();
      return rendered.fixture.nativeElement.querySelector(
        '[data-testid="password-forgot"]',
      ) as HTMLAnchorElement | null;
    }

    it('links a password server to the reset page with the chosen server', async () => {
      const link = await discovered(['m.login.password'], null);

      expect(link?.textContent?.trim()).toBe('Forgot password?');
      expect(link?.getAttribute('href')).toBe(
        '/reset-password?homeserver=hs.example',
      );
    });

    it('carries add mode to the reset page', async () => {
      const link = await discovered(['m.login.password'], null, { add: true });

      expect(link?.getAttribute('href')).toBe(
        '/reset-password?homeserver=hs.example&add=',
      );
    });

    it('offers no link on an SSO-only server', async () => {
      expect(await discovered(['m.login.sso'], null)).toBeNull();
    });

    it('offers no link on an OIDC server', async () => {
      const oidc = { issuer: 'https://auth.example' };
      expect(await discovered(['m.login.password'], oidc)).toBeNull();
    });

    it('offers no link when re-authenticating', async () => {
      const { fixture } = await renderLogin(
        {
          getSupportedFlows: vi.fn(() => of(['m.login.password'])),
          getDelegatedAuthConfig: vi.fn(() => of(null)),
        } as unknown as Partial<AuthService>,
        {
          reauth: '@bob:hs',
          record: { baseUrl: 'https://hs.example', userId: '@bob:hs' },
        },
      );
      await fixture.whenStable();
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="password-forgot"]'),
      ).toBeNull();
    });
  });

  describe('?homeserver=', () => {
    function homeserverValue(fixture: { nativeElement: HTMLElement }): string {
      return (
        fixture.nativeElement.querySelector(
          'input[name="homeserver"], #homeserver, input',
        ) as HTMLInputElement
      ).value;
    }

    it('prefills the server it is given without looking it up', async () => {
      const discoverHomeserver = vi.fn(() => of('https://hs.example'));
      const { cmp, fixture } = await renderLogin(
        { discoverHomeserver } as unknown as Partial<AuthService>,
        { homeserver: 'hs.example' },
      );
      fixture.detectChanges();

      expect(cmp.homeserverForm.homeserver().value()).toBe('hs.example');
      expect(homeserverValue(fixture)).toBe('hs.example');
      expect(discoverHomeserver).not.toHaveBeenCalled();
    });

    it('keeps matrix.org without one', async () => {
      const { cmp } = await renderLogin({});

      expect(cmp.homeserverForm.homeserver().value()).toBe('matrix.org');
    });
  });

  describe('after a password reset', () => {
    it('opens with a focused notice that the password was changed', async () => {
      const { fixture } = await renderLogin(
        {},
        { navigationState: { passwordReset: true } },
      );
      await fixture.whenStable();

      const notice = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="login-password-reset"]',
      );
      expect(notice?.textContent?.trim()).toBe(
        'Your password was changed. Sign in with your new password.',
      );
      expect(document.activeElement).toBe(notice);
    });

    it('shows no notice on a fresh load', async () => {
      const { fixture } = await renderLogin({});
      await fixture.whenStable();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="login-password-reset"]',
        ),
      ).toBeNull();
    });
  });

  it('opens with a focused notice naming the account that was deleted', async () => {
    const { fixture } = await renderLogin(
      {},
      { deleted: '@alice:example.org' },
    );
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    const notice = root.querySelector<HTMLElement>(
      '[data-testid="login-account-deleted"]',
    );
    expect(notice?.textContent).toContain(
      'Your account @alice:example.org was deleted.',
    );
    expect(notice?.tagName).toBe('H2');
    expect(document.activeElement).toBe(notice);
  });

  it('shows the notice when the deletion settles after sign-in has opened', async () => {
    const notice = signal<string | null>(null);
    const { fixture } = await renderLogin({}, { deleted: notice });
    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('[data-testid="login-account-deleted"]'),
    ).toBeNull();

    notice.set('@alice:example.org');
    await fixture.whenStable();

    expect(
      root.querySelector('[data-testid="login-account-deleted"]')?.textContent,
    ).toContain('Your account @alice:example.org was deleted.');
  });

  it('shows no deletion notice on an ordinary visit', async () => {
    const { fixture } = await renderLogin({});

    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="login-account-deleted"]',
      ),
    ).toBeNull();
  });

  it('reads a wrong password in plain language, linked to the password field', async () => {
    const { cmp, router, fixture } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(
          () =>
            new MatrixError(
              { errcode: 'M_FORBIDDEN', error: 'Invalid username or password' },
              403,
              'https://hs.example/_matrix/client/v3/login',
            ),
        ),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');
    cmp.passwordSupported.set(true);

    cmp.loginPassword();
    fixture.detectChanges();

    expect(cmp.credentialsError()).toBe('Incorrect username or password.');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('#password');
    const described = root.querySelector(
      `#${input?.getAttribute('aria-describedby')}`,
    );
    expect(described?.textContent).toContain('Incorrect username or password.');
    expect(root.textContent).not.toContain('M_FORBIDDEN');
  });

  it('says the homeserver is unreachable when password sign-in hits a network error', async () => {
    const { cmp } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(() => new ConnectionError('fetch failed')),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toBe('Check your connection and try again.');
  });

  it('never shows an unrecognised sign-in error verbatim', async () => {
    const { cmp } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(
          () => new Error('MatrixError: [500] boom (https://hs/login)'),
        ),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toBe("We couldn't sign you in. Try again.");
  });

  it('explains a sign-in cancelled to keep a stored account’s keys', async () => {
    const { cmp, router } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(() => new NewDeviceSignInCancelledError('@me:hs')),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toBe(
      'Sign-in cancelled. @me:hs stays on this device with its keys.',
    );
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('explains a sign-in declined at the keyring question', async () => {
    const { cmp, router } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(() => new UnprotectedStorageDeclinedError()),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toBe(
      'Sign-in cancelled. Nothing was stored on this device.',
    );
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('surfaces an expected Account Runtime failure without navigating', async () => {
    const { cmp, router } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        of({
          kind: 'failed' as const,
          accountId: '@me:hs',
          placement: 'active' as const,
          failure: 'local-state-unavailable' as const,
        }),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toMatch(/local account storage/i);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('names the stored account and its server when a sign-in is refused', async () => {
    // A sign-in for a user id saved under another server is refused. The refusal is an
    // ordinary sign-in error beside the password field, not a crash or a silent no-op.
    const { cmp, router, fixture } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        of({
          kind: 'failed' as const,
          accountId: '@alice:example.org',
          placement: 'active' as const,
          failure: 'homeserver-mismatch' as const,
          storedBaseUrl: 'https://example.org',
        }),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://other-server.example');
    cmp.passwordSupported.set(true);

    cmp.loginPassword();
    fixture.detectChanges();

    expect(cmp.credentialsError()).toContain(
      '@alice:example.org is already signed in through https://example.org',
    );
    // The way out matches the menu item that removes an account.
    expect(cmp.credentialsError()).toContain(
      'Remove that account from this device first',
    );
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('#password');
    const described = root.querySelector(
      `#${input?.getAttribute('aria-describedby')}`,
    );
    expect(described?.textContent).toContain(
      '@alice:example.org is already signed in through https://example.org',
    );
  });

  it('explains a password re-auth that came back as a different account', async () => {
    const { cmp, router } = await renderLogin({
      loginWithPassword: vi.fn(() =>
        throwError(
          () => new ReauthAccountMismatchError('@bob:hs', '@alice:hs'),
        ),
      ),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toMatch(/@bob:hs.*@alice:hs/);
    expect(cmp.credentialsError()).not.toBe(
      "We couldn't sign you in. Try again.",
    );
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('explains a sign-in refused for the account the server returned', async () => {
    const error = new UnacceptableAccountError(
      'other-server',
      '@bob:other.example',
    );
    const { cmp, router } = await renderLogin({
      loginWithPassword: vi.fn(() => throwError(() => error)),
    } as unknown as Partial<AuthService>);
    cmp.baseUrl.set('https://hs.example');

    cmp.loginPassword();

    expect(cmp.credentialsError()).toBe(error.message);
    expect(cmp.credentialsError()).toContain('@bob:other.example');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('starts SSO through the redirect service under the busy state', async () => {
    const handoff = new Subject<void>();
    const { cmp, redirect } = await renderLogin(
      {} as unknown as Partial<AuthService>,
      { redirect: { startSso: vi.fn(() => handoff) } },
    );
    cmp.baseUrl.set('https://hs.example');

    cmp.startSso();

    expect(redirect.startSso).toHaveBeenCalledWith(
      'https://hs.example',
      'replace',
      undefined,
      undefined,
    );
    expect(cmp.busy()).toBe(true);

    handoff.complete();
    expect(cmp.busy()).toBe(false);
  });

  it('re-auth SSO is add mode bound to the existing device', async () => {
    const { cmp, redirect } = await renderLogin(
      {
        getSupportedFlows: vi.fn(() => of(['m.login.sso'])),
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

    cmp.startSso();

    expect(redirect.startSso).toHaveBeenCalledWith(
      'https://hs.example',
      'add',
      'OLDDEV',
      '@bob:hs',
    );
  });

  it('shows a failed SSO handoff as a page error and clears busy', async () => {
    const { cmp } = await renderLogin({} as unknown as Partial<AuthService>, {
      redirect: {
        startSso: vi.fn(() => throwError(() => new Error('write failed'))),
      },
    });
    cmp.baseUrl.set('https://hs.example');

    cmp.startSso();

    expect(cmp.error()).toBe("We couldn't sign you in. Try again.");
    expect(cmp.busy()).toBe(false);
  });

  describe('clear all data', () => {
    it('erases and restarts once the word is typed', async () => {
      const { cmp, reset, restart } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: 'RESET TRINITY' },
      );

      await cmp.clearAllData();

      expect(reset.resetInstallation).toHaveBeenCalled();
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

    it('keeps the danger action ghost instead of making it the primary surface', async () => {
      // The public danger/ghost recipe owns the red label and tint. A filled destructive
      // surface would out-weigh signing in, which remains the task this screen is for.
      // Browser coverage measures the actual themed result; jsdom can only pin the recipe
      // class boundary here.
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

      expect(reset.resetInstallation).not.toHaveBeenCalled();
      expect(restart.restart).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/Type RESET TRINITY exactly/);
    });

    it('erases nothing and stays quiet when cancelled', async () => {
      const { cmp, reset } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: null },
      );

      await cmp.clearAllData();

      expect(reset.resetInstallation).not.toHaveBeenCalled();
      expect(cmp.error()).toBeNull(); // they changed their mind; nagging would be rude
    });

    it('retains partial residue for a safe retry instead of claiming success', async () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { cmp, restart } = await renderLogin(
          {} as unknown as Partial<AuthService>,
          {
            typed: 'RESET TRINITY',
            report: {
              blocked: ['matrix-js-sdk:trinity-sync:@a:hs'],
              failed: ['other-db'],
            },
          },
        );

        await cmp.clearAllData();

        expect(restart.restart).not.toHaveBeenCalled();
        expect(cmp.erasing()).toBe(false);
        expect(cmp.error()).toMatch(/Restart Trinity/i);
        expect(warn).toHaveBeenCalledWith(expect.any(String), [
          { scope: 'indexed-db', recovery: 'restart-application' },
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('@a:hs');
      } finally {
        warn.mockRestore();
      }
    });

    it('does not restart when another Account transition blocks the reset', async () => {
      const { cmp, reset, restart } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: 'RESET TRINITY' },
      );
      vi.mocked(reset.resetInstallation).mockReturnValue(
        of({
          kind: 'transition-in-progress',
          operation: 'signing-out-account',
        }),
      );

      await cmp.clearAllData();

      expect(restart.restart).not.toHaveBeenCalled();
      expect(cmp.erasing()).toBe(false);
      expect(cmp.error()).toMatch(/in progress/i);
    });

    it('does not call an observation timeout cancellation or restart', async () => {
      const { cmp, reset, restart } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { typed: 'RESET TRINITY' },
      );
      vi.mocked(reset.resetInstallation).mockReturnValue(
        of({
          kind: 'uncertain-cleanup',
          issues: [],
          pending: [{ scope: 'indexed-db', recovery: 'restart-application' }],
        }),
      );

      await cmp.clearAllData();

      expect(restart.restart).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/does not cancel/i);
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

      const message = vi.mocked(alert.prompt$).mock.calls[0][0].message ?? '';
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

      const message = vi.mocked(alert.prompt$).mock.calls[0][0].message ?? '';
      expect(message).toContain('@a:hs');
      expect(message).toContain('@b:hs');
    });
  });

  describe('OIDC (next-gen auth)', () => {
    /** Provider metadata with every endpoint on `origin`. */
    function providerAt(origin: string) {
      return {
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        prompt_values_supported: ['create'],
      };
    }

    /** An OIDC-native login page: discovered homeserver + provider metadata. */
    async function renderOidcReady(
      redirect?: Partial<SignInRedirectService>,
      metadata: object = providerAt('https://account.hs.example'),
    ) {
      const rendered = await renderLogin(
        {} as unknown as Partial<AuthService>,
        redirect ? { redirect } : {},
      );
      rendered.cmp.baseUrl.set('https://hs.example');
      rendered.cmp.oidcMetadata.set(metadata as never);
      rendered.fixture.detectChanges();
      return rendered;
    }

    function byTestId(
      fixture: { nativeElement: unknown },
      id: string,
    ): HTMLElement | null {
      return (fixture.nativeElement as HTMLElement).querySelector(
        `[data-testid="${id}"]`,
      );
    }

    describe('with a provider on another site', () => {
      const OTHER_SITE = providerAt('https://auth.provider.test');
      const NOTICE =
        'You’ll sign in with auth.provider.test, which isn’t part of hs.example. ' +
        'Continue only if you expect hs.example to use this provider.';

      it('asks before redirecting', async () => {
        const { fixture, redirect } = await renderOidcReady(
          undefined,
          OTHER_SITE,
        );

        fireEvent.click(byTestId(fixture, 'oidc-continue')!);
        fixture.detectChanges();

        expect(redirect.startOidc).not.toHaveBeenCalled();
        const notice = byTestId(fixture, 'oidc-other-site');
        expect(notice?.textContent?.replace(/\s+/g, ' ').trim()).toBe(NOTICE);
        expect(byTestId(fixture, 'oidc-continue')).toBeNull();
      });

      it('redirects with the chosen action once the user continues', async () => {
        const { fixture, redirect } = await renderOidcReady(
          undefined,
          OTHER_SITE,
        );

        fireEvent.click(byTestId(fixture, 'oidc-register')!);
        fixture.detectChanges();
        fireEvent.click(byTestId(fixture, 'oidc-other-site-continue')!);
        fixture.detectChanges();

        expect(redirect.startOidc).toHaveBeenCalledTimes(1);
        expect(redirect.startOidc).toHaveBeenCalledWith(
          expect.objectContaining({ prompt: 'create' }),
        );
        expect(byTestId(fixture, 'oidc-other-site')).toBeNull();
      });

      it('stays on the page when the user cancels', async () => {
        const { fixture, redirect } = await renderOidcReady(
          undefined,
          OTHER_SITE,
        );

        fireEvent.click(byTestId(fixture, 'oidc-continue')!);
        fixture.detectChanges();
        fireEvent.click(byTestId(fixture, 'oidc-other-site-cancel')!);
        fixture.detectChanges();

        expect(redirect.startOidc).not.toHaveBeenCalled();
        expect(byTestId(fixture, 'oidc-other-site')).toBeNull();
        expect(byTestId(fixture, 'oidc-continue')).not.toBeNull();
      });
    });

    it.each([
      [
        'the sign-in page',
        {
          authorization_endpoint: 'https://login.provider.test/authorize',
        },
        'login.provider.test',
      ],
      [
        'the token endpoint',
        { token_endpoint: 'https://tokens.provider.test/token' },
        'tokens.provider.test',
      ],
      [
        'the revocation endpoint',
        { revocation_endpoint: 'https://revoke.provider.test/revoke' },
        'revoke.provider.test',
      ],
    ])(
      'asks when the issuer is part of the server but %s is not',
      async (_, endpoints, named) => {
        const { fixture, redirect } = await renderOidcReady(undefined, {
          ...providerAt('https://account.hs.example'),
          ...endpoints,
        });

        fireEvent.click(byTestId(fixture, 'oidc-continue')!);
        fixture.detectChanges();

        expect(redirect.startOidc).not.toHaveBeenCalled();
        expect(byTestId(fixture, 'oidc-other-site')?.textContent).toContain(
          `You’ll sign in with ${named}, which isn’t part of hs.example.`,
        );
      },
    );

    it('treats a provider under the server name entered as part of the server', async () => {
      const { cmp, fixture, redirect } = await renderLogin({
        discoverHomeserver: vi.fn(() => of('https://matrix-client.matrix.org')),
        getSupportedFlows: vi.fn(() => of([])),
        getDelegatedAuthConfig: vi.fn(() =>
          of(providerAt('https://account.matrix.org')),
        ),
      } as unknown as Partial<AuthService>);
      cmp.homeserverForm.homeserver().value.set('matrix.org');
      cmp.discover();
      fixture.detectChanges();

      fireEvent.click(byTestId(fixture, 'oidc-continue')!);
      fixture.detectChanges();

      expect(redirect.startOidc).toHaveBeenCalledTimes(1);
      expect(byTestId(fixture, 'oidc-other-site')).toBeNull();
    });

    it('asks for a provider on a sibling host of the server entered', async () => {
      const { cmp, fixture, redirect } = await renderLogin({
        discoverHomeserver: vi.fn(() => of('https://evil.ems.host')),
        getSupportedFlows: vi.fn(() => of([])),
        getDelegatedAuthConfig: vi.fn(() =>
          of(providerAt('https://auth.ems.host')),
        ),
      } as unknown as Partial<AuthService>);
      cmp.homeserverForm.homeserver().value.set('evil.ems.host');
      cmp.discover();
      fixture.detectChanges();

      fireEvent.click(byTestId(fixture, 'oidc-continue')!);
      fixture.detectChanges();

      expect(redirect.startOidc).not.toHaveBeenCalled();
      expect(byTestId(fixture, 'oidc-other-site')).not.toBeNull();
    });

    it('redirects at once to a provider on the homeserver’s own site', async () => {
      const { fixture, redirect } = await renderOidcReady();

      fireEvent.click(byTestId(fixture, 'oidc-continue')!);
      fixture.detectChanges();

      expect(redirect.startOidc).toHaveBeenCalledTimes(1);
      expect(byTestId(fixture, 'oidc-other-site')).toBeNull();
    });

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

    it('hands the discovered provider to the redirect service, under the busy state', async () => {
      const handoff = new Subject<void>();
      const { cmp, redirect } = await renderOidcReady({
        startOidc: vi.fn(() => handoff),
      });

      cmp.startOidc('create');

      expect(redirect.startOidc).toHaveBeenCalledWith({
        baseUrl: 'https://hs.example',
        metadata: providerAt('https://account.hs.example'),
        mode: 'replace',
        prompt: 'create',
        expectedUserId: null,
      });
      expect(cmp.busy()).toBe(true);

      handoff.complete();
      expect(cmp.busy()).toBe(false);
    });

    describe('re-auth of an account on a server that delegates to another host', () => {
      const PINNED = {
        issuer: 'https://account.matrix.org/',
        clientId: 'c1',
        redirectUri: 'https://app/sso-callback',
        tokenEndpoint: 'https://account.matrix.org/token',
        revocationEndpoint: 'https://account.matrix.org/revoke',
      };

      async function reauth(oidc: object, metadata: object) {
        const rendered = await renderLogin(
          {
            getDelegatedAuthConfig: vi.fn(() => of(metadata as never)),
            getSupportedFlows: vi.fn(() => of([])),
          } as unknown as Partial<AuthService>,
          {
            reauth: '@bob:matrix.org',
            record: {
              baseUrl: 'https://matrix-client.matrix.org',
              userId: '@bob:matrix.org',
              deviceId: 'OLDDEV',
              oidc,
            },
          },
        );
        rendered.fixture.detectChanges();
        fireEvent.click(byTestId(rendered.fixture, 'oidc-continue')!);
        rendered.fixture.detectChanges();
        return rendered;
      }

      it('redirects at once to the provider the account signed in with', async () => {
        const { fixture, redirect } = await reauth(
          PINNED,
          providerAt('https://account.matrix.org'),
        );

        expect(redirect.startOidc).toHaveBeenCalledTimes(1);
        expect(byTestId(fixture, 'oidc-other-site')).toBeNull();
      });

      it.each([
        [
          'the provider changed',
          PINNED,
          {
            ...providerAt('https://account.matrix.org'),
            token_endpoint: 'https://tokens.example/token',
          },
        ],
        [
          'the account has no endpoints saved',
          {
            issuer: PINNED.issuer,
            clientId: 'c1',
            redirectUri: PINNED.redirectUri,
          },
          providerAt('https://account.matrix.org'),
        ],
      ])('asks when %s', async (_, oidc, metadata) => {
        const { fixture, redirect } = await reauth(oidc, metadata);

        expect(redirect.startOidc).not.toHaveBeenCalled();
        expect(byTestId(fixture, 'oidc-other-site')).not.toBeNull();
      });
    });

    it('re-auth reuses the stored device and expects the same account back', async () => {
      const { cmp, redirect } = await renderLogin(
        {
          getDelegatedAuthConfig: vi.fn(() =>
            of(providerAt('https://account.hs.example') as never),
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

      cmp.startOidc();

      expect(redirect.startOidc).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'add',
          deviceId: 'OLDDEV',
          expectedUserId: '@bob:hs',
        }),
      );
    });

    it('shows a failed redirect as a page error and clears busy', async () => {
      const { cmp } = await renderOidcReady({
        startOidc: vi.fn(() => throwError(() => new Error('raw sdk failure'))),
      });

      cmp.startOidc();

      expect(cmp.error()).toBe("We couldn't sign you in. Try again.");
      expect(cmp.busy()).toBe(false);
    });

    it('does nothing without a discovered provider', async () => {
      const { cmp, redirect } = await renderLogin(
        {} as unknown as Partial<AuthService>,
      );
      cmp.baseUrl.set('https://hs.example');

      cmp.startOidc();

      expect(redirect.startOidc).not.toHaveBeenCalled();
    });
  });

  describe('Cancel', () => {
    const AUTH = {
      getSupportedFlows: vi.fn(() => of(['m.login.password'])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
    } as unknown as Partial<AuthService>;
    const RECORD = {
      baseUrl: 'https://hs.example',
      userId: '@bob:hs',
      deviceId: 'OLDDEV',
    };

    function cancelButton(
      fixture: Awaited<ReturnType<typeof renderLogin>>['fixture'],
    ): HTMLButtonElement | null {
      fixture.detectChanges();
      return fixture.nativeElement.querySelector('[data-testid="cancel-add"]');
    }

    it('is hidden on a re-auth with no live account, where the guard would send it back', async () => {
      const { fixture } = await renderLogin(AUTH, {
        reauth: '@bob:hs',
        record: RECORD,
      });

      expect(cancelButton(fixture)).toBeNull();
    });

    it('stays on a re-auth with another account live', async () => {
      const { fixture } = await renderLogin(AUTH, {
        reauth: '@bob:hs',
        record: RECORD,
        liveAccount: true,
      });

      expect(cancelButton(fixture)).not.toBeNull();
    });

    it('stays in add mode', async () => {
      const { fixture } = await renderLogin(AUTH, { add: true });

      expect(cancelButton(fixture)).not.toBeNull();
    });
  });

  describe('a re-auth as a new device', () => {
    const NEW_DEVICE_COPY =
      'Sign in again to reconnect this account. This device will need to be verified again.';
    const RECORD = {
      baseUrl: 'https://hs.example',
      userId: '@bob:hs',
      deviceId: 'OLDDEV',
    };
    const subtitle = (
      fixture: Awaited<ReturnType<typeof renderLogin>>['fixture'],
    ): string => {
      fixture.detectChanges();
      return (fixture.nativeElement as HTMLElement)
        .querySelector('.login-card__subtitle')!
        .textContent!.replace(/\s+/g, ' ')
        .trim();
    };
    const passwordAuth = (outcome: unknown) =>
      ({
        getSupportedFlows: vi.fn(() => of(['m.login.password'])),
        getDelegatedAuthConfig: vi.fn(() => of(null)),
        loginWithPassword: vi.fn(() => of(outcome)),
      }) as unknown as Partial<AuthService>;
    const NO_KEYS = { kind: 'new-device-required', accountId: '@bob:hs' };

    it('shows that the device will need verifying on a new-device re-auth only', async () => {
      const auth = passwordAuth(READY_OUTCOME);
      const newDevice = await renderLogin(auth, {
        reauth: '@bob:hs',
        newDevice: true,
        record: RECORD,
      });
      expect(subtitle(newDevice.fixture)).toBe(NEW_DEVICE_COPY);
      TestBed.resetTestingModule();

      const sameDevice = await renderLogin(auth, {
        reauth: '@bob:hs',
        record: RECORD,
      });
      expect(subtitle(sameDevice.fixture)).toBe(
        'Sign in again to reconnect this account',
      );
      TestBed.resetTestingModule();

      // The parameter means nothing outside a re-auth.
      const plain = await renderLogin(auth, { newDevice: true });
      plain.cmp.baseUrl.set('https://hs.example');
      expect(subtitle(plain.fixture)).toBe('Sign in to your account');
    });

    it('sends the person to the new-device sign-in after a password re-auth', async () => {
      const auth = passwordAuth(NO_KEYS);
      const { fixture, cmp, router } = await renderLogin(auth, {
        reauth: '@bob:hs',
        record: RECORD,
      });
      const navigate = vi.spyOn(router, 'navigateByUrl');

      cmp.loginPassword();

      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        '/login?reauth=%40bob%3Ahs&device=new',
        { replaceUrl: true },
      );
      // The router keeps this page, so the page itself moves on to the new device.
      expect(subtitle(fixture)).toBe(NEW_DEVICE_COPY);
      cmp.loginPassword();
      expect(auth.loginWithPassword).toHaveBeenLastCalledWith(
        'https://hs.example',
        '@bob:hs',
        '',
        'add',
        undefined,
        '@bob:hs',
        undefined,
      );
    });

    it('opens the rooms after a sign-in that kept its device', async () => {
      const { cmp, router } = await renderLogin(passwordAuth(READY_OUTCOME), {
        reauth: '@bob:hs',
        record: RECORD,
      });
      const navigate = vi.spyOn(router, 'navigateByUrl');

      cmp.loginPassword();

      expect(navigate).toHaveBeenCalledExactlyOnceWith('/rooms', {
        replaceUrl: true,
      });
      expect(cmp.reauthAsNewDevice()).toBe(false);
    });
  });

  describe('removing the account from its re-auth', () => {
    const OIDC_RECORD = {
      baseUrl: 'https://hs.example',
      userId: '@bob:hs',
      deviceId: 'OLDDEV',
      oidc: { issuer: 'https://hs.example/', clientId: 'client' },
    };
    const OIDC_AUTH = {
      getSupportedFlows: vi.fn(() => of([])),
      getDelegatedAuthConfig: vi.fn(() => of(null)),
    } as unknown as Partial<AuthService>;

    function removeButton(
      fixture: Awaited<ReturnType<typeof renderLogin>>['fixture'],
    ): HTMLButtonElement | null {
      fixture.detectChanges();
      return fixture.nativeElement.querySelector(
        '[data-testid="remove-reauth-account"]',
      );
    }

    it('names the account on an OAuth re-auth, which has no username field', async () => {
      const { fixture } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
      });
      fixture.detectChanges();

      expect(
        fixture.nativeElement
          .querySelector('[data-testid="reauth-account"]')
          ?.textContent?.trim(),
      ).toBe('@bob:hs');
    });

    it('leaves a password re-auth to its username field', async () => {
      const { fixture } = await renderLogin(
        {
          getSupportedFlows: vi.fn(() => of(['m.login.password'])),
          getDelegatedAuthConfig: vi.fn(() => of(null)),
        } as unknown as Partial<AuthService>,
        { reauth: '@bob:hs', record: { ...OIDC_RECORD, oidc: undefined } },
      );
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="reauth-account"]'),
      ).toBeNull();
    });

    it('offers Remove this account on an OAuth re-auth', async () => {
      const { fixture } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
      });

      expect(removeButton(fixture)?.textContent?.trim()).toBe(
        'Remove this account',
      );
    });

    it('stays reachable while an unreachable homeserver keeps the page busy', async () => {
      const { fixture, cmp } = await renderLogin(
        {
          getSupportedFlows: vi.fn(() => NEVER),
          getDelegatedAuthConfig: vi.fn(() => NEVER),
        } as unknown as Partial<AuthService>,
        { reauth: '@bob:hs', record: OIDC_RECORD },
      );

      expect(cmp.busy()).toBe(true);
      expect(removeButton(fixture)?.disabled).toBe(false);
    });

    it('does not offer it for a password re-auth or a plain login', async () => {
      const auth = {
        getSupportedFlows: vi.fn(() => of(['m.login.password'])),
        getDelegatedAuthConfig: vi.fn(() => of(null)),
      } as unknown as Partial<AuthService>;
      const reauth = await renderLogin(auth, {
        reauth: '@bob:hs',
        record: { ...OIDC_RECORD, oidc: undefined },
      });
      expect(removeButton(reauth.fixture)).toBeNull();
      TestBed.resetTestingModule();

      const plain = await renderLogin(auth);
      expect(removeButton(plain.fixture)).toBeNull();
    });

    it('removes through the account removal flow', async () => {
      const { fixture, removal, restart } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
      });

      removeButton(fixture)?.click();

      expect(removal.remove).toHaveBeenCalledExactlyOnceWith('@bob:hs');
      expect(restart.restart).not.toHaveBeenCalled();
      // Kept: nothing is running, so it can be pressed again.
      expect(removeButton(fixture)?.disabled).toBe(false);
    });

    it('stays disabled while the removal runs on in the background', async () => {
      const { fixture, cmp } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
        removal: of({ kind: 'still-running' }),
      });

      removeButton(fixture)?.click();

      expect(removeButton(fixture)?.disabled).toBe(true);
      expect(cmp.error()).toBe(
        'Removal is still running. If this page doesn’t change, restart Trinity.',
      );
    });

    it('can not start a second removal while one is running', async () => {
      const { fixture } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
        removal: NEVER,
      });

      removeButton(fixture)?.click();

      expect(removeButton(fixture)?.disabled).toBe(true);
    });

    it('starts afresh once removed with no live account: this page is kept across /login URLs', async () => {
      const { fixture, restart, router } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
        removal: of({ kind: 'removed', remainingAccountIds: [] }),
      });

      removeButton(fixture)?.click();

      expect(restart.restart).toHaveBeenCalledOnce();
      expect(router.navigateByUrl).not.toHaveBeenCalled();
    });

    it('returns to the app once removed with another account live', async () => {
      const { fixture, restart, router } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
        liveAccount: true,
        removal: of({ kind: 'removed', remainingAccountIds: ['@me:hs'] }),
      });

      removeButton(fixture)?.click();

      expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/rooms', {
        replaceUrl: true,
      });
      expect(restart.restart).not.toHaveBeenCalled();
    });

    it("shows the login page's error when the removal outcome is failed", async () => {
      const { fixture, cmp, restart } = await renderLogin(OIDC_AUTH, {
        reauth: '@bob:hs',
        record: OIDC_RECORD,
        removal: of({ kind: 'failed' }),
      });

      removeButton(fixture)?.click();
      fixture.detectChanges();

      expect(cmp.error()).toBe('Unable to remove this account right now.');
      expect(
        fixture.nativeElement.querySelector('[role="alert"]')?.textContent,
      ).toContain('Unable to remove this account right now.');
      expect(removeButton(fixture)?.disabled).toBe(false);
      expect(restart.restart).not.toHaveBeenCalled();
    });
  });

  describe('Report a bug', () => {
    it('sits just before the erase button, which stays last, and opens the report without signing in', async () => {
      const open = vi.fn();
      const { fixture } = await renderLogin(
        {} as unknown as Partial<AuthService>,
        { bugReport: { open } },
      );
      const button = (
        fixture.nativeElement as HTMLElement
      ).querySelector<HTMLButtonElement>('[data-testid="login-report-bug"]');

      expect(button?.textContent?.trim()).toBe('Report a bug');
      expect(button?.nextElementSibling?.getAttribute('data-testid')).toBe(
        'clear-all-data',
      );
      expect(
        button?.nextElementSibling?.nextElementSibling,
        'erase is the last action',
      ).toBeNull();
      button?.click();

      expect(open).toHaveBeenCalledOnce();
    });

    it('is left out when the app provides no way to report', async () => {
      const { fixture } = await renderLogin(
        {} as unknown as Partial<AuthService>,
      );

      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="login-report-bug"]',
        ),
      ).toBeNull();
    });
  });

  describe('QR sign-in', () => {
    /** The page enters matrix.org, which delegates to `issuer`. */
    const serverWithProvider = (issuer: string) =>
      ({
        discoverHomeserver: vi.fn(() => of('https://matrix-client.matrix.org')),
        getSupportedFlows: vi.fn(() => of([])),
        getDelegatedAuthConfig: vi.fn(() => of({ issuer })),
      }) as unknown as Partial<AuthService>;
    const oidcServer = serverWithProvider('https://account.matrix.org/');
    const qrButton = (root: HTMLElement) =>
      root.querySelector<HTMLButtonElement>('[data-testid="qr-sign-in"]');

    it('hides "Sign in with QR code" when the server does not support it', async () => {
      const { cmp, fixture } = await renderLogin(oidcServer);

      cmp.discover();
      fixture.detectChanges();

      expect(qrButton(fixture.nativeElement as HTMLElement)).toBeNull();
    });

    it('offers "Sign in with QR code" once the server supports it', async () => {
      const { cmp, fixture } = await renderLogin(oidcServer, {
        qrSupported: true,
      });

      cmp.discover();
      fixture.detectChanges();

      expect(
        qrButton(fixture.nativeElement as HTMLElement)?.textContent?.trim(),
      ).toBe('Sign in with QR code');
    });

    it('swaps the sign-in choices for the QR panel and back', async () => {
      const { cmp, fixture } = await renderLogin(oidcServer, {
        qrSupported: true,
      });
      const root = fixture.nativeElement as HTMLElement;
      cmp.discover();
      fixture.detectChanges();

      fireEvent.click(qrButton(root)!);
      fixture.detectChanges();

      expect(root.querySelector('trn-qr-sign-in-panel')).not.toBeNull();
      expect(root.querySelector('[data-testid="oidc-continue"]')).toBeNull();

      fireEvent.click(
        [...root.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Sign in another way',
        )!,
      );
      fixture.detectChanges();

      expect(root.querySelector('trn-qr-sign-in-panel')).toBeNull();
      expect(
        root.querySelector('[data-testid="oidc-continue"]'),
      ).not.toBeNull();
    });

    it('shows the code at once for a provider on the server’s own site, bound to the server entered', async () => {
      const { cmp, fixture } = await renderLogin(oidcServer, {
        qrSupported: true,
      });
      const root = fixture.nativeElement as HTMLElement;
      cmp.discover();
      fixture.detectChanges();

      fireEvent.click(qrButton(root)!);
      fixture.detectChanges();

      expect(root.querySelector('[data-testid="oidc-other-site"]')).toBeNull();
      expect(root.querySelector('trn-qr-sign-in-panel')).not.toBeNull();
      expect(
        TestBed.inject(QrSignInService).signInByShowingCode,
      ).toHaveBeenCalledWith('https://matrix-client.matrix.org', 'matrix.org');
    });

    it('asks before showing a code for a provider on another site', async () => {
      const { cmp, fixture } = await renderLogin(
        serverWithProvider('https://auth.provider.test/'),
        { qrSupported: true },
      );
      const root = fixture.nativeElement as HTMLElement;
      const qrSignIn = TestBed.inject(QrSignInService);
      cmp.discover();
      fixture.detectChanges();

      fireEvent.click(qrButton(root)!);
      fixture.detectChanges();

      expect(
        root
          .querySelector('[data-testid="oidc-other-site"]')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim(),
      ).toBe(
        'You’ll sign in with auth.provider.test, which isn’t part of matrix.org. ' +
          'Continue only if you expect matrix.org to use this provider.',
      );
      expect(root.querySelector('trn-qr-sign-in-panel')).toBeNull();
      expect(qrSignIn.signInByShowingCode).not.toHaveBeenCalled();

      fireEvent.click(
        root.querySelector('[data-testid="oidc-other-site-continue"]')!,
      );
      fixture.detectChanges();

      expect(root.querySelector('trn-qr-sign-in-panel')).not.toBeNull();
      expect(qrSignIn.signInByShowingCode).toHaveBeenCalledWith(
        'https://matrix-client.matrix.org',
        'matrix.org',
      );
    });

    it('returns focus to "Sign in with QR code" when the panel is left', async () => {
      const { cmp, fixture } = await renderLogin(oidcServer, {
        qrSupported: true,
      });
      const root = fixture.nativeElement as HTMLElement;
      cmp.discover();
      fixture.detectChanges();
      fireEvent.click(qrButton(root)!);
      fixture.detectChanges();

      fireEvent.keyDown(root.querySelector('trn-qr-sign-in-panel')!, {
        key: 'Escape',
      });
      fixture.detectChanges();
      await fixture.whenStable();

      expect(document.activeElement).toBe(qrButton(root));
    });

    it.each([true, false])(
      'opens the rooms after a QR sign-in like any other (verified: %s)',
      async (verified) => {
        const { cmp, fixture, router } = await renderLogin(oidcServer, {
          qrSupported: true,
          qrFlow: of({ kind: 'done', verified } as const),
        });
        cmp.discover();
        fixture.detectChanges();

        fireEvent.click(qrButton(fixture.nativeElement as HTMLElement)!);
        fixture.detectChanges();

        expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
          replaceUrl: true,
        });
      },
    );

    it('does not offer QR sign-in while re-authenticating an account', async () => {
      const { fixture } = await renderLogin(oidcServer, {
        reauth: '@me:hs.example',
        record: {
          userId: '@me:hs.example',
          baseUrl: 'https://hs.example',
          deviceId: 'D',
        },
        qrSupported: true,
      });
      fixture.detectChanges();

      expect(qrButton(fixture.nativeElement as HTMLElement)).toBeNull();
    });
  });
});
