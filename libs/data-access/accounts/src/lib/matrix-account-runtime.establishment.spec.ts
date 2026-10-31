import { TestBed } from '@angular/core/testing';
import { NEVER, defer, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountAlreadyStoredError,
  AccountHomeserverMismatchError,
  type AccountRecord,
} from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import { AuthenticatedAccountGrant } from './authenticated-account-grant';
import type { AccountEstablishmentIntent } from './account-runtime.models';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import {
  activeIntent,
  session,
  settled,
  setup,
  type AdapterTest,
} from './matrix-account-runtime.spec-harness';

it('prepares only live Accounts for an Active Account switch', async () => {
  const { adapter, matrix } = setup();

  await expect(
    firstValueFrom(adapter.prepareActiveAccount('@next:hs')),
  ).resolves.toEqual({ kind: 'ready' });
  vi.mocked(matrix.clientFor).mockReturnValue(null);
  await expect(
    firstValueFrom(adapter.prepareActiveAccount('@missing:hs')),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'account-unavailable',
  });
});

it('persists the Active pointer before publishing the switched client', async () => {
  const { adapter, matrix, storage } = setup();
  const order: string[] = [];
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
    defer(() => {
      order.push('persist-active');
      return of(void 0);
    }),
  );
  vi.mocked(matrix.setActive).mockImplementation(() => {
    order.push('activate');
  });

  await expect(
    firstValueFrom(adapter.commitActiveAccount('@next:hs')),
  ).resolves.toEqual({ kind: 'ready' });

  expect(order).toEqual(['persist-active', 'activate']);
});

it('types Active pointer failures without publishing the target client', async () => {
  const { adapter, matrix, storage } = setup();
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
    throwError(() => new DOMException('quota', 'QuotaExceededError')),
  );

  await expect(
    firstValueFrom(adapter.commitActiveAccount('@next:hs')),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'local-state-unavailable',
  });
  expect(matrix.setActive).not.toHaveBeenCalled();
});

it('keeps a tokenless saved Account visible to reauthentication surfaces', async () => {
  const { adapter, matrix, storage } = setup(null);
  vi.mocked(storage.load).mockReturnValue(of(null));

  await expect(
    firstValueFrom(adapter.restoreAccount('@reauth:hs', 'inactive')),
  ).resolves.toEqual({ kind: 'reauthentication-required' });
  expect(matrix.requireReauthentication).toHaveBeenCalledWith('@reauth:hs');
  expect(matrix.restorePersisted).not.toHaveBeenCalled();
});

it('persists, starts in the background, then commits Active placement', async () => {
  const { adapter, matrix, storage } = setup();
  const order: string[] = [];
  vi.mocked(storage.persistForEstablishment).mockReturnValue(
    defer(() => {
      order.push('persist');
      return of(session);
    }),
  );
  vi.mocked(matrix.restorePersisted).mockReturnValue(
    defer(() => {
      order.push('start');
      return of({ kind: 'ready' as const });
    }),
  );
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
    defer(() => {
      order.push('persist-active');
      return of(void 0);
    }),
  );
  vi.mocked(matrix.activateAccount).mockImplementation(() => {
    order.push('activate');
  });

  await expect(
    firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({ kind: 'ready' });

  expect(order).toEqual(['persist', 'start', 'persist-active', 'activate']);
  expect(storage.persistForEstablishment).toHaveBeenCalledWith(
    session,
    'upsert',
  );
  expect(matrix.restorePersisted).toHaveBeenCalledWith(session, 'background');
  expect(matrix.activateAccount).toHaveBeenCalledWith('@new:hs', 'replace');
});

