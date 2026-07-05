import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { render } from '@testing-library/angular';
import { AuthService } from '@trinity/core';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SsoCallbackPage } from './sso-callback.page';
import { SsoStateStore, type SsoStateStash } from '../sso-state.store';

async function renderPage(opts: {
  auth: Partial<AuthService>;
  token: string | null;
  returnedState?: string | null;
  stash?: SsoStateStash;
}): Promise<{
  cmp: SsoCallbackPage;
  navigateByUrl: ReturnType<typeof vi.fn>;
  replaceState: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
}> {
  const navigateByUrl = vi.fn();
  const replaceState = vi.fn();
  // The store survives a native cold-start; mock it so the CSRF check is exercised
  // independently of the storage medium.
  const consume = vi
    .fn()
    .mockResolvedValue(opts.stash ?? { state: null, baseUrl: null });

  const { fixture } = await render(SsoCallbackPage, {
    providers: [
      MockProvider(AuthService, opts.auth),
      MockProvider(Router, { navigateByUrl }),
      MockProvider(Location, { replaceState }),
      MockProvider(SsoStateStore, { consume }),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: {
              get: (k: string) =>
                k === 'loginToken'
                  ? opts.token
                  : k === 'sso_state'
                    ? (opts.returnedState ?? null)
                    : null,
            },
          },
        },
      },
    ],
  });

  // `render` triggers `ngOnInit`, whose async work (the single-use store read and
  // the login subscription) settles on a later microtask — wait for it to drain.
  await fixture.whenStable();

  return {
    cmp: fixture.componentInstance,
    navigateByUrl,
    replaceState,
    consume,
  };
}

describe('SsoCallbackPage', () => {
  beforeEach(() => sessionStorage.clear());

  it('completes login when the state matches, clearing storage + URL', async () => {
    const completeSsoLogin = vi.fn(() => of({}));
    const { navigateByUrl, replaceState, consume } = await renderPage({
      auth: { completeSsoLogin } as unknown as Partial<AuthService>,
      token: 'TOKEN',
      returnedState: 'NONCE',
      stash: { state: 'NONCE', baseUrl: 'https://hs.example' },
    });

    expect(replaceState).toHaveBeenCalledWith('/sso-callback'); // token off the URL
    expect(completeSsoLogin).toHaveBeenCalledWith(
      'https://hs.example',
      'TOKEN',
    );
    expect(consume).toHaveBeenCalledTimes(1); // single-use read (consuming clears)
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('rejects a callback whose state does not match the stored one', async () => {
    const completeSsoLogin = vi.fn();
    const { cmp, consume } = await renderPage({
      auth: { completeSsoLogin } as unknown as Partial<AuthService>,
      token: 'TOKEN',
      returnedState: 'FORGED',
      stash: { state: 'EXPECTED', baseUrl: 'https://hs.example' },
    });

    expect(completeSsoLogin).not.toHaveBeenCalled();
    expect(cmp.error()).toMatch(/could not be verified/i);
    expect(consume).toHaveBeenCalledTimes(1); // consumed (cleared) even on reject
  });

  it('rejects when no state was stored for this round-trip', async () => {
    const completeSsoLogin = vi.fn();
    const { cmp } = await renderPage({
      auth: { completeSsoLogin } as unknown as Partial<AuthService>,
      token: 'TOKEN',
      returnedState: 'WHATEVER',
      stash: { state: null, baseUrl: 'https://hs.example' },
    });

    expect(completeSsoLogin).not.toHaveBeenCalled();
    expect(cmp.error()).toMatch(/could not be verified/i);
  });

  it('errors when the login token is missing', async () => {
    const completeSsoLogin = vi.fn();
    const { cmp } = await renderPage({
      auth: { completeSsoLogin } as unknown as Partial<AuthService>,
      token: null,
    });

    expect(cmp.error()).toMatch(/missing/i);
    expect(completeSsoLogin).not.toHaveBeenCalled();
  });

  it('still strips the token from the URL when the homeserver is missing', async () => {
    const { cmp, replaceState } = await renderPage({
      auth: { completeSsoLogin: vi.fn() } as unknown as Partial<AuthService>,
      token: 'TOKEN',
      stash: { state: null, baseUrl: null }, // e.g. a stale/expired stash
    });

    expect(replaceState).toHaveBeenCalledWith('/sso-callback');
    expect(cmp.error()).toMatch(/missing/i);
  });

  it('surfaces a completion error', async () => {
    const { cmp, navigateByUrl } = await renderPage({
      auth: {
        completeSsoLogin: vi.fn(() =>
          throwError(() => new Error('token expired')),
        ),
      } as unknown as Partial<AuthService>,
      token: 'TOKEN',
      returnedState: 'NONCE',
      stash: { state: 'NONCE', baseUrl: 'https://hs.example' },
    });

    expect(cmp.error()).toBe('token expired');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
