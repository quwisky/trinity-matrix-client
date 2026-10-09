import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ReauthAccountMismatchError,
  AuthService,
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  NewDeviceSignInCancelledError,
  OidcStateStore,
  RegistrationService,
  SignInRedirectService,
} from '@trinity/data-access/auth';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  AppRestartService,
  SessionStorageService,
  provideHostCapabilities,
} from '@trinity/platform-native';
import { TrnAlertService } from '@trinity/components/overlay';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, map, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login.page';
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
}> {
  const queryParamMap = {
    has: (key: string) => key === 'add' && !!opts.add,
    get: (key: string) => (key === 'reauth' ? (opts.reauth ?? null) : null),
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
      MockProvider(Router),
      MockProvider(SignInRedirectService, {
        startSso: vi.fn(() => of(undefined)),
        startOidc: vi.fn(() => of(undefined)),
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
    );
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
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
    );
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
    /** An OIDC-native login page: discovered homeserver + provider metadata. */
    async function renderOidcReady(redirect?: Partial<SignInRedirectService>) {
      const rendered = await renderLogin(
        {} as unknown as Partial<AuthService>,
        redirect ? { redirect } : {},
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

    it('hands the discovered provider to the redirect service, under the busy state', async () => {
      const handoff = new Subject<void>();
      const { cmp, redirect } = await renderOidcReady({
        startOidc: vi.fn(() => handoff),
      });

      cmp.startOidc('create');

      expect(redirect.startOidc).toHaveBeenCalledWith({
        baseUrl: 'https://hs.example',
        metadata: { issuer: 'https://op' },
        mode: 'replace',
        prompt: 'create',
        expectedUserId: null,
      });
      expect(cmp.busy()).toBe(true);

      handoff.complete();
      expect(cmp.busy()).toBe(false);
    });

    it('re-auth reuses the stored device and expects the same account back', async () => {
      const { cmp, redirect } = await renderLogin(
        {
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
});
