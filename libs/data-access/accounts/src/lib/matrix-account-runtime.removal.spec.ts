import { Subject, defer, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { MatrixSession } from '@trinity/util/matrix';
import type { AccountSignOutOutcome } from './account-runtime.models';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import {
  OIDC_RECORD,
  OIDC_STORED,
  setup,
} from './matrix-account-runtime.spec-harness';

describe('MatrixAccountRuntimeAdapter', () => {
  describe('removing a deleted account', () => {
    function deletedAccount(
      accountIds: readonly string[],
      test = setup(accountIds[0]),
    ) {
      const client = { logout: vi.fn(() => Promise.resolve()) };
      vi.mocked(test.matrix.clientFor).mockReturnValue(client as never);
      vi.mocked(test.storage.list).mockReturnValue(
        of(
          accountIds.map((userId, index) => ({
            userId,
            baseUrl: 'https://hs',
            deviceId: `D${index}`,
          })),
        ),
      );
      vi.mocked(test.matrix.remove).mockImplementation(() => {
        test.active.set(accountIds[1] ?? null);
        return of(void 0);
      });
      vi.mocked(test.storage.remove).mockReturnValue(of(void 0));
      vi.mocked(test.storage.setActive).mockReturnValue(of(void 0));
      vi.mocked(test.storage.clear).mockReturnValue(of(void 0));
      return { ...test, client };
    }

    it('removes it locally without contacting its homeserver', async () => {
      const test = deletedAccount(['@deleted:hs', '@survivor:hs']);

      await expect(
        firstValueFrom(test.adapter.removeDeletedAccount('@deleted:hs')),
      ).resolves.toEqual({
        kind: 'ready',
        accountId: '@deleted:hs',
        activeAccountId: '@survivor:hs',
        remainingAccountIds: ['@survivor:hs'],
      });
      expect(test.client.logout).not.toHaveBeenCalled();
      expect(test.lifecycle.unregisterNotifications).not.toHaveBeenCalled();
      expect(test.lifecycle.revokeProviderSession).not.toHaveBeenCalled();
      expect(test.lifecycle.forgetPushHandoff).toHaveBeenCalledWith(
        '@deleted:hs',
      );
      expect(test.matrix.remove).toHaveBeenCalledWith('@deleted:hs');
      expect(test.storage.remove).toHaveBeenCalledWith('@deleted:hs');
      expect(test.storage.setActive).toHaveBeenCalledWith('@survivor:hs');
    });

    it('forgets its account-scoped device preferences', async () => {
      const test = deletedAccount(['@deleted:hs', '@survivor:hs']);

      await firstValueFrom(test.adapter.removeDeletedAccount('@deleted:hs'));

      expect(test.lifecycle.forgetAccountPreferences).toHaveBeenCalledWith(
        '@deleted:hs',
      );
    });

    it('clears the local push registration after the client is gone when it was the last account', async () => {
      const test = deletedAccount(['@deleted:hs']);

      await expect(
        firstValueFrom(test.adapter.removeDeletedAccount('@deleted:hs')),
      ).resolves.toEqual({
        kind: 'ready',
        accountId: '@deleted:hs',
        activeAccountId: null,
        remainingAccountIds: [],
      });
      expect(test.lifecycle.unregisterNotifications).toHaveBeenCalledWith();
      expect(
        vi.mocked(test.matrix.remove).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(test.lifecycle.unregisterNotifications).mock
          .invocationCallOrder[0],
      );
      expect(test.lifecycle.releaseSharedCaches).toHaveBeenCalledOnce();
      expect(test.storage.clear).toHaveBeenCalledOnce();
      expect(test.client.logout).not.toHaveBeenCalled();
    });

    it('reports preferences it could not forget as partial cleanup', async () => {
      const test = deletedAccount(['@deleted:hs', '@survivor:hs']);
      vi.mocked(test.lifecycle.forgetAccountPreferences).mockReturnValue(
        throwError(() => new Error('disk full')),
      );

      await expect(
        firstValueFrom(test.adapter.removeDeletedAccount('@deleted:hs')),
      ).resolves.toMatchObject({
        kind: 'partial-cleanup',
        issues: [{ scope: 'preferences', recovery: 'retry-sign-out' }],
      });
      expect(test.storage.remove).toHaveBeenCalledWith('@deleted:hs');
    });

    it('forgets its mention history after its client stops', async () => {
      const test = deletedAccount(['@deleted:hs', '@survivor:hs']);
      const order: string[] = [];
      vi.mocked(test.matrix.remove).mockReturnValue(
        defer(() => {
          order.push('remove');
          return of(void 0);
        }),
      );
      vi.mocked(test.lifecycle.forgetMentionHistory).mockReturnValue(
        defer(() => {
          order.push('forget');
          return of(void 0);
        }),
      );

      await firstValueFrom(test.adapter.removeDeletedAccount('@deleted:hs'));

      expect(
        test.lifecycle.forgetMentionHistory,
      ).toHaveBeenCalledExactlyOnceWith('@deleted:hs');
      expect(order).toEqual(['remove', 'forget']);
    });

    it('fails for an account the registry does not hold', async () => {
      const test = deletedAccount(['@survivor:hs'], setup('@survivor:hs'));

      await expect(
        firstValueFrom(test.adapter.removeDeletedAccount('@deleted:hs')),
      ).resolves.toEqual({
        kind: 'failed',
        accountId: '@deleted:hs',
        failure: 'account-unavailable',
        recovery: 'retry-sign-out',
      });
      expect(test.matrix.remove).not.toHaveBeenCalled();
    });
  });

  it('signs out one explicit Account while keeping the surviving Account active', async () => {
    const { adapter, matrix, storage, lifecycle, active } =
      setup('@outgoing:hs');
    const client = { logout: vi.fn(() => Promise.resolve()) };
    vi.mocked(matrix.clientFor).mockReturnValue(client as never);
    vi.mocked(storage.list).mockReturnValue(
      of([
        { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
        { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(
      of({ userId: '@outgoing:hs', baseUrl: 'https://hs' } as never),
    );
    vi.mocked(matrix.remove).mockImplementation(() => {
      active.set('@survivor:hs');
      return of(void 0);
    });
    vi.mocked(storage.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.setActive).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@outgoing:hs')),
    ).resolves.toEqual({
      kind: 'ready',
      accountId: '@outgoing:hs',
      activeAccountId: '@survivor:hs',
      remainingAccountIds: ['@survivor:hs'],
    });
    expect(lifecycle.unregisterNotifications).toHaveBeenCalledWith(
      '@outgoing:hs',
    );
    expect(matrix.remove).toHaveBeenCalledWith('@outgoing:hs');
    expect(storage.remove).toHaveBeenCalledWith('@outgoing:hs');
    expect(storage.setActive).toHaveBeenCalledWith('@survivor:hs');
    expect(lifecycle.clearDrafts).toHaveBeenCalledOnce();
  });

  it('fully clears local Account state when signing out the last Account', async () => {
    const { adapter, matrix, storage, lifecycle, active } = setup('@last:hs');
    vi.mocked(matrix.clientFor).mockReturnValue({
      logout: vi.fn(() => Promise.resolve()),
    } as never);
    vi.mocked(storage.list).mockReturnValue(
      of([{ userId: '@last:hs', baseUrl: 'https://hs', deviceId: 'A' }]),
    );
    vi.mocked(storage.load).mockReturnValue(
      of({ userId: '@last:hs', baseUrl: 'https://hs' } as never),
    );
    vi.mocked(matrix.remove).mockImplementation(() => {
      active.set(null);
      return of(void 0);
    });
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@last:hs')),
    ).resolves.toEqual({
      kind: 'ready',
      accountId: '@last:hs',
      activeAccountId: null,
      remainingAccountIds: [],
    });
    expect(lifecycle.unregisterNotifications).toHaveBeenCalledWith();
    expect(matrix.remove).toHaveBeenCalledWith('@last:hs');
    expect(lifecycle.releaseSharedCaches).toHaveBeenCalledOnce();
    expect(storage.clear).toHaveBeenCalledOnce();
  });

  describe('forgetting mention history on sign-out', () => {
    function signingOut(accountIds: readonly string[]) {
      const test = setup(accountIds[0]);
      vi.mocked(test.matrix.clientFor).mockReturnValue({
        logout: vi.fn(() => Promise.resolve()),
      } as never);
      vi.mocked(test.storage.list).mockReturnValue(
        of(
          accountIds.map((userId, index) => ({
            userId,
            baseUrl: 'https://hs',
            deviceId: `D${index}`,
          })),
        ),
      );
      vi.mocked(test.storage.load).mockReturnValue(
        of({ userId: accountIds[0], baseUrl: 'https://hs' } as never),
      );
      vi.mocked(test.storage.remove).mockReturnValue(of(void 0));
      vi.mocked(test.storage.setActive).mockReturnValue(of(void 0));
      vi.mocked(test.storage.clear).mockReturnValue(of(void 0));
      return test;
    }

    it.each([
      ['the last account', ['@out:hs']],
      ['one of several', ['@out:hs', '@other:hs']],
    ])('forgets it after the client stops for %s', async (_case, ids) => {
      const test = signingOut(ids);
      const order: string[] = [];
      vi.mocked(test.matrix.remove).mockReturnValue(
        defer(() => {
          order.push('remove');
          return of(void 0);
        }),
      );
      vi.mocked(test.lifecycle.forgetMentionHistory).mockReturnValue(
        defer(() => {
          order.push('forget');
          return of(void 0);
        }),
      );

      await firstValueFrom(test.adapter.signOutAccount('@out:hs'));

      expect(
        test.lifecycle.forgetMentionHistory,
      ).toHaveBeenCalledExactlyOnceWith('@out:hs');
      expect(order).toEqual(['remove', 'forget']);
    });

    it('reports a failed forget as an indexed-db issue that asks for a restart', async () => {
      const test = signingOut(['@out:hs', '@other:hs']);
      vi.mocked(test.matrix.remove).mockReturnValue(of(void 0));
      vi.mocked(test.lifecycle.forgetMentionHistory).mockReturnValue(
        throwError(() => new Error('store blocked')),
      );

      await expect(
        firstValueFrom(test.adapter.signOutAccount('@out:hs')),
      ).resolves.toMatchObject({
        kind: 'partial-cleanup',
        issues: [{ scope: 'indexed-db', recovery: 'restart-application' }],
      });
      expect(test.storage.remove).toHaveBeenCalledWith('@out:hs');
    });
  });

  it('forgets the push handoff before sign-out reads the session or contacts the homeserver', async () => {
    const { adapter, matrix, storage, lifecycle } = setup('@outgoing:hs');
    vi.mocked(matrix.clientFor).mockReturnValue({
      logout: vi.fn(() => Promise.resolve()),
    } as never);
    vi.mocked(storage.list).mockReturnValue(
      of([
        { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
        { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(of(null));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.setActive).mockReturnValue(of(void 0));

    await firstValueFrom(adapter.signOutAccount('@outgoing:hs'));

    expect(lifecycle.forgetPushHandoff).toHaveBeenCalledWith('@outgoing:hs');
    const forgotAt = vi.mocked(lifecycle.forgetPushHandoff).mock
      .invocationCallOrder[0];
    expect(forgotAt).toBeLessThan(
      vi.mocked(storage.load).mock.invocationCallOrder[0],
    );
    expect(forgotAt).toBeLessThan(
      vi.mocked(lifecycle.unregisterNotifications).mock.invocationCallOrder[0],
    );
  });

  it('retries a refused push handoff removal with the notification cleanup', async () => {
    const { adapter, matrix, storage, lifecycle } = setup('@outgoing:hs');
    vi.mocked(matrix.clientFor).mockReturnValue({
      logout: vi.fn(() => Promise.resolve()),
    } as never);
    vi.mocked(storage.list).mockReturnValue(
      of([
        { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
        { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(of(null));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.setActive).mockReturnValue(of(void 0));
    vi.mocked(lifecycle.forgetPushHandoff)
      .mockReturnValueOnce(throwError(() => new Error('keychain locked')))
      .mockReturnValue(of(void 0));

    const first = await firstValueFrom(adapter.signOutAccount('@outgoing:hs'));
    expect(first).toMatchObject({
      kind: 'partial-cleanup',
      issues: [{ scope: 'notifications', recovery: 'retry-sign-out' }],
    });

    await expect(
      firstValueFrom(
        adapter.retrySignOutCleanup(
          '@outgoing:hs',
          first.kind === 'partial-cleanup' ? first.issues : [],
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(lifecycle.forgetPushHandoff).toHaveBeenCalledTimes(2);
    expect(lifecycle.forgetPushHandoff).toHaveBeenLastCalledWith(
      '@outgoing:hs',
    );
  });

  it('still tears the pusher down on retry when the push handoff refuses again', async () => {
    const { adapter, matrix, storage, lifecycle } = setup('@outgoing:hs');
    vi.mocked(matrix.clientFor).mockReturnValue({
      logout: vi.fn(() => Promise.resolve()),
    } as never);
    vi.mocked(storage.list).mockReturnValue(
      of([
        { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
        { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(of(null));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.setActive).mockReturnValue(of(void 0));
    vi.mocked(lifecycle.forgetPushHandoff).mockReturnValue(
      throwError(() => new Error('keychain locked')),
    );
    vi.mocked(lifecycle.unregisterNotifications)
      .mockReturnValueOnce(throwError(() => new Error('homeserver down')))
      .mockReturnValue(of(void 0));
    const first = await firstValueFrom(adapter.signOutAccount('@outgoing:hs'));
    const issues = first.kind === 'partial-cleanup' ? first.issues : [];
    expect(issues).toEqual([
      { scope: 'notifications', recovery: 'retry-sign-out' },
    ]);

    const retried = await firstValueFrom(
      adapter.retrySignOutCleanup('@outgoing:hs', issues),
    );

    // The pusher teardown is its own step: a refused handoff removal never skips it, and
    // its success does not hide the handoff residue.
    expect(lifecycle.unregisterNotifications).toHaveBeenCalledTimes(2);
    expect(lifecycle.unregisterNotifications).toHaveBeenLastCalledWith(
      '@outgoing:hs',
    );
    expect(retried).toMatchObject({
      kind: 'partial-cleanup',
      issues: [{ scope: 'notifications', recovery: 'retry-sign-out' }],
    });
  });

  it('revokes an OIDC account once, through its live client', async () => {
    const { adapter, matrix, storage, lifecycle, active } = setup('@oidc:hs');
    const client = { logout: vi.fn(() => Promise.resolve()) };
    vi.mocked(matrix.clientFor).mockReturnValue(client as never);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(of(OIDC_STORED));
    vi.mocked(matrix.remove).mockImplementation(() => {
      active.set(null);
      return of(void 0);
    });
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@oidc:hs')),
    ).resolves.toMatchObject({ kind: 'ready' });
    // matrix-js-sdk 43's logout() revokes at the provider itself; a second, Trinity-owned
    // revocation would revoke every token twice.
    expect(client.logout).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledWith(true);
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
  });

  it('revokes through the live client even when the stored OIDC session cannot be read', async () => {
    const { adapter, matrix, storage, lifecycle, active } = setup('@oidc:hs');
    const client = { logout: vi.fn(() => Promise.resolve()) };
    vi.mocked(matrix.clientFor).mockReturnValue(client as never);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(
      throwError(() => new Error('secure read failed')),
    );
    vi.mocked(matrix.remove).mockImplementation(() => {
      active.set(null);
      return of(void 0);
    });
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@oidc:hs')),
    ).resolves.toEqual({
      kind: 'ready',
      accountId: '@oidc:hs',
      activeAccountId: null,
      remainingAccountIds: [],
    });
    expect(client.logout).toHaveBeenCalledOnce();
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
  });

  describe('a signed-out OAuth account', () => {
    it('marks a token-less OAuth record for the prefilled re-auth', async () => {
      const { adapter, matrix, storage } = setup(null);
      vi.mocked(storage.load).mockReturnValue(of(null));
      vi.mocked(storage.record).mockReturnValue(of(OIDC_RECORD));

      await expect(
        firstValueFrom(adapter.restoreAccount('@oidc:hs', 'active')),
      ).resolves.toEqual({ kind: 'reauthentication-required' });
      expect(matrix.requireReauthentication).toHaveBeenCalledExactlyOnceWith(
        '@oidc:hs',
        true,
      );
    });

    it('still requires a sign-in when the record cannot be read', async () => {
      const { adapter, matrix, storage } = setup(null);
      vi.mocked(storage.load).mockReturnValue(of(null));
      vi.mocked(storage.record).mockReturnValue(
        throwError(() => new Error('registry unreadable')),
      );

      await expect(
        firstValueFrom(adapter.restoreAccount('@oidc:hs', 'active')),
      ).resolves.toEqual({ kind: 'reauthentication-required' });
      expect(matrix.requireReauthentication).toHaveBeenCalledExactlyOnceWith(
        '@oidc:hs',
        false,
      );
    });

    it('removing a signed-out OAuth account reports no provider residue', async () => {
      const { adapter, matrix, storage, softLoggedOut, reauthTargets } =
        setup(null);
      softLoggedOut.set(['@oidc:hs']);
      reauthTargets.set(['@oidc:hs']);
      vi.mocked(matrix.clientFor).mockReturnValue(null as never);
      vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
      vi.mocked(storage.load).mockReturnValue(of(null));
      vi.mocked(matrix.remove).mockReturnValue(of(void 0));
      vi.mocked(storage.clear).mockReturnValue(of(void 0));

      await expect(
        firstValueFrom(adapter.signOutAccount('@oidc:hs')),
      ).resolves.toEqual({
        kind: 'ready',
        accountId: '@oidc:hs',
        activeAccountId: null,
        remainingAccountIds: [],
      });
    });
  });

  it('keeps a lost-store-key OAuth account owing its provider a revocation', async () => {
    // Signed out in the UI, but not a re-auth target: its tokens are still live.
    const { adapter, matrix, storage, softLoggedOut } = setup(null);
    softLoggedOut.set(['@oidc:hs']);
    const client = {
      logout: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider unreachable'))
        .mockResolvedValue(undefined),
    };
    vi.mocked(matrix.clientFor).mockReturnValue(null as never);
    vi.mocked(matrix.detachedClient).mockReturnValue(client as never);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(of(OIDC_STORED));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    const first = await firstValueFrom(adapter.signOutAccount('@oidc:hs'));

    expect(first).toMatchObject({
      kind: 'partial-cleanup',
      issues: [{ scope: 'provider-session', recovery: 'retry-sign-out' }],
    });
    expect(storage.clear).toHaveBeenCalledExactlyOnceWith({
      keepNativeTokens: true,
    });
    await expect(
      firstValueFrom(
        adapter.retrySignOutCleanup(
          '@oidc:hs',
          first.kind === 'partial-cleanup' ? first.issues : [],
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(client.logout).toHaveBeenCalledTimes(2);
  });

  it('reports a failed OIDC revocation as provider residue and retries it through the client', async () => {
    const { adapter, matrix, storage, lifecycle, active } = setup('@oidc:hs');
    const client = {
      logout: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider unreachable'))
        .mockResolvedValue(undefined),
    };
    vi.mocked(matrix.clientFor).mockReturnValue(client as never);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(of(OIDC_STORED));
    vi.mocked(matrix.remove).mockImplementation(() => {
      active.set(null);
      return of(void 0);
    });
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    const first = await firstValueFrom(adapter.signOutAccount('@oidc:hs'));
    expect(first).toEqual({
      kind: 'partial-cleanup',
      accountId: '@oidc:hs',
      activeAccountId: null,
      remainingAccountIds: [],
      issues: [{ scope: 'provider-session', recovery: 'retry-sign-out' }],
    });
    // Local removal did not wait on the provider.
    expect(matrix.remove).toHaveBeenCalledWith('@oidc:hs');
    expect(storage.clear).toHaveBeenCalledOnce();

    await expect(
      firstValueFrom(
        adapter.retrySignOutCleanup(
          '@oidc:hs',
          first.kind === 'partial-cleanup' ? first.issues : [],
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(client.logout).toHaveBeenCalledTimes(2);
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
  });

  describe('the native token vault record', () => {
    function offline(remaining: readonly string[]) {
      const test = setup('@oidc:hs');
      const client = {
        logout: vi
          .fn()
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValue(undefined),
      };
      vi.mocked(test.matrix.clientFor).mockReturnValue(client as never);
      vi.mocked(test.storage.list).mockReturnValue(
        of([
          OIDC_RECORD,
          ...remaining.map((userId) => ({
            userId,
            baseUrl: 'https://hs',
            deviceId: 'B',
          })),
        ]) as never,
      );
      vi.mocked(test.storage.load).mockReturnValue(of(OIDC_STORED));
      vi.mocked(test.matrix.remove).mockReturnValue(of(void 0));
      vi.mocked(test.storage.clear).mockReturnValue(of(void 0));
      vi.mocked(test.storage.remove).mockReturnValue(of(void 0));
      vi.mocked(test.storage.setActive).mockReturnValue(of(void 0));
      vi.mocked(test.storage.removeNativeTokens).mockReturnValue(of(void 0));
      return { ...test, client };
    }

    it.each([
      ['the last account', [] as string[]],
      ['one of several', ['@other:hs']],
    ])(
      'keeps it through an offline sign-out of %s until the retry revokes',
      async (_, remaining) => {
        const test = offline(remaining);
        const removal =
          remaining.length === 0 ? test.storage.clear : test.storage.remove;

        const first = await firstValueFrom(
          test.adapter.signOutAccount('@oidc:hs'),
        );

        expect(first).toMatchObject({
          kind: 'partial-cleanup',
          issues: [{ scope: 'provider-session', recovery: 'retry-sign-out' }],
        });
        expect(removal).toHaveBeenCalledWith(
          ...(remaining.length === 0
            ? [{ keepNativeTokens: true }]
            : ['@oidc:hs', { keepNativeTokens: true }]),
        );
        expect(test.storage.removeNativeTokens).not.toHaveBeenCalled();

        await firstValueFrom(
          test.adapter.retrySignOutCleanup(
            '@oidc:hs',
            first.kind === 'partial-cleanup' ? first.issues : [],
          ),
        );

        expect(test.storage.removeNativeTokens).toHaveBeenCalledExactlyOnceWith(
          '@oidc:hs',
        );
      },
    );

    it('keeps it when the revocation has not settled by the time of removal', async () => {
      vi.useFakeTimers();
      try {
        const test = offline([]);
        test.client.logout.mockReset();
        let settleLogout: (error: Error) => void = () => undefined;
        test.client.logout.mockReturnValue(
          new Promise((_, reject) => {
            settleLogout = reject;
          }),
        );

        test.adapter.signOutAccount('@oidc:hs').subscribe();
        await vi.advanceTimersByTimeAsync(
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
        );

        expect(test.storage.clear).toHaveBeenCalledExactlyOnceWith({
          keepNativeTokens: true,
        });
        settleLogout(new Error('late transient'));
        await vi.runAllTimersAsync();
        expect(test.storage.removeNativeTokens).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps it while the retry still cannot revoke', async () => {
      const test = offline([]);
      test.client.logout.mockReset();
      test.client.logout.mockRejectedValue(new Error('offline'));
      const first = await firstValueFrom(
        test.adapter.signOutAccount('@oidc:hs'),
      );

      await firstValueFrom(
        test.adapter.retrySignOutCleanup(
          '@oidc:hs',
          first.kind === 'partial-cleanup' ? first.issues : [],
        ),
      );

      expect(test.storage.removeNativeTokens).not.toHaveBeenCalled();
    });

    it('removes it with the account when the revocation succeeded', async () => {
      const test = offline([]);
      test.client.logout.mockReset();
      test.client.logout.mockResolvedValue(undefined);

      await firstValueFrom(test.adapter.signOutAccount('@oidc:hs'));

      expect(test.storage.clear).toHaveBeenCalledExactlyOnceWith();
      expect(test.storage.removeNativeTokens).not.toHaveBeenCalled();
    });
  });

  it('keeps a failed live revocation as provider residue when the session read settles late', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, matrix, storage, active } = setup('@oidc:hs');
      const sessionRead = new Subject<MatrixSession | null>();
      vi.mocked(matrix.clientFor).mockReturnValue({
        logout: vi.fn(() => Promise.reject(new Error('provider unreachable'))),
      } as never);
      vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
      vi.mocked(storage.load).mockReturnValue(sessionRead);
      vi.mocked(matrix.remove).mockImplementation(() => {
        active.set(null);
        return of(void 0);
      });
      vi.mocked(storage.clear).mockReturnValue(of(void 0));
      const outcomes: AccountSignOutOutcome[] = [];

      adapter
        .signOutAccount('@oidc:hs')
        .subscribe((outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.sessionRead,
      );
      sessionRead.next(OIDC_STORED);
      sessionRead.complete();
      await vi.runAllTimersAsync();

      expect(outcomes.at(-1)).toEqual({
        kind: 'partial-cleanup',
        accountId: '@oidc:hs',
        activeAccountId: null,
        remainingAccountIds: [],
        issues: [{ scope: 'provider-session', recovery: 'retry-sign-out' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes an OIDC account without a live client through a detached client', async () => {
    const { adapter, matrix, storage, lifecycle } = setup(null);
    const detached = { logout: vi.fn(() => Promise.resolve()) };
    vi.mocked(matrix.clientFor).mockReturnValue(null);
    vi.mocked(matrix.detachedClient).mockReturnValue(detached as never);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(of(OIDC_STORED));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@oidc:hs')),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(matrix.detachedClient).toHaveBeenCalledWith(OIDC_STORED);
    expect(detached.logout).toHaveBeenCalledOnce();
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
  });

  it('retries a failed detached revocation through a new detached client', async () => {
    const { adapter, matrix, storage, lifecycle } = setup(null);
    const detached = {
      logout: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider unreachable'))
        .mockResolvedValue(undefined),
    };
    vi.mocked(matrix.clientFor).mockReturnValue(null);
    vi.mocked(matrix.detachedClient).mockReturnValue(detached as never);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(of(OIDC_STORED));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    const first = await firstValueFrom(adapter.signOutAccount('@oidc:hs'));
    expect(first).toMatchObject({
      kind: 'partial-cleanup',
      issues: [{ scope: 'provider-session', recovery: 'retry-sign-out' }],
    });

    await expect(
      firstValueFrom(
        adapter.retrySignOutCleanup(
          '@oidc:hs',
          first.kind === 'partial-cleanup' ? first.issues : [],
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(matrix.detachedClient).toHaveBeenCalledTimes(2);
    expect(matrix.detachedClient).toHaveBeenLastCalledWith(OIDC_STORED);
    expect(detached.logout).toHaveBeenCalledTimes(2);
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
  });

  it('does not resolve provider residue on retry when there is nothing to revoke with', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, matrix, storage } = setup(null);
      const sessionRead = new Subject<MatrixSession | null>();
      vi.mocked(matrix.clientFor).mockReturnValue(null);
      vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
      vi.mocked(storage.load).mockReturnValue(sessionRead);
      vi.mocked(matrix.remove).mockReturnValue(of(void 0));
      vi.mocked(storage.clear).mockReturnValue(of(void 0));
      const outcomes: AccountSignOutOutcome[] = [];

      adapter
        .signOutAccount('@oidc:hs')
        .subscribe((outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.sessionRead,
      );
      const interim = outcomes.at(-1)!;
      expect(interim).toMatchObject({
        kind: 'uncertain-cleanup',
        issues: [{ scope: 'provider-session', recovery: 'retry-sign-out' }],
      });
      sessionRead.next(null);
      sessionRead.complete();
      await vi.runAllTimersAsync();

      const retried: AccountSignOutOutcome[] = [];
      adapter
        .retrySignOutCleanup(
          '@oidc:hs',
          interim.kind === 'uncertain-cleanup' ? interim.issues : [],
        )
        .subscribe((outcome) => retried.push(outcome));
      await vi.runAllTimersAsync();

      expect(retried.at(-1)).toMatchObject({
        kind: 'partial-cleanup',
        issues: [{ scope: 'provider-session' }],
      });
      expect(matrix.detachedClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not claim provider cleanup without a live client when the OIDC session cannot be read', async () => {
    const { adapter, matrix, storage } = setup(null);
    vi.mocked(matrix.clientFor).mockReturnValue(null);
    vi.mocked(storage.list).mockReturnValue(of([OIDC_RECORD]));
    vi.mocked(storage.load).mockReturnValue(
      throwError(() => new Error('secure read failed')),
    );
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@oidc:hs')),
    ).resolves.toEqual({
      kind: 'partial-cleanup',
      accountId: '@oidc:hs',
      activeAccountId: null,
      remainingAccountIds: [],
      issues: [{ scope: 'provider-session', recovery: 'restart-application' }],
    });
    expect(matrix.detachedClient).not.toHaveBeenCalled();
  });

  it('reports a failed homeserver logout of a password account as matrix-session residue', async () => {
    const { adapter, matrix, storage, active } = setup('@pw:hs');
    vi.mocked(matrix.clientFor).mockReturnValue({
      logout: vi.fn(() => Promise.reject(new Error('homeserver down'))),
    } as never);
    vi.mocked(storage.list).mockReturnValue(
      of([{ userId: '@pw:hs', baseUrl: 'https://hs', deviceId: 'A' }]),
    );
    vi.mocked(storage.load).mockReturnValue(
      of({ userId: '@pw:hs', baseUrl: 'https://hs' } as never),
    );
    vi.mocked(matrix.remove).mockImplementation(() => {
      active.set(null);
      return of(void 0);
    });
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@pw:hs')),
    ).resolves.toMatchObject({
      kind: 'partial-cleanup',
      issues: [{ scope: 'matrix-session', recovery: 'retry-sign-out' }],
    });
  });

  it('wipes the explicit last Account even when it has no live client', async () => {
    const { adapter, matrix, storage } = setup(null);
    vi.mocked(matrix.clientFor).mockReturnValue(null);
    vi.mocked(storage.list).mockReturnValue(
      of([{ userId: '@stale:hs', baseUrl: 'https://hs', deviceId: 'A' }]),
    );
    vi.mocked(storage.load).mockReturnValue(of(null));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.clear).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@stale:hs')),
    ).resolves.toEqual({
      kind: 'ready',
      accountId: '@stale:hs',
      activeAccountId: null,
      remainingAccountIds: [],
    });
    expect(matrix.remove).toHaveBeenCalledWith('@stale:hs');
    expect(matrix.reset).not.toHaveBeenCalled();
  });

  it('keeps a surviving Account active when outgoing crypto cleanup fails', async () => {
    const { adapter, matrix, storage } = setup('@outgoing:hs');
    vi.mocked(matrix.clientFor).mockImplementation(
      (accountId) =>
        ({ logout: vi.fn(() => Promise.resolve()), accountId }) as never,
    );
    vi.mocked(storage.list).mockReturnValue(
      of([
        { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
        { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(of(null));
    vi.mocked(matrix.remove).mockReturnValue(
      throwError(() => new Error('crypto store remained open')),
    );
    vi.mocked(storage.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.setActive).mockReturnValue(of(void 0));

    await expect(
      firstValueFrom(adapter.signOutAccount('@outgoing:hs')),
    ).resolves.toEqual({
      kind: 'partial-cleanup',
      accountId: '@outgoing:hs',
      activeAccountId: '@survivor:hs',
      remainingAccountIds: ['@survivor:hs'],
      issues: [{ scope: 'crypto-and-cache', recovery: 'restart-application' }],
    });
    expect(matrix.setActive).toHaveBeenCalledWith('@survivor:hs');
    expect(storage.setActive).toHaveBeenCalledWith('@survivor:hs');
  });

  it('continues Account registry cleanup while Matrix removal remains owned', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, matrix, storage } = setup('@outgoing:hs');
      const removal = new Subject<void>();
      vi.mocked(matrix.clientFor).mockReturnValue({
        logout: vi.fn(() => Promise.resolve()),
      } as never);
      vi.mocked(storage.list).mockReturnValue(
        of([
          { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
          { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
        ]),
      );
      vi.mocked(storage.load).mockReturnValue(of(null));
      vi.mocked(matrix.remove).mockReturnValue(removal);
      vi.mocked(storage.remove).mockReturnValue(of(void 0));
      vi.mocked(storage.setActive).mockReturnValue(of(void 0));
      const outcomes = [] as AccountSignOutOutcome[];

      adapter
        .signOutAccount('@outgoing:hs')
        .subscribe((outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
      );

      expect(outcomes.at(-1)).toEqual({
        kind: 'uncertain-cleanup',
        accountId: '@outgoing:hs',
        issues: [],
        pending: [
          {
            scope: 'crypto-and-cache',
            recovery: 'restart-application',
          },
        ],
      });
      expect(storage.remove).toHaveBeenCalledWith('@outgoing:hs');
      expect(removal.observed).toBe(true);

      removal.next();
      removal.complete();
      await vi.runAllTimersAsync();
      expect(outcomes.at(-1)).toEqual({
        kind: 'ready',
        accountId: '@outgoing:hs',
        activeAccountId: '@survivor:hs',
        remainingAccountIds: ['@survivor:hs'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries only settled safe Account-removal residue', async () => {
    const { adapter, matrix, storage, lifecycle } = setup('@outgoing:hs');
    const client = { logout: vi.fn(() => Promise.resolve()) };
    vi.mocked(matrix.clientFor).mockReturnValue(client as never);
    vi.mocked(storage.list).mockReturnValue(
      of([
        { userId: '@outgoing:hs', baseUrl: 'https://hs', deviceId: 'A' },
        { userId: '@survivor:hs', baseUrl: 'https://hs', deviceId: 'B' },
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(of(null));
    vi.mocked(matrix.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.remove).mockReturnValue(of(void 0));
    vi.mocked(storage.setActive).mockReturnValue(of(void 0));
    vi.mocked(lifecycle.unregisterNotifications)
      .mockReturnValueOnce(throwError(() => new Error('push unavailable')))
      .mockReturnValue(of(void 0));

    const first = await firstValueFrom(adapter.signOutAccount('@outgoing:hs'));
    expect(first).toMatchObject({
      kind: 'partial-cleanup',
      issues: [{ scope: 'notifications', recovery: 'retry-sign-out' }],
    });

    await expect(
      firstValueFrom(
        adapter.retrySignOutCleanup(
          '@outgoing:hs',
          first.kind === 'partial-cleanup' ? first.issues : [],
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(lifecycle.unregisterNotifications).toHaveBeenCalledTimes(2);
    expect(client.logout).toHaveBeenCalledOnce();
    expect(matrix.remove).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledOnce();
  });
});