describe('a sign-in over an unreadable native record', () => {
  it('removes the record once the sign-in is saved, before its client starts', async () => {
    const { adapter, matrix, storage, nativeTokens } = setup();
    const order: string[] = [];
    vi.mocked(storage.persistForEstablishment).mockReturnValue(
      defer(() => {
        order.push('persist');
        return of(session);
      }),
    );
    vi.mocked(nativeTokens.removeUnreadableRecord).mockReturnValue(
      defer(() => {
        order.push('remove');
        return of(void 0);
      }),
    );
    vi.mocked(matrix.restorePersisted).mockReturnValue(
      defer(() => {
        order.push('start');
        return of({ kind: 'ready' as const });
      }),
    );
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));

    await firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    );

    expect(order).toEqual(['persist', 'remove', 'start']);
    expect(nativeTokens.removeUnreadableRecord).toHaveBeenCalledWith(session);
  });

  it('leaves the record to a retried first establishment, whose pair native may have rotated', async () => {
    const { adapter, matrix, storage, nativeTokens } = setup();
    const grant = AuthenticatedAccountGrant.issue(session);
    const intent = {
      ...activeIntent,
      accountRecord: 'new',
    } satisfies AccountEstablishmentIntent;
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));
    vi.mocked(matrix.restorePersisted).mockReturnValueOnce(
      of({ kind: 'failed' as const, failure: 'transient-network' as const }),
    );
    vi.mocked(matrix.restorePersisted).mockReturnValue(
      of({ kind: 'ready' as const }),
    );

    await firstValueFrom(adapter.establishAccount(grant, intent));
    await firstValueFrom(adapter.establishAccount(grant, intent));

    expect(matrix.restorePersisted).toHaveBeenCalledTimes(2);
    expect(storage.persistForEstablishment).toHaveBeenCalledOnce();
    expect(nativeTokens.removeUnreadableRecord).toHaveBeenCalledOnce();
  });
});

describe('without a usable keychain', () => {
  function withoutKeychain(test: AdapterTest): void {
    vi.mocked(test.secure.withoutKeychain).mockResolvedValue(true);
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(test.matrix.restorePersisted).mockReturnValue(
      of({ kind: 'ready' as const }),
    );
    vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(
      of(void 0),
    );
  }

  function establish(test: AdapterTest) {
    return firstValueFrom(
      test.adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    );
  }

  it('stores nothing and touches no live account when the person declines', async () => {
    const test = setup();
    withoutKeychain(test);

    await expect(establish(test)).resolves.toEqual({
      kind: 'failed',
      failure: 'unprotected-storage-declined',
    });
    expect(test.consent.confirm).toHaveBeenCalledOnce();
    expect(test.storage.persistForEstablishment).not.toHaveBeenCalled();
    expect(test.lifecycle.unregisterNotifications).not.toHaveBeenCalled();
    expect(test.secure.acknowledgeUnprotectedStorage).not.toHaveBeenCalled();
  });

  it('records the consent and signs in when the person agrees', async () => {
    const test = setup();
    withoutKeychain(test);
    vi.mocked(test.consent.confirm).mockReturnValue(of(true));

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
    expect(test.secure.acknowledgeUnprotectedStorage).toHaveBeenCalledWith(
      'consented',
    );
    expect(test.storage.persistForEstablishment).toHaveBeenCalled();
  });

  it('does not ask again once this device has agreed', async () => {
    const test = setup();
    withoutKeychain(test);
    vi.mocked(test.secure.unprotectedStorageAcknowledged).mockResolvedValue(
      'consented',
    );

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
    expect(test.consent.confirm).not.toHaveBeenCalled();
  });

  it('still asks when the person was only told about earlier unprotected storage', async () => {
    const test = setup();
    withoutKeychain(test);
    vi.mocked(test.secure.unprotectedStorageAcknowledged).mockResolvedValue(
      'notified',
    );

    await establish(test);
    expect(test.consent.confirm).toHaveBeenCalledOnce();
  });
});

it('never asks for consent where the keychain works', async () => {
  const test = setup();
  vi.mocked(test.storage.persistForEstablishment).mockReturnValue(of(session));
  vi.mocked(test.matrix.restorePersisted).mockReturnValue(
    of({ kind: 'ready' as const }),
  );
  vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(of(void 0));

  await firstValueFrom(
    test.adapter.establishAccount(
      AuthenticatedAccountGrant.issue(session),
      activeIntent,
    ),
  );
  expect(test.consent.confirm).not.toHaveBeenCalled();
});

