import { TestBed } from '@angular/core/testing';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import { provideHostCapabilities } from '@trinity/platform-native';
import { desktopBridgeFixture } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AuthService } from './auth.service';
import { OidcStateStore } from './oidc-state.store';
import { SignInRedirectService } from './sign-in-redirect.service';
import { SsoStateStore } from './sso-state.store';

const OIDC_REQUEST = {
  url: 'https://op/authorize?client_id=abc&state=STATE1',
  state: 'STATE1',
  clientId: 'CLIENT1',
  deviceId: 'DEVICE1',
  codeVerifier: 'VERIFIER1',
};
const METADATA = { issuer: 'https://op' } as never;

/** Records the order in which the durable save and the redirect happen. */
function setup(
  overrides: {
    saveSso?: () => Promise<void>;
    saveOidc?: (stash: unknown) => Promise<void>;
    build?: Mock<(params: unknown) => Observable<typeof OIDC_REQUEST>>;
  } = {},
) {
  const events: string[] = [];
  const open = vi.fn(({ url }: { url: string }) => {
    events.push(`open ${url}`);
    return of({ kind: 'completed' as const });
  });
  const saveSso = vi.fn(
    overrides.saveSso ??
      (async () => {
        events.push('save sso');
      }),
  );
  const saveOidc = vi.fn(
    overrides.saveOidc ??
      (async (_stash: unknown) => {
        events.push('save oidc');
      }),
  );
  const getSsoUrl = vi.fn(
    (_baseUrl: string, redirect: string) =>
      `https://hs.example/sso?r=${redirect}`,
  );
  const build =
    overrides.build ?? vi.fn((_params: unknown) => of(OIDC_REQUEST));
  TestBed.configureTestingModule({
    providers: [
      MockProvider(HostAuthenticationHandoffService, {
        callback: ({ webUrl }) => ({ url: webUrl, applicationType: 'web' }),
        open,
      }),
      MockProvider(SsoStateStore, { save: saveSso }),
      MockProvider(OidcStateStore, { save: saveOidc }),
      MockProvider(AuthService, {
        getSsoUrl,
        buildOidcAuthorizationRequest: build as never,
      }),
    ],
  });
  return {
    service: TestBed.inject(SignInRedirectService),
    events,
    open,
    saveSso,
    saveOidc,
    getSsoUrl,
    build,
  };
}

