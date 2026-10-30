import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, defer, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStorageService } from '@trinity/platform-native';
import type { SessionEngine, SessionStorageEffect } from './session-engine';
import { SESSION_ENGINE } from './session-engine.token';
import { provideSessionStorageEffects } from './session-storage-effects';

describe('SessionStorageEffects', () => {
  let effects: Subject<SessionStorageEffect>;
  let storage: SessionStorageService;
  let calls: string[];

  beforeEach(() => {
    effects = new Subject();
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(SessionStorageService),
        {
          provide: SESSION_ENGINE,
          useValue: { storageEffects: () => effects } satisfies Pick<
            SessionEngine,
            'storageEffects'
          >,
        },
        provideSessionStorageEffects(),
      ],
    });
    storage = TestBed.inject(SessionStorageService);
    // A write is recorded when it is sent (subscribed), not when it is built.
    const write = (name: string) => (id: string) =>
      defer(() => {
        calls.push(`${name}:${id}`);
        return of(undefined);
      });
    vi.mocked(storage.invalidateToken).mockImplementation(
      write('invalidateToken'),
    );
    vi.mocked(storage.remove).mockImplementation(write('remove'));
    vi.mocked(storage.setActive).mockImplementation(write('setActive'));
    vi.mocked(storage.updateTokens).mockReturnValue(of(undefined));
  });

  afterEach(() => vi.restoreAllMocks());

  it('soft logout invalidates the token, then repoints the active account', () => {
    effects.next({
      kind: 'soft-logout',
      accountId: '@a',
      activeAccountId: '@b',
    });

    expect(calls).toEqual(['invalidateToken:@a', 'setActive:@b']);
  });

  it('hard logout removes the record and skips setActive without an active account', () => {
    effects.next({
      kind: 'hard-logout',
      accountId: '@a',
      activeAccountId: null,
    });

    expect(calls).toEqual(['remove:@a']);
  });

  it('sends the repoint while the logout write is still pending', () => {
    vi.mocked(storage.remove).mockImplementationOnce((id) =>
      defer(() => {
        calls.push(`remove:${id}`);
        return NEVER;
      }),
    );

    effects.next({
      kind: 'hard-logout',
      accountId: '@a',
      activeAccountId: '@b',
    });

    expect(calls).toEqual(['remove:@a', 'setActive:@b']);
  });

  it('sends the writes of effects emitted back to back in emission order', () => {
    vi.mocked(storage.remove).mockImplementationOnce((id) =>
      defer(() => {
        calls.push(`remove:${id}`);
        return NEVER;
      }),
    );

    effects.next({
      kind: 'hard-logout',
      accountId: '@a',
      activeAccountId: '@b',
    });
    effects.next({
      kind: 'soft-logout',
      accountId: '@c',
      activeAccountId: '@d',
    });

    expect(calls).toEqual([
      'remove:@a',
      'setActive:@b',
      'invalidateToken:@c',
      'setActive:@d',
    ]);
  });

  it('rotated tokens update under their lineage', () => {
    effects.next({
      kind: 'tokens-rotated',
      accountId: '@a',
      lineage: 'L',
      accessToken: 't',
      refreshToken: null,
      expiresAt: null,
    });

    expect(storage.updateTokens).toHaveBeenCalledExactlyOnceWith(
      '@a',
      'L',
      't',
      undefined,
      undefined,
    );
  });

  it('a failed write does not stop later effects', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(storage.remove).mockImplementationOnce((id) =>
      defer(() => {
        calls.push(`remove:${id}`);
        return throwError(() => new Error('secure store locked'));
      }),
    );

    effects.next({
      kind: 'hard-logout',
      accountId: '@a',
      activeAccountId: '@b',
    });
    effects.next({
      kind: 'soft-logout',
      accountId: '@c',
      activeAccountId: null,
    });

    // Logout writes are best-effort: the repoint still runs, and nothing is reported.
    expect(calls).toEqual(['remove:@a', 'setActive:@b', 'invalidateToken:@c']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a failed token save by its kind alone and goes on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(storage.updateTokens).mockReturnValueOnce(
      throwError(() => new Error('secure store locked')),
    );

    effects.next({
      kind: 'tokens-rotated',
      accountId: '@a',
      lineage: null,
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAt: 1,
    });
    effects.next({
      kind: 'soft-logout',
      accountId: '@a',
      activeAccountId: null,
    });

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Couldn't save the session.",
      'tokens-rotated',
    );
    expect(calls).toEqual(['invalidateToken:@a']);
  });
});