it('empties the push handoff before replacing the live Accounts', async () => {
  const { adapter, matrix, storage, lifecycle } = setup();
  const order: string[] = [];
  vi.mocked(lifecycle.forgetPushHandoff).mockReturnValue(
    defer(() => {
      order.push('forget-handoff');
      return of(void 0);
    }),
  );
  vi.mocked(lifecycle.unregisterNotifications).mockReturnValue(
    defer(() => {
      order.push('unregister');
      return of(void 0);
    }),
  );
  vi.mocked(storage.persistForEstablishment).mockReturnValue(
    defer(() => {
      order.push('persist');
      return of(session);
    }),
  );
  vi.mocked(matrix.restorePersisted).mockReturnValue(
    of({ kind: 'ready' as const }),
  );
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));

  await firstValueFrom(
    adapter.establishAccount(
      AuthenticatedAccountGrant.issue(session),
      activeIntent,
    ),
  );

  expect(lifecycle.forgetPushHandoff).toHaveBeenCalledWith();
  expect(order).toEqual(['forget-handoff', 'unregister', 'persist']);
});

it('still signs in and tears pushers down when the push handoff refuses to empty', async () => {
  const { adapter, matrix, storage, lifecycle } = setup();
  vi.mocked(lifecycle.forgetPushHandoff).mockReturnValue(
    throwError(() => new Error('keychain locked')),
  );
  vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
  vi.mocked(matrix.restorePersisted).mockReturnValue(
    of({ kind: 'ready' as const }),
  );
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));

  await expect(
    firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({ kind: 'ready' });
  expect(lifecycle.unregisterNotifications).toHaveBeenCalledWith();
  expect(storage.persistForEstablishment).toHaveBeenCalledOnce();
});

