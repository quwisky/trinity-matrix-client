import { Location } from '@angular/common';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { render } from '@trinity/testing';
import { AuthService } from '@trinity/data-access/auth';
import { MockProvider } from 'ng-mocks';
import { from, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
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
  clientId: null,
  deviceId: null,
  codeVerifier: null,
  expectedUserId: null,
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
  /** Per-call OIDC peek behaviour, for callbacks that must not read the same stash. */
  oidcPeek?: () => Promise<OidcStateStash>;
  /** Per-call legacy-SSO peek behaviour, same purpose. */
  ssoPeek?: () => Promise<SsoStateStash>;
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
  const ssoPeek = opts.ssoPeek
    ? vi.fn(opts.ssoPeek)
    : vi.fn().mockResolvedValue({ ...EMPTY_SSO, ...opts.ssoStash });
  const oidcPeek = opts.oidcPeek
    ? vi.fn(opts.oidcPeek)
    : vi.fn().mockResolvedValue({ ...EMPTY_OIDC, ...opts.oidcStash });

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

    it('redeems the login token once when the same callback is delivered twice', async () => {
      const completeSsoLogin = vi.fn(() => of({}));
      const { ssoClear } = await renderPage({
        auth: { completeSsoLogin } as unknown as Partial<AuthService>,
        paramsSequence: [
          { loginToken: 'TOKEN', sso_state: 'NONCE' },
          { loginToken: 'TOKEN', sso_state: 'NONCE' },
        ],
        ssoStash: {
          state: 'NONCE',
          baseUrl: 'https://hs.example',
          mode: 'add',
          deviceId: 'OLDDEV',
        },
      });

      // Same single-use hazard as the OIDC code: a Matrix `m.login.token` is consumed on
      // first use, so the duplicate would fail and surface an error over a session that
      // had already succeeded.
      expect(completeSsoLogin).toHaveBeenCalledTimes(1);
      expect(ssoClear).toHaveBeenCalledTimes(1);
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

    it('clears a straggler’s message once the genuine callback claims', async () => {
      // The same `error.set(null)` on claim exists on both callback paths, but only the
      // OIDC one was pinned — deleting the SSO line left every test green. On native a
      // forged or replayed emission can arrive first and set "could not be verified"
      // through reportUnverified; without the clear, a legacy-SSO user would watch that
      // error render, with a Back button, over a sign-in that is actually going through.
      let peeks = 0;
      const completeSsoLogin = vi.fn(() => of({}));
      const { cmp, navigateByUrl } = await renderPage({
        auth: { completeSsoLogin } as unknown as Partial<AuthService>,
        paramsSequence: [
          { loginToken: 'ATTACK', sso_state: 'FORGED' },
          { loginToken: 'TOKEN', sso_state: 'NONCE' },
        ],
        // The first emission reads an EMPTY stash, which is the only path that reports
        // without claiming (a mismatch against a LIVE stash stays deliberately silent).
        ssoPeek: () => {
          peeks += 1;
          return Promise.resolve(
            peeks === 1
              ? EMPTY_SSO
              : { ...EMPTY_SSO, state: 'NONCE', baseUrl: 'https://hs.example' },
          );
        },
      });

      expect(peeks).toBe(2);

      expect(completeSsoLogin).toHaveBeenCalledTimes(1);
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
      expect(cmp.error()).toBeNull();
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
      clientId: 'CLIENT1',
      deviceId: 'DEVICE1',
      codeVerifier: 'VERIFIER1',
      expectedUserId: null,
    };
    /** What the stash must be handed to the exchange as (matrix-js-sdk 42 keeps none of it). */
    const GRANT_CONTEXT = {
      baseUrl: 'https://hs.example',
      redirectUri: 'https://app/sso-callback',
      clientId: 'CLIENT1',
      deviceId: 'DEVICE1',
      codeVerifier: 'VERIFIER1',
    };

    it('completes the grant with the stashed PKCE context, then clears the stash + URL', async () => {
      const completeOidcLogin = vi.fn(() => of(undefined));
      const { navigateByUrl, replaceState, oidcClear } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: OIDC_STASH,
      });

      expect(replaceState).toHaveBeenCalledWith('/sso-callback');
      // The SDK no longer persists the sign-in state anywhere, so the whole PKCE context
      // must be fed back in-band from the stash — nothing is re-seeded into sessionStorage.
      expect(completeOidcLogin).toHaveBeenCalledWith(
        'CODE',
        GRANT_CONTEXT,
        'replace',
        null,
      );
      expect(oidcClear).toHaveBeenCalledTimes(1); // consumed only after state matched
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
    });

    it('exchanges the code once when the same callback is delivered twice', async () => {
      const completeOidcLogin = vi.fn(() => of(undefined));
      const { oidcClear } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        // The identical genuine callback, emitted twice. A deep link can be delivered more
        // than once (the OS re-firing it, or a repeated navigation), and the `claimed`
        // latch is what is supposed to make the exchange run at most once.
        paramsSequence: [
          { code: 'CODE', state: 'STATE1' },
          { code: 'CODE', state: 'STATE1' },
        ],
        oidcStash: OIDC_STASH,
      });

      // A second exchange would POST an already-redeemed authorization code. Providers
      // MUST reject a reused code (RFC 6749 4.1.2) and SHOULD revoke the tokens issued
      // for it, so the duplicate can invalidate the session the first call just created.
      expect(completeOidcLogin).toHaveBeenCalledTimes(1);
      expect(oidcClear).toHaveBeenCalledTimes(1);
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
        GRANT_CONTEXT,
        'replace',
        null,
      );
      expect(oidcClear).toHaveBeenCalledTimes(1); // consumed once, by the genuine callback
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
    });

    it('surfaces an error when the only callback cannot read the stash', async () => {
      // Web delivers exactly one emission. If the Preferences/localStorage read throws,
      // handle() rejects before it can set `error` itself — and the template's else
      // branch is a spinner whose only exit ("Back to sign in") lives in the error
      // branch. Swallowing this stranded the user with no way out but a force-quit.
      const completeOidcLogin = vi.fn();
      const { cmp } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcPeek: () => Promise.reject(new Error('storage unavailable')),
      });

      expect(completeOidcLogin).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/could not be completed/i);
    });

    it('still completes the genuine callback after the first handler throws', async () => {
      // The callbacks are queued, not fired and forgotten, so that `claimed` is only ever
      // set after a state match. That queue is shared: if a failing handler is allowed to
      // reject the chain's tail, every LATER callback is short-circuited away silently —
      // which is exactly the lock-out the serialization was chosen to prevent, now
      // reachable by a forged deep link that merely makes the stash read fail.
      let peeks = 0;
      const completeOidcLogin = vi.fn(() => of(undefined));
      const { cmp, navigateByUrl } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        paramsSequence: [
          { code: 'ATTACK', state: 'FORGED' },
          { code: 'REAL', state: 'STATE1' },
        ],
        oidcPeek: () => {
          peeks += 1;
          return peeks === 1
            ? Promise.reject(new Error('storage unavailable'))
            : Promise.resolve({ ...EMPTY_OIDC, ...OIDC_STASH });
        },
      });

      expect(completeOidcLogin).toHaveBeenCalledTimes(1);
      expect(completeOidcLogin).toHaveBeenCalledWith(
        'REAL',
        GRANT_CONTEXT,
        'replace',
        null,
      );
      expect(navigateByUrl).toHaveBeenCalledWith('/rooms', {
        replaceUrl: true,
      });
      // The failed straggler's message must not survive alongside a sign-in that went
      // through — claiming clears it.
      expect(cmp.error()).toBeNull();
    });

    it('forwards the re-auth expectation so the grant can be bound to that account', async () => {
      // Without this the callback would complete a re-auth as whoever the provider
      // happened to have a session for, under the account's device id.
      const completeOidcLogin = vi.fn(() => of(undefined));
      await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: { ...OIDC_STASH, mode: 'add', expectedUserId: '@a:hs' },
      });

      expect(completeOidcLogin).toHaveBeenCalledWith(
        'CODE',
        GRANT_CONTEXT,
        'add',
        '@a:hs',
      );
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

    it('errors when the PKCE verifier is missing from the stash', async () => {
      // The stash is now the ONLY custodian of the code_verifier; without it the token
      // exchange can only fail at the provider, so refuse before sending the code.
      const completeOidcLogin = vi.fn();
      const { cmp } = await renderPage({
        auth: { completeOidcLogin } as unknown as Partial<AuthService>,
        params: { code: 'CODE', state: 'STATE1' },
        oidcStash: { ...OIDC_STASH, codeVerifier: null },
      });

      expect(completeOidcLogin).not.toHaveBeenCalled();
      expect(cmp.error()).toMatch(/missing/i);
    });

    it('forgets the cached client id on invalid_client, then surfaces the error', async () => {
      const forgetOidcClientId = vi.fn(() => of(undefined));
      const { cmp, oidcClear } = await renderPage({
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
      // The spent verifier is scrubbed even on failure: the stash was consumed up front.
      expect(oidcClear).toHaveBeenCalledTimes(1);
    });
  });
});
