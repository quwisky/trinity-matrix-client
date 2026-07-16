import { Location } from '@angular/common';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { render } from '@testing-library/angular';
import { AuthService } from '@trinity/data-access-auth';
import { MockProvider } from 'ng-mocks';
import { from, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SsoCallbackPage } from './sso-callback.page';
import { SsoStateStore, type SsoStateStash } from '../sso-state.store';
import { OidcStateStore, type OidcStateStash } from '../oidc-state.store';

const EMPTY_SSO: SsoStateStash = {
  state: null,
  baseUrl: null,
  mode: 'replace',
  deviceId: null,
};
const EMPTY_OIDC: OidcStateStash = {
  state: null,
  baseUrl: null,
  mode: 'replace',
  redirectUri: null,
  issuer: null,
  sessionStateKey: null,
  sessionStateBlob: null,
};

function paramMap(params: Record<string, string | null>): ParamMap {
  return { get: (k: string) => params[k] ?? null } as ParamMap;
}

async function renderPage(opts: {
  auth: Partial<AuthService>;
  params?: Record<string, string | null>;
  /** Emit several query-param maps in sequence (a reused component / repeated callback). */
  paramsSequence?: Record<string, string | null>[];
  ssoStash?: Partial<SsoStateStash>;
  oidcStash?: Partial<OidcStateStash>;
}): Promise<{
  cmp: SsoCallbackPage;
  navigateByUrl: ReturnType<typeof vi.fn>;
  replaceState: ReturnType<typeof vi.fn>;
  ssoClear: ReturnType<typeof vi.fn>;
  oidcClear: ReturnType<typeof vi.fn>;
}> {
  const navigateByUrl = vi.fn();
  const replaceState = vi.fn();
  const ssoClear = vi.fn().mockResolvedValue(undefined);
  const oidcClear = vi.fn().mockResolvedValue(undefined);
  // peek() reads WITHOUT clearing; the page consumes (clear) only once state matches.
  const ssoPeek = vi.fn().mockResolvedValue({ ...EMPTY_SSO, ...opts.ssoStash });
  const oidcPeek = vi
    .fn()
    .mockResolvedValue({ ...EMPTY_OIDC, ...opts.oidcStash });

  const { fixture } = await render(SsoCallbackPage, {
    providers: [
      MockProvider(AuthService, opts.auth),
      MockProvider(Router, { navigateByUrl }),
      MockProvider(Location, { replaceState }),
      MockProvider(SsoStateStore, { peek: ssoPeek, clear: ssoClear }),
      MockProvider(OidcStateStore, { peek: oidcPeek, clear: oidcClear }),
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: from(
            (opts.paramsSequence ?? [opts.params ?? {}]).map(paramMap),
          ),
        },
      },
    ],
  });

  // `render` triggers ngOnInit, which subscribes to the query params and kicks off the
  // async peek → clear → login chain (fire-and-forget, not tracked by zone stability).
  // A macrotask tick drains that microtask chain.
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    cmp: fixture.componentInstance,
    navigateByUrl,
    replaceState,
    ssoClear,
    oidcClear,
  };
}