it('still signs in and tears pushers down when emptying the push handoff never settles', async () => {
  vi.useFakeTimers();
  try {
    const { adapter, matrix, storage, lifecycle } = setup();
    vi.mocked(lifecycle.forgetPushHandoff).mockReturnValue(NEVER);
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
    vi.mocked(matrix.restorePersisted).mockReturnValue(
      of({ kind: 'ready' as const }),
    );
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));
    const outcomes: unknown[] = [];

    adapter
      .establishAccount(AuthenticatedAccountGrant.issue(session), activeIntent)
      .subscribe((outcome) => outcomes.push(outcome));
    await vi.advanceTimersByTimeAsync(
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
    );

    expect(outcomes).toEqual([{ kind: 'ready' }]);
    expect(lifecycle.unregisterNotifications).toHaveBeenCalledWith();
    expect(storage.persistForEstablishment).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

describe('replacing a stored device', () => {
  const OLD_SESSION = {
    ...session,
    deviceId: 'OLDDEVICE',
    accessToken: 'old-access',
  };

  function establish(test: AdapterTest, order: string[] = []) {
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      defer(() => {
        order.push('persist');
        return of(session);
      }),
    );
    vi.mocked(test.matrix.restorePersisted).mockReturnValue(
      defer(() => {
        order.push('start');
        return of({ kind: 'ready' as const });
      }),
    );
    vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(
      of(void 0),
    );
    return firstValueFrom(
      test.adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    );
  }

  /** The saved state: its token-free record, and the session when it has a token. */
  function saved(test: AdapterTest, stored: MatrixSession | null) {
    const record = stored && withoutTokens(stored);
    vi.mocked(test.storage.record).mockReturnValue(of(record));
    vi.mocked(test.storage.load).mockReturnValue(of(stored));
  }

  function withoutTokens(stored: MatrixSession): AccountRecord {
    const { accessToken: _access, refreshToken: _refresh, ...record } = stored;
    return record;
  }

  function unreadable(test: AdapterTest) {
    vi.mocked(test.storage.record).mockReturnValue(
      throwError(() => new Error('storage locked')),
    );
    vi.mocked(test.storage.load).mockReturnValue(
      throwError(() => new Error('storage locked')),
    );
  }

  const NEW_DEVICE = { accountId: '@new:hs', deviceId: 'DEVICE' };

  /** Every new-device fact the adapter publishes from now on. */
  function published(test: AdapterTest, order?: string[]) {
    const facts: unknown[] = [];
    test.adapter.newDevices.subscribe((fact) => {
      order?.push('new-device');
      facts.push(fact);
    });
    return facts;
  }

  it('marks a first sign-in on this installation as a new device', async () => {
    const test = setup();
    saved(test, null);
    const facts = published(test);

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([NEW_DEVICE]);
  });

  it('publishes the new device as soon as its record is saved, before its session starts', async () => {
    const test = setup();
    saved(test, null);
    const order: string[] = [];
    published(test, order);

    await establish(test, order);

    expect(order).toEqual(['persist', 'new-device', 'start']);
  });

  it('marks an OIDC sign-in that created a new device id as a new device', async () => {
    const test = setup();
    const oidc: MatrixSession = {
      ...session,
      refreshToken: 'refresh',
      oidc: {
        issuer: 'https://issuer',
        clientId: 'client',
        redirectUri: 'https://app/sso-callback',
      },
    };
    saved(test, { ...oidc, deviceId: 'OLDDEVICE' });
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(of(oidc));
    vi.mocked(test.matrix.restorePersisted).mockReturnValue(
      of({ kind: 'ready' as const }),
    );
    vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(
      of(void 0),
    );
    vi.mocked(test.matrix.detachedClient).mockReturnValue({
      logout: vi.fn(() => Promise.resolve()),
    } as never);
    const facts = published(test);

    await expect(
      firstValueFrom(
        test.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(oidc),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([NEW_DEVICE]);
  });

  it('does not guess when the saved record cannot be read', async () => {
    const test = setup();
    unreadable(test);
    const facts = published(test);

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([]);
  });

  it('publishes a new account’s device once, from the attempt that saved it, when its establishment is retried', async () => {
    const test = setup();
    const newRecord = {
      ...activeIntent,
      accountRecord: 'new',
    } satisfies AccountEstablishmentIntent;
    const grant = AuthenticatedAccountGrant.issue(session);
    unreadable(test);
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(test.matrix.restorePersisted)
      .mockReturnValueOnce(
        of({
          kind: 'failed' as const,
          failure: 'transient-network' as const,
        }),
      )
      .mockReturnValueOnce(of({ kind: 'ready' as const }));
    vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(
      of(void 0),
    );
    const facts = published(test);

    await expect(
      firstValueFrom(test.adapter.establishAccount(grant, newRecord)),
    ).resolves.toEqual({ kind: 'failed', failure: 'transient-network' });
    expect(facts).toEqual([NEW_DEVICE]);
    await expect(
      firstValueFrom(test.adapter.establishAccount(grant, newRecord)),
    ).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([NEW_DEVICE]);
    expect(test.storage.persistForEstablishment).toHaveBeenCalledOnce();
  });

  it('publishes a new device whose establishment is cancelled right after the save, and not again on retry', async () => {
    // Closing the app between the save and the outcome must not skip the check: the
    // next launch restores the saved record as an existing device.
    const test = setup();
    const newRecord = {
      ...activeIntent,
      accountRecord: 'new',
    } satisfies AccountEstablishmentIntent;
    const grant = AuthenticatedAccountGrant.issue(session);
    unreadable(test);
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(test.matrix.restorePersisted)
      .mockReturnValueOnce(NEVER)
      .mockReturnValueOnce(of({ kind: 'ready' as const }));
    vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(
      of(void 0),
    );
    const facts = published(test);

    const first = test.adapter.establishAccount(grant, newRecord).subscribe();
    await settled();
    first.unsubscribe();
    expect(facts).toEqual([NEW_DEVICE]);

    await expect(
      firstValueFrom(test.adapter.establishAccount(grant, newRecord)),
    ).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([NEW_DEVICE]);
    expect(test.storage.persistForEstablishment).toHaveBeenCalledOnce();
  });

  it('publishes a re-login’s new device when the establishment is cancelled right after the save', async () => {
    const test = setup();
    saved(test, { ...OLD_SESSION });
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(test.matrix.restorePersisted).mockReturnValue(NEVER);
    const facts = published(test);

    const attempt = test.adapter
      .establishAccount(AuthenticatedAccountGrant.issue(session), activeIntent)
      .subscribe();
    await settled();
    attempt.unsubscribe();

    expect(facts).toEqual([NEW_DEVICE]);
  });

  it('publishes a saved new device even when its session does not start, and not again on retry', async () => {
    const test = setup();
    const grant = AuthenticatedAccountGrant.issue(session);
    // The failed attempt saved the new device's record; the retry reads it back.
    vi.mocked(test.storage.record)
      .mockReturnValueOnce(of(null))
      .mockReturnValueOnce(of(withoutTokens(session)));
    vi.mocked(test.storage.load).mockReturnValue(of(session));
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(test.matrix.restorePersisted)
      .mockReturnValueOnce(
        of({
          kind: 'failed' as const,
          failure: 'transient-network' as const,
        }),
      )
      .mockReturnValueOnce(of({ kind: 'ready' as const }));
    vi.mocked(test.storage.setActiveForEstablishment).mockReturnValue(
      of(void 0),
    );
    const facts = published(test);

    await expect(
      firstValueFrom(test.adapter.establishAccount(grant, activeIntent)),
    ).resolves.toEqual({ kind: 'failed', failure: 'transient-network' });
    expect(facts).toEqual([NEW_DEVICE]);
    await expect(
      firstValueFrom(test.adapter.establishAccount(grant, activeIntent)),
    ).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([NEW_DEVICE]);
  });

  it('signs the replaced device out with its old token once the new session has started', async () => {
    const test = setup();
    const order: string[] = [];
    const logout = vi.fn(() => {
      order.push('logout');
      return Promise.resolve();
    });
    saved(test, OLD_SESSION);
    vi.mocked(test.matrix.detachedClient).mockReturnValue({
      logout,
    } as never);

    await expect(establish(test, order)).resolves.toEqual({ kind: 'ready' });

    expect(test.storage.load).toHaveBeenCalledWith('@new:hs');
    // Its token refreshes must never be saved over the new device's tokens.
    expect(test.matrix.detachedClient).toHaveBeenCalledWith(OLD_SESSION, {
      persistRefreshedTokens: false,
    });
    expect(logout).toHaveBeenCalledWith(true);
    // The old record is read before the save overwrites it; the sign-out waits until the
    // new session is saved and started, which also detached any old live client.
    expect(order).toEqual(['persist', 'start', 'logout']);
  });

  it("removes the replaced device's native tokens after its sign-out ran", async () => {
    const test = setup();
    const order: string[] = [];
    saved(test, OLD_SESSION);
    vi.mocked(test.matrix.detachedClient).mockReturnValue({
      logout: vi.fn(() => {
        order.push('logout');
        return Promise.reject(new Error('offline'));
      }),
    } as never);
    vi.mocked(test.storage.removeNativeTokens).mockImplementation(() => {
      order.push('removeNativeTokens');
      return of(void 0);
    });

    await expect(establish(test, order)).resolves.toEqual({ kind: 'ready' });
    await settled();

    expect(test.storage.removeNativeTokens).toHaveBeenCalledExactlyOnceWith(
      '@new:hs',
    );
    expect(order).toEqual(['persist', 'start', 'logout', 'removeNativeTokens']);
  });

  it('keeps the replaced device signed in when saving the new session fails', async () => {
    const test = setup();
    saved(test, OLD_SESSION);
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      throwError(() => new DOMException('quota', 'QuotaExceededError')),
    );

    await expect(
      firstValueFrom(
        test.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'local-state-unavailable',
    });
    expect(test.matrix.detachedClient).not.toHaveBeenCalled();
  });

  it('keeps the replaced device signed in when the new session does not start', async () => {
    const test = setup();
    saved(test, OLD_SESSION);
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(test.matrix.restorePersisted).mockReturnValue(
      of({ kind: 'failed' as const, failure: 'transient-network' as const }),
    );

    await expect(
      firstValueFrom(
        test.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({ kind: 'failed', failure: 'transient-network' });
    expect(test.matrix.detachedClient).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', () => Promise.reject(new Error('offline'))],
    ['never answers', () => new Promise<never>(() => undefined)],
  ])('still signs in when that logout %s', async (_case, logout) => {
    const test = setup();
    saved(test, OLD_SESSION);
    vi.mocked(test.matrix.detachedClient).mockReturnValue({
      logout: vi.fn(logout),
    } as never);

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
  });

  it('leaves a device saved through another server signed in when the sign-in is refused', async () => {
    const test = setup();
    saved(test, { ...OLD_SESSION, baseUrl: 'https://stored.example' });
    vi.mocked(test.storage.persistForEstablishment).mockReturnValue(
      throwError(
        () =>
          new AccountHomeserverMismatchError(
            session.userId,
            'https://stored.example',
          ),
      ),
    );

    await expect(
      firstValueFrom(
        test.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'homeserver-mismatch',
      storedBaseUrl: 'https://stored.example',
    });
    expect(test.matrix.detachedClient).not.toHaveBeenCalled();
  });

  it('still signs in when the detached client cannot be built', async () => {
    const test = setup();
    saved(test, OLD_SESSION);
    vi.mocked(test.matrix.detachedClient).mockImplementation(() => {
      throw new Error('bad base URL');
    });

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
  });

  it('does not mark a re-login on the device of a signed-out account as new', async () => {
    const test = setup();
    // Signing out keeps the record and its device id but drops the token, so the
    // session cannot be loaded.
    vi.mocked(test.storage.load).mockReturnValue(of(null));
    vi.mocked(test.storage.record).mockReturnValue(
      of({ baseUrl: 'https://hs', userId: '@new:hs', deviceId: 'DEVICE' }),
    );
    const facts = published(test);

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([]);

    expect(test.matrix.detachedClient).not.toHaveBeenCalled();
  });

  it('leaves the device alone on a same-device re-login', async () => {
    const test = setup();
    saved(test, session);
    const facts = published(test);

    await expect(establish(test)).resolves.toEqual({ kind: 'ready' });
    expect(facts).toEqual([]);

    expect(test.matrix.detachedClient).not.toHaveBeenCalled();
  });
});

it('keeps inactive placement in the background without changing Active Account', async () => {
  const { adapter, matrix, storage } = setup();
  vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
  vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));

  await expect(
    firstValueFrom(
      adapter.establishAccount(AuthenticatedAccountGrant.issue(session), {
        placement: 'inactive',
        liveAccounts: 'keep',
        accountRecord: 'upsert',
      }),
    ),
  ).resolves.toEqual({ kind: 'ready' });

  expect(storage.setActiveForEstablishment).not.toHaveBeenCalled();
  expect(matrix.activateAccount).not.toHaveBeenCalled();
});

it('requires an existing Active Account before inactive placement', async () => {
  const { adapter, matrix, storage } = setup(null);

  await expect(
    firstValueFrom(
      adapter.establishAccount(AuthenticatedAccountGrant.issue(session), {
        placement: 'inactive',
        liveAccounts: 'keep',
        accountRecord: 'upsert',
      }),
    ),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'active-account-required',
  });
  expect(storage.persistForEstablishment).not.toHaveBeenCalled();
  expect(matrix.restorePersisted).not.toHaveBeenCalled();
});

