import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '@trinity/core';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SsoCallbackPage } from './sso-callback.page';

function configure(opts: {
  auth: Partial<AuthService>;
  token: string | null;
  state?: string | null;
  navigateByUrl?: ReturnType<typeof vi.fn>;
  replaceState?: ReturnType<typeof vi.fn>;
}): {
  navigateByUrl: ReturnType<typeof vi.fn>;
  replaceState: ReturnType<typeof vi.fn>;
} {
  const navigateByUrl = opts.navigateByUrl ?? vi.fn();
  const replaceState = opts.replaceState ?? vi.fn();
  TestBed.configureTestingModule({
    imports: [SsoCallbackPage],
    providers: [
      { provide: AuthService, useValue: opts.auth },
      { provide: Router, useValue: { navigateByUrl } },
      { provide: Location, useValue: { replaceState } },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: {
              get: (k: string) =>
                k === 'loginToken'
                  ? opts.token
                  : k === 'sso_state'
                    ? (opts.state ?? null)
                    : null,
            },
          },
        },
      },
    ],
  });
  return { navigateByUrl, replaceState };
}

describe('SsoCallbackPage', () => {
  beforeEach(() => sessionStorage.clear());

  it('completes login when the state matches, clearing storage + URL', () => {
    sessionStorage.setItem('sso.baseUrl', 'https://hs.example');
    sessionStorage.setItem('sso.state', 'NONCE');
    const completeSsoLogin = vi.fn(() => of({}));
    const { navigateByUrl, replaceState } = configure({
      auth: { completeSsoLogin } as unknown as AuthService,
      token: 'TOKEN',
      state: 'NONCE',
    });
    const cmp = TestBed.createComponent(SsoCallbackPage).componentInstance;

    cmp.ngOnInit();

    expect(replaceState).toHaveBeenCalledWith('/sso-callback'); // token off the URL
    expect(completeSsoLogin).toHaveBeenCalledWith(
      'https://hs.example',
      'TOKEN',
    );
    expect(sessionStorage.getItem('sso.baseUrl')).toBeNull();
    expect(sessionStorage.getItem('sso.state')).toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('rejects a callback whose state does not match the stored one', () => {
    sessionStorage.setItem('sso.baseUrl', 'https://hs.example');
    sessionStorage.setItem('sso.state', 'EXPECTED');
    const completeSsoLogin = vi.fn();
    configure({
      auth: { completeSsoLogin } as unknown as AuthService,
      token: 'TOKEN',
      state: 'FORGED',
    });
    const cmp = TestBed.createComponent(SsoCallbackPage).componentInstance;

    cmp.ngOnInit();

    expect(completeSsoLogin).not.toHaveBeenCalled();
    expect(cmp.error()).toMatch(/could not be verified/i);
    expect(sessionStorage.getItem('sso.state')).toBeNull(); // cleared on reject
  });

  it('rejects when no state was stored for this session', () => {
    sessionStorage.setItem('sso.baseUrl', 'https://hs.example');
    const completeSsoLogin = vi.fn();
    configure({
      auth: { completeSsoLogin } as unknown as AuthService,
      token: 'TOKEN',
      state: 'WHATEVER',
    });
    const cmp = TestBed.createComponent(SsoCallbackPage).componentInstance;

    cmp.ngOnInit();

    expect(completeSsoLogin).not.toHaveBeenCalled();
    expect(cmp.error()).toMatch(/could not be verified/i);
  });

  it('errors when the login token is missing', () => {
    const completeSsoLogin = vi.fn();
    configure({
      auth: { completeSsoLogin } as unknown as AuthService,
      token: null,
    });
    const cmp = TestBed.createComponent(SsoCallbackPage).componentInstance;

    cmp.ngOnInit();

    expect(cmp.error()).toMatch(/missing/i);
    expect(completeSsoLogin).not.toHaveBeenCalled();
  });

  it('still strips the token from the URL when the homeserver is missing', () => {
    const { replaceState } = configure({
      auth: { completeSsoLogin: vi.fn() } as unknown as AuthService,
      token: 'TOKEN',
    });
    const cmp = TestBed.createComponent(SsoCallbackPage).componentInstance;

    cmp.ngOnInit();

    expect(replaceState).toHaveBeenCalledWith('/sso-callback');
    expect(cmp.error()).toMatch(/missing/i);
  });

  it('surfaces a completion error', () => {
    sessionStorage.setItem('sso.baseUrl', 'https://hs.example');
    sessionStorage.setItem('sso.state', 'NONCE');
    const { navigateByUrl } = configure({
      auth: {
        completeSsoLogin: vi.fn(() =>
          throwError(() => new Error('token expired')),
        ),
      } as unknown as AuthService,
      token: 'TOKEN',
      state: 'NONCE',
    });
    const cmp = TestBed.createComponent(SsoCallbackPage).componentInstance;

    cmp.ngOnInit();

    expect(cmp.error()).toBe('token expired');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