describe('SignInRedirectService', () => {
  describe('startSso', () => {
    it('does nothing until subscribed', () => {
      const { service, saveSso, open } = setup();

      service.startSso('https://hs.example', 'replace');

      expect(saveSso).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    it('stashes the state, then redirects to a URL that carries that state', async () => {
      const { service, events, saveSso, getSsoUrl } = setup();

      service.startSso('https://hs.example', 'add', 'OLDDEV').subscribe();
      await vi.waitFor(() => expect(events).toHaveLength(2));

      const [state, baseUrl, mode, deviceId] = saveSso.mock
        .calls[0] as unknown as [string, string, string, string];
      expect([baseUrl, mode, deviceId]).toEqual([
        'https://hs.example',
        'add',
        'OLDDEV',
      ]);
      expect(state).toMatch(/^[0-9a-f]{32}$/);
      const redirect = getSsoUrl.mock.calls[0][1];
      expect(redirect).toContain('/sso-callback?sso_state=');
      expect(redirect).toContain(state);
      expect(events.map((e) => e.split(' ')[0])).toEqual(['save', 'open']);
    });

    it('redirects only after the stash write has settled', async () => {
      let release!: () => void;
      const { service, open } = setup({
        saveSso: () => new Promise<void>((resolve) => (release = resolve)),
      });

      service.startSso('https://hs.example', 'replace').subscribe();
      await new Promise((resolve) => setTimeout(resolve));
      expect(open).not.toHaveBeenCalled();

      release();
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    });

    it('does not redirect, and errors, when the stash write fails', async () => {
      const failure = new Error('preferences unavailable');
      const { service, open } = setup({
        saveSso: () => Promise.reject(failure),
      });
      const error = vi.fn();

      service.startSso('https://hs.example', 'replace').subscribe({ error });
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));

      expect(open).not.toHaveBeenCalled();
    });
  });

  describe('startOidc', () => {
    const request = {
      baseUrl: 'https://hs.example',
      metadata: METADATA,
      mode: 'replace' as const,
      expectedUserId: null,
    };

    it('does nothing until subscribed', () => {
      const { service, build } = setup();

      service.startOidc(request);

      expect(build).not.toHaveBeenCalled();
    });

    it('builds the request, stashes the whole PKCE context, then redirects', async () => {
      const { service, events, saveOidc, build } = setup();

      service.startOidc({ ...request, prompt: 'create' }).subscribe();
      await vi.waitFor(() => expect(events).toHaveLength(2));

      expect(build.mock.calls[0][0]).toMatchObject({
        baseUrl: 'https://hs.example',
        redirectUri: expect.stringContaining('/sso-callback'),
        applicationType: 'web',
        prompt: 'create',
      });
      expect(saveOidc.mock.calls[0][0]).toMatchObject({
        state: 'STATE1',
        baseUrl: 'https://hs.example',
        mode: 'replace',
        issuer: 'https://op',
        clientId: 'CLIENT1',
        deviceId: 'DEVICE1',
        codeVerifier: 'VERIFIER1',
        expectedUserId: null,
      });
      expect(events).toEqual(['save oidc', `open ${OIDC_REQUEST.url}`]);
    });

    it('re-auth reuses the stored device and expects the same account back', async () => {
      const { service, build, saveOidc, events } = setup();

      service
        .startOidc({
          ...request,
          mode: 'add',
          deviceId: 'OLDDEV',
          expectedUserId: '@bob:hs',
        })
        .subscribe();
      await vi.waitFor(() => expect(events).toHaveLength(2));

      expect(build.mock.calls[0][0]).toMatchObject({ deviceId: 'OLDDEV' });
      expect(saveOidc.mock.calls[0][0]).toMatchObject({
        mode: 'add',
        expectedUserId: '@bob:hs',
      });
    });

    it('redirects only after the stash write has settled', async () => {
      let release!: () => void;
      const { service, open, saveOidc } = setup({
        saveOidc: () => new Promise<void>((resolve) => (release = resolve)),
      });

      service.startOidc(request).subscribe();
      await vi.waitFor(() => expect(saveOidc).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve));
      expect(open).not.toHaveBeenCalled();

      release();
      await vi.waitFor(() =>
        expect(open).toHaveBeenCalledWith({ url: OIDC_REQUEST.url }),
      );
    });

    it('does not redirect, and errors, when the stash write fails', async () => {
      const failure = new Error('preferences unavailable');
      const { service, open } = setup({
        saveOidc: () => Promise.reject(failure),
      });
      const error = vi.fn();

      service.startOidc(request).subscribe({ error });
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));

      expect(open).not.toHaveBeenCalled();
    });

    it('stashes and redirects nothing when the request cannot be built', () => {
      const failure = new Error('registration refused');
      const { service, saveOidc, open } = setup({
        build: vi.fn(() => throwError(() => failure)),
      });
      const error = vi.fn();

      service.startOidc(request).subscribe({ error });

      expect(error).toHaveBeenCalledWith(failure);
      expect(saveOidc).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    it('waits for the request before touching storage', () => {
      const pending = new Subject<typeof OIDC_REQUEST>();
      const { service, saveOidc } = setup({ build: vi.fn(() => pending) });

      service.startOidc(request).subscribe();

      expect(saveOidc).not.toHaveBeenCalled();
    });
  });
});

describe('SignInRedirectService on the desktop host', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  function desktop() {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const getSsoUrl = vi.fn(
      (_b: string, r: string) => `https://hs.example/sso?r=${r}`,
    );
    const build = vi.fn((_params: unknown) => of(OIDC_REQUEST));
    TestBed.configureTestingModule({
      providers: [
        provideHostCapabilities(),
        MockProvider(SsoStateStore, {
          save: vi.fn().mockResolvedValue(undefined),
        }),
        MockProvider(OidcStateStore, {
          save: vi.fn().mockResolvedValue(undefined),
        }),
        MockProvider(AuthService, {
          getSsoUrl,
          buildOidcAuthorizationRequest: build as never,
        }),
      ],
    });
    return {
      service: TestBed.inject(SignInRedirectService),
      open,
      getSsoUrl,
      build,
    };
  }

  it('SSO uses the eu.qwky.trinity:// callback and opens externally', async () => {
    const { service, open, getSsoUrl } = desktop();

    service.startSso('https://hs.example', 'replace').subscribe();
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    expect(getSsoUrl.mock.calls[0][1]).toContain(
      'eu.qwky.trinity://sso-callback?sso_state=',
    );
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('https://hs.example/sso'),
      '_blank',
    );
    open.mockRestore();
  });

  it('OIDC registers as native with a single-slash RFC 8252 redirect', async () => {
    const { service, open, build } = desktop();

    service
      .startOidc({
        baseUrl: 'https://hs.example',
        metadata: METADATA,
        mode: 'replace',
        expectedUserId: null,
      })
      .subscribe();
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    expect(build.mock.calls[0][0]).toMatchObject({
      applicationType: 'native',
      redirectUri: 'eu.qwky.trinity:/sso-callback',
    });
    expect(open).toHaveBeenCalledWith(OIDC_REQUEST.url, '_blank');
    open.mockRestore();
  });
});