it('emits expected persistence and startup failures as typed outcomes', async () => {
  const first = setup();
  vi.mocked(first.storage.persistForEstablishment).mockReturnValue(
    throwError(() => new AccountAlreadyStoredError('@new:hs')),
  );

  await expect(
    firstValueFrom(
      first.adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'account-already-stored',
  });

  TestBed.resetTestingModule();
  const second = setup();
  vi.mocked(second.storage.persistForEstablishment).mockReturnValue(
    of(session),
  );
  vi.mocked(second.matrix.restorePersisted).mockReturnValue(
    of({ kind: 'failed', failure: 'transient-network' }),
  );

  await expect(
    firstValueFrom(
      second.adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'transient-network',
  });
  expect(second.storage.setActiveForEstablishment).not.toHaveBeenCalled();
  expect(second.matrix.activateAccount).not.toHaveBeenCalled();
});

it('reports a sign-in through another server as a typed failure and starts no live client', async () => {
  const { adapter, matrix, storage } = setup();
  vi.mocked(storage.persistForEstablishment).mockReturnValue(
    throwError(
      () =>
        new AccountHomeserverMismatchError('@new:hs', 'https://stored.example'),
    ),
  );

  await expect(
    firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'homeserver-mismatch',
    storedBaseUrl: 'https://stored.example',
  });
  expect(matrix.restorePersisted).not.toHaveBeenCalled();
  expect(storage.setActiveForEstablishment).not.toHaveBeenCalled();
  expect(matrix.activateAccount).not.toHaveBeenCalled();
});

