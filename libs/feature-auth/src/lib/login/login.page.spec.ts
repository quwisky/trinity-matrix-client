import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@trinity/data-access-auth';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login.page';
import { SsoStateStore } from '../sso-state.store';

async function renderLogin(auth: Partial<AuthService>): Promise<{
  cmp: LoginPage;
  router: Router;
  ssoStore: SsoStateStore;
}> {
  const { fixture } = await render(LoginPage, {
    providers: [
      MockProvider(AuthService, auth),
      MockProvider(Router),
      MockProvider(SsoStateStore),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    router: TestBed.inject(Router),
    ssoStore: TestBed.inject(SsoStateStore),
  };
}

describe('LoginPage', () => {
  it('discovers the homeserver and surfaces its login flows', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of(['m.login.password', 'm.login.sso'])),
    } as unknown as Partial<AuthService>);

    cmp.discover();

    expect(cmp.baseUrl()).toBe('https://hs.example');
    expect(cmp.passwordSupported()).toBe(true);
    expect(cmp.ssoSupported()).toBe(true);
  });

  it('hides password/SSO when the homeserver does not offer them', async () => {
    const { cmp } = await renderLogin({
      discoverHomeserver: vi.fn(() => of('https://hs.example')),
      getSupportedFlows: vi.fn(() => of([])),
    } as unknown as Partial<AuthService>);

    cmp.discover();

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
    cmp.username.set('alice');
    cmp.password.set('hunter2');

    cmp.loginPassword();

    expect(loginWithPassword).toHaveBeenCalledWith(
      'https://hs.example',
      'alice',
      'hunter2',
    );
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
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
});