describe('SsoCallbackPage', () => {
  beforeEach(() => sessionStorage.clear());

  describe('legacy SSO (loginToken)', () => {
    it('completes login when the state matches, clearing storage + URL', async () => {
      const completeSsoLogin = vi.fn(() => of({}));
      const { navigateByUrl, replaceState, ssoClear } = await renderPage({
        auth: { completeSsoLogin } as unknown as Partial<AuthService>,
        params: { loginToken: 'TOKEN', sso_state: 'NONCE' },
        ssoStash: {
          state: 'NONCE',
          baseUrl: 'https://hs.example',
          mode: 'add',
          deviceId: 'OLDDEV',
        },
      });

      expect(replaceState).toHaveBeenCalledWith('/sso-callback'); // token off the URL
      expect(completeSsoLogin).toHaveBeenCalledWith(
        'https://hs.example',
        'TOKEN',
        'add',
        'OLDDEV',
      );
      expect(ssoClear).toHaveBeenCalledTimes(1); // consumed only after state matched
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
    });

    it('ignores a forged callback without wiping the live stash', async () => {
      const completeSsoLogin = vi.fn();
      const { cmp, ssoClear } = await renderPage({
        auth: { completeSsoLogin } as unknown as Partial<AuthService>,
        params: { loginToken: 'TOKEN', sso_state: 'FORGED' },
        ssoStash: { state: 'EXPECTED', baseUrl: 'https://hs.example' },
      });

      // State mismatch against a LIVE stash → stay silent (the genuine callback, which
      // reuses this component, will still complete) and do NOT clear the stash.
      expect(completeSsoLogin).not.toHaveBeenCalled();
      expect(ssoClear).not.toHaveBeenCalled();
      expect(cmp.error()).toBeNull();
    });

    it('errors when the homeserver is missing from a state-matched stash', async () => {
      const completeSsoLogin = vi.fn();
      const { cmp } = await renderPage({
        auth: { completeSsoLogin } as unknown as Partial<AuthService>,
        params: { loginToken: 'TOKEN', sso_state: 'NONCE' },
        ssoStash: { state: 'NONCE', baseUrl: null },
      });

      expect(cmp.error()).toMatch(/missing/i);
      expect(completeSsoLogin).not.toHaveBeenCalled();
    });

    it('reports an unverifiable callback when no login is pending', async () => {
      const { cmp } = await renderPage({
        auth: { completeSsoLogin: vi.fn() } as unknown as Partial<AuthService>,
        params: { loginToken: 'TOKEN', sso_state: 'NONCE' },
        ssoStash: {}, // empty (expired/none)
      });

      expect(cmp.error()).toMatch(/could not be verified/i);
    });

    it('surfaces a completion error', async () => {
      const { cmp, navigateByUrl } = await renderPage({
        auth: {
          completeSsoLogin: vi.fn(() =>
            throwError(() => new Error('token expired')),
          ),
        } as unknown as Partial<AuthService>,
        params: { loginToken: 'TOKEN', sso_state: 'NONCE' },
        ssoStash: { state: 'NONCE', baseUrl: 'https://hs.example' },
      });

      expect(cmp.error()).toBe('token expired');
      expect(navigateByUrl).not.toHaveBeenCalled();
    });
  });

  describe('OIDC (code + state)', () => {
    const OIDC_STASH: OidcStateStash = {
      state: 'STATE1',
      baseUrl: 'https://hs.example',
      mode: 'replace',
      redirectUri: 'https://app/sso-callback',
      issuer: 'https://op.example',
      sessionStateKey: 'mx_oidc_STATE1',
      sessionStateBlob: 'SIGNIN_BLOB',
    };

    it('re-seeds the PKCE state, completes the grant, then clears the key + URL', async () => {
      let seededAtCall: string | null = null;
      const completeOidcLogin = vi.fn(() => {
        seededAtCall = sessionStorage.getItem('mx_oidc_STATE1');
        return of(undefined);
      });
      const { navigateByUrl, replaceState, oidcClear } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: OIDC_STASH,
      });

      expect(replaceState).toHaveBeenCalledWith('/sso-callback');
      expect(seededAtCall).toBe('SIGNIN_BLOB'); // re-seeded before the exchange
      expect(completeOidcLogin).toHaveBeenCalledWith(
        'CODE',
        'STATE1',
        'https://app/sso-callback',
        'replace',
      );
      expect(oidcClear).toHaveBeenCalledTimes(1); // consumed only after state matched
      expect(sessionStorage.getItem('mx_oidc_STATE1')).toBeNull(); // spent verifier scrubbed
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
    });

    it('ignores a forged callback without wiping the live stash', async () => {
      const completeOidcLogin = vi.fn();
      const { cmp, oidcClear } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'FORGED' },
        oidcStash: OIDC_STASH,
      });

      expect(completeOidcLogin).not.toHaveBeenCalled();
      expect(oidcClear).not.toHaveBeenCalled(); // the live login's stash survives
      expect(cmp.error()).toBeNull();
    });

    it('surfaces a genuine provider error (matching state)', async () => {
      const completeOidcLogin = vi.fn();
      const { cmp, oidcClear } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: {
          error: 'access_denied',
          error_description: 'The user declined',
          state: 'STATE1',
        },
        oidcStash: OIDC_STASH,
      });

      expect(oidcClear).toHaveBeenCalledTimes(1);
      expect(completeOidcLogin).not.toHaveBeenCalled();
      expect(cmp.error()).toBe('The user declined');
    });

    it('reports an unverifiable callback when no login is pending (expired/empty stash)', async () => {
      const completeOidcLogin = vi.fn();
      const { cmp } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: {}, // empty (expired or none) → peek returns state:null
      });

      expect(completeOidcLogin).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/could not be verified/i);
    });

    it('still completes the genuine callback after a forged one lands first (reused component)', async () => {
      const completeOidcLogin = vi.fn(() => of(undefined));
      const { navigateByUrl, oidcClear } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        // The native deep link reuses this component: a forged callback (wrong state)
        // arrives first, then the genuine one (matching state) on the same param stream.
        paramsSequence: [
          { code: 'ATTACK', state: 'FORGED' },
          { code: 'REAL', state: 'STATE1' },
        ],
        oidcStash: OIDC_STASH,
      });

      // The forged one is ignored (stash not wiped); the genuine one completes exactly once.
      expect(completeOidcLogin).toHaveBeenCalledTimes(1);
      expect(completeOidcLogin).toHaveBeenCalledWith(
        'REAL',
        'STATE1',
        'https://app/sso-callback',
        'replace',
      );
      expect(oidcClear).toHaveBeenCalledTimes(1); // consumed once, by the genuine callback
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
    });

    it('errors when the redirect is missing from the stash', async () => {
      const completeOidcLogin = vi.fn();
      const { cmp } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: { ...OIDC_STASH, redirectUri: null },
      });

      expect(completeOidcLogin).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/missing/i);
    });

    it('forgets the cached client id on invalid_client, then surfaces the error', async () => {
      const forgetOidcClientId = vi.fn(() => of(undefined));
      const { cmp } = await renderPage({
        auth: {
          completeOidcLogin: vi.fn(() =>
            throwError(() => new Error('invalid_client: unknown client')),
          ),
          forgetOidcClientId,
        } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: OIDC_STASH,
      });

      expect(forgetOidcClientId).toHaveBeenCalledWith('https://op.example');
      expect(cmp.error()).toMatch(/invalid_client/i);
      expect(sessionStorage.getItem('mx_oidc_STATE1')).toBeNull(); // verifier scrubbed
    });
  });
});