it('types recognized storage outages but preserves adapter defects', async () => {
  const first = setup();
  vi.mocked(first.storage.persistForEstablishment).mockReturnValue(
    throwError(() => new DOMException('quota', 'QuotaExceededError')),
  );

  await expect(
    firstValueFrom(
      first.adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'local-state-unavailable',
  });

  TestBed.resetTestingModule();
  const second = setup();
  const defect = Object.assign(new Error('broken storage adapter'), {
    code: 'KEYSTORE_INVARIANT_BROKEN',
  });
  vi.mocked(second.storage.persistForEstablishment).mockReturnValue(
    throwError(() => defect),
  );

  await expect(
    firstValueFrom(
      second.adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).rejects.toBe(defect);
});

it('rolls back the live Account when Active-pointer persistence fails', async () => {
  const { adapter, matrix, storage } = setup();
  vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
  vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
    throwError(() => new DOMException('quota', 'QuotaExceededError')),
  );

  await expect(
    firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).resolves.toEqual({
    kind: 'failed',
    failure: 'local-state-unavailable',
  });
  expect(matrix.activateAccount).not.toHaveBeenCalled();
  expect(matrix.rollbackAccountStart).toHaveBeenCalledWith('@new:hs');
  expect(storage.restoreActiveAfterFailedEstablishment).not.toHaveBeenCalled();
});

it('restores the previous Active pointer when live activation throws after persistence', async () => {
  const { adapter, matrix, storage } = setup('@old:hs');
  const defect = new Error('activation invariant failed');
  vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
  vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));
  vi.mocked(storage.restoreActiveAfterFailedEstablishment).mockReturnValue(
    of(void 0),
  );
  vi.mocked(matrix.activateAccount).mockImplementation(() => {
    throw defect;
  });

  await expect(
    firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).rejects.toBe(defect);
  expect(matrix.rollbackAccountStart).toHaveBeenCalledWith('@new:hs');
  expect(storage.restoreActiveAfterFailedEstablishment).toHaveBeenCalledWith(
    '@old:hs',
  );
});

it('does not commit Active placement when the started Account is not live', async () => {
  const { adapter, matrix, storage } = setup();
  vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
  vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));
  vi.mocked(matrix.clientFor).mockReturnValue(null);

  await expect(
    firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        activeIntent,
      ),
    ),
  ).rejects.toThrow(/non-live Account/);
  expect(storage.setActiveForEstablishment).not.toHaveBeenCalled();
  expect(matrix.activateAccount).not.toHaveBeenCalled();
});

it('does not inspect or persist the grant before subscription', () => {
  const { adapter, storage } = setup();

  adapter.establishAccount(
    AuthenticatedAccountGrant.issue(session),
    activeIntent,
  );

  expect(storage.persistForEstablishment).not.toHaveBeenCalled();
});

it('retries an identical persisted new-Account grant without saving it again', async () => {
  const { adapter, matrix, storage } = setup();
  const stored = { ...session, cryptoPrefix: 'prefix' };
  vi.mocked(storage.persistForEstablishment).mockReturnValue(of(stored));
  vi.mocked(matrix.restorePersisted)
    .mockReturnValueOnce(of({ kind: 'failed', failure: 'transient-network' }))
    .mockReturnValueOnce(of({ kind: 'ready' }));
  vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));
  const intent = { ...activeIntent, accountRecord: 'new' } as const;
  await firstValueFrom(
    adapter.establishAccount(AuthenticatedAccountGrant.issue(session), intent),
  );
  await firstValueFrom(
    adapter.establishAccount(
      AuthenticatedAccountGrant.issue({ ...session }),
      intent,
    ),
  );

  expect(storage.persistForEstablishment).toHaveBeenCalledOnce();
  expect(matrix.restorePersisted).toHaveBeenCalledTimes(2);
});
