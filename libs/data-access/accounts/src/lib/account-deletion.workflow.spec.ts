import { TestBed } from '@angular/core/testing';
import { ConnectionError, HTTPError, MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  MatrixClientService,
  type AccountServerStatus,
} from '@trinity/data-access/matrix-client';
import {
  AccountDeletionWorkflow,
  type AccountDeletionStages,
} from './account-deletion.workflow';
import { AccountRuntimeService } from './account-runtime.service';
import type { AccountSignOutOutcome } from './account-runtime.models';

const ALICE = '@alice:example.org';

const CLEANED: AccountSignOutOutcome = {
  kind: 'ready',
  accountId: ALICE,
  activeAccountId: '@bob:example.org',
  remainingAccountIds: ['@bob:example.org'],
};

function uia(stages: string[], session = 's1'): MatrixError {
  return new MatrixError({ flows: [{ stages }], session }, 401);
}

function setup(
  options: {
    deactivate?: ReturnType<typeof vi.fn>;
    status?: AccountServerStatus;
    blocker?: string | null;
    client?: boolean;
  } = {},
) {
  const deactivateAccount = options.deactivate ?? vi.fn().mockResolvedValue({});
  const client = {
    deactivateAccount,
    getFallbackAuthUrl: vi.fn(
      (stage: string, session: string) =>
        `https://example.org/_matrix/client/v3/auth/${stage}/fallback/web?session=${session}`,
    ),
  };
  let tokenDied = false;
  let generation = 0;
  const release = vi.fn();
  const onTokenDied: (() => void)[] = [];
  const onSignedInAgain: (() => void)[] = [];
  const order: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      AccountDeletionWorkflow,
      MockProvider(MatrixClientService, {
        clientFor: vi.fn(() =>
          options.client === false ? null : (client as never),
        ),
        holdServerLogout: vi.fn(
          (
            _id: string,
            hooks?: { onTokenDied?: () => void; onSignedInAgain?: () => void },
          ) => {
            if (hooks?.onTokenDied) onTokenDied.push(hooks.onTokenDied);
            if (hooks?.onSignedInAgain) {
              onSignedInAgain.push(hooks.onSignedInAgain);
            }
            const born = generation;
            let released = false;
            return {
              tokenDied: () => tokenDied,
              isHeld: () => !released && born === generation,
              release: (outcome: { deleted: boolean }) => {
                released = true;
                order.push(`release:${outcome.deleted}`);
                release(outcome);
              },
            };
          },
        ),
        accountStatus: vi.fn(() => of(options.status ?? 'active')),
      }),
      MockProvider(AccountRuntimeService, {
        deletionBlocker: vi.fn(() => (options.blocker ?? null) as never),
        removeDeletedAccount: vi.fn(() => {
          order.push('cleanup');
          return of(CLEANED);
        }),
      }),
    ],
  });
  const stages: AccountDeletionStages = {
    password: vi.fn().mockResolvedValue('pw'),
    confirmInBrowser: vi.fn().mockResolvedValue(true),
  };
  return {
    workflow: TestBed.inject(AccountDeletionWorkflow),
    matrix: TestBed.inject(MatrixClientService),
    accounts: TestBed.inject(AccountRuntimeService),
    client,
    stages,
    release,
    order,
    killToken: () => {
      tokenDied = true;
      onTokenDied.forEach((hook) => hook());
    },
    signInAgain: () => onSignedInAgain.forEach((hook) => hook()),
    /** The account left the device another way, which drops every hold on it. */
    wipeHolds: () => {
      generation++;
      onTokenDied.length = 0;
      onSignedInAgain.length = 0;
    },
  };
}

function request(stages: AccountDeletionStages, erase = true) {
  return { accountId: ALICE, erase, stages };
}

describe('AccountDeletionWorkflow', () => {
  it('deletes on a server that needs no confirmation, then cleans up before releasing the hold', async () => {
    const test = setup();

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({ kind: 'deleted', accountId: ALICE, cleanup: CLEANED });
    expect(test.client.deactivateAccount).toHaveBeenCalledWith(undefined, true);
    expect(test.accounts.removeDeletedAccount).toHaveBeenCalledWith(ALICE);
    expect(test.order).toEqual(['cleanup', 'release:true']);
  });

  it('passes erase false through', async () => {
    const test = setup();

    await firstValueFrom(test.workflow.delete(request(test.stages, false)));

    expect(test.client.deactivateAccount).toHaveBeenCalledWith(
      undefined,
      false,
    );
  });

  it('answers a password stage for the explicit account', async () => {
    const deactivate = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.password']))
      .mockResolvedValueOnce({});
    const test = setup({ deactivate });

    await firstValueFrom(test.workflow.delete(request(test.stages)));

    expect(deactivate.mock.calls[1]).toEqual([
      {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: ALICE },
        password: 'pw',
        session: 's1',
      },
      true,
    ]);
  });

  it('opens the fallback page for a stage it cannot render', async () => {
    const deactivate = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.sso']))
      .mockResolvedValueOnce({});
    const test = setup({ deactivate });

    await firstValueFrom(test.workflow.delete(request(test.stages)));

    expect(test.client.getFallbackAuthUrl).toHaveBeenCalledWith(
      'm.login.sso',
      's1',
    );
    expect(test.stages.confirmInBrowser).toHaveBeenCalledWith({
      url: 'https://example.org/_matrix/client/v3/auth/m.login.sso/fallback/web?session=s1',
      pending: false,
    });
    expect(deactivate.mock.calls[1]).toEqual([{ session: 's1' }, true]);
  });

  it('uses the account it was given after the active account changes', async () => {
    const test = setup();

    await firstValueFrom(test.workflow.delete(request(test.stages)));

    expect(test.matrix.clientFor).toHaveBeenCalledWith(ALICE);
    expect(test.matrix.holdServerLogout).toHaveBeenCalledWith(
      ALICE,
      expect.anything(),
    );
  });

  it.each([
    ['cancelled', null],
    ['attempts-exceeded', 'nope'],
  ] as const)(
    'keeps the account when authentication ends %s',
    async (reason, answer) => {
      const deactivate = vi.fn().mockRejectedValue(uia(['m.login.password']));
      const test = setup({ deactivate });
      vi.mocked(test.stages.password).mockResolvedValue(answer);

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({ kind: 'kept', accountId: ALICE, reason });
      expect(test.release).toHaveBeenCalledWith({ deleted: false });
      expect(test.accounts.removeDeletedAccount).not.toHaveBeenCalled();
    },
  );

  it('reports a flow with no stage it can complete', async () => {
    const test = setup({
      deactivate: vi
        .fn()
        .mockRejectedValue(new MatrixError({ flows: [] }, 401)),
    });
    const stages = { ...test.stages };

    await expect(
      firstValueFrom(
        test.workflow.delete({
          accountId: ALICE,
          erase: true,
          stages: { ...stages, password: vi.fn().mockResolvedValue('pw') },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'kept' });
  });

  it.each([
    ['M_UNRECOGNIZED', 400],
    ['M_UNRECOGNIZED', 404],
    [undefined, 404],
    [undefined, 405],
  ])('reports %s %s as not supported', async (errcode, status) => {
    const test = setup({
      deactivate: vi
        .fn()
        .mockRejectedValue(new MatrixError(errcode ? { errcode } : {}, status)),
    });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({
      kind: 'kept',
      accountId: ALICE,
      reason: 'unsupported',
    });
  });

  it('reports a refusal by server policy', async () => {
    const test = setup({
      deactivate: vi
        .fn()
        .mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN' }, 403)),
    });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({ kind: 'kept', accountId: ALICE, reason: 'forbidden' });
  });

  it('reports rate limiting with the wait the server asked for', async () => {
    const test = setup({
      deactivate: vi
        .fn()
        .mockRejectedValue(
          new MatrixError(
            { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 4000 },
            429,
          ),
        ),
    });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({
      kind: 'kept',
      accountId: ALICE,
      reason: 'rate-limited',
      retryAfterMs: 4000,
    });
  });

  it('reports an unreachable server before anything was authenticated', async () => {
    const test = setup({
      deactivate: vi.fn().mockRejectedValue(new ConnectionError('offline')),
    });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({
      kind: 'kept',
      accountId: ALICE,
      reason: 'unreachable',
    });
  });

  describe('a lost answer to the authenticated request', () => {
    function lostAnswer(status: AccountServerStatus) {
      const deactivate = vi
        .fn()
        .mockRejectedValueOnce(uia(['m.login.password']))
        .mockRejectedValueOnce(new ConnectionError('reset'));
      return setup({ deactivate, status });
    }

    it('is resolved as deleted when the server no longer knows the token', async () => {
      const test = lostAnswer('gone');

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({
        kind: 'deleted',
        accountId: ALICE,
        cleanup: CLEANED,
      });
      expect(test.release).toHaveBeenCalledWith({ deleted: true });
    });

    it('is resolved as not deleted when the token still works', async () => {
      const test = lostAnswer('active');

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({
        kind: 'kept',
        accountId: ALICE,
        reason: 'still-active',
      });
      expect(test.release).toHaveBeenCalledWith({ deleted: false });
    });

    it('stays unconfirmed when the server still cannot be reached', async () => {
      const test = lostAnswer('unreachable');

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({ kind: 'unconfirmed', accountId: ALICE });
      expect(test.accounts.removeDeletedAccount).not.toHaveBeenCalled();
    });

    it('counts a token that died while held as deleted', async () => {
      const test = lostAnswer('unreachable');
      vi.mocked(test.client.deactivateAccount)
        .mockReset()
        .mockRejectedValueOnce(uia(['m.login.password']))
        .mockImplementationOnce(() => {
          test.killToken();
          return Promise.reject(new ConnectionError('reset'));
        });

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toMatchObject({ kind: 'deleted' });
    });
  });

  describe('a session that ends during the password prompt', () => {
    function signedOutDuringPrompt(seenBeforeSend: boolean) {
      const test = setup({ status: 'gone' });
      vi.mocked(test.stages.password).mockImplementation(async () => {
        if (seenBeforeSend) test.killToken();
        return 'pw';
      });
      vi.mocked(test.client.deactivateAccount).mockImplementation(
        async (auth: unknown) => {
          if (!auth) throw uia(['m.login.password']);
          test.killToken();
          throw new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
        },
      );
      return test;
    }

    it.each([
      ['before the password request was sent', true],
      ['only when the password request was refused', false],
    ])('is not counted as a deletion when seen %s', async (_label, seen) => {
      const test = signedOutDuringPrompt(seen);

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({
        kind: 'kept',
        accountId: ALICE,
        reason: 'signed-out',
      });
      expect(test.accounts.removeDeletedAccount).not.toHaveBeenCalled();
      expect(test.release).toHaveBeenCalledWith({ deleted: false });
    });

    it('is not counted as a deletion when the token died before a request that then got no answer', async () => {
      const test = setup({ status: 'gone' });
      vi.mocked(test.stages.password).mockImplementation(async () => {
        test.killToken();
        return 'pw';
      });
      vi.mocked(test.client.deactivateAccount).mockImplementation(
        async (auth: unknown) => {
          if (!auth) throw uia(['m.login.password']);
          throw new ConnectionError('reset');
        },
      );

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({
        kind: 'kept',
        accountId: ALICE,
        reason: 'signed-out',
      });
      expect(test.accounts.removeDeletedAccount).not.toHaveBeenCalled();
      expect(test.release).toHaveBeenCalledWith({ deleted: false });
    });
  });

  it('sends nothing while another account operation is running', async () => {
    const test = setup({ blocker: 'signing-out-account' });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({ kind: 'kept', accountId: ALICE, reason: 'busy' });
    expect(test.client.deactivateAccount).not.toHaveBeenCalled();
    expect(test.matrix.holdServerLogout).not.toHaveBeenCalled();
  });

  it('sends nothing for an account without a live client', async () => {
    const test = setup({ client: false });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({
      kind: 'kept',
      accountId: ALICE,
      reason: 'account-unavailable',
    });
  });

  describe('checkDeletion', () => {
    it.each([
      ['gone', { kind: 'deleted', accountId: ALICE, cleanup: CLEANED }],
      ['active', { kind: 'kept', accountId: ALICE, reason: 'still-active' }],
      ['unreachable', { kind: 'unconfirmed', accountId: ALICE }],
    ] as const)('maps a %s account', async (status, expected) => {
      const test = setup({ status });

      await expect(
        firstValueFrom(test.workflow.checkDeletion(ALICE)),
      ).resolves.toEqual(expected);
      expect(test.matrix.holdServerLogout).toHaveBeenCalledWith(
        ALICE,
        expect.anything(),
      );
    });
  });

  describe('an ambiguous failure of the authenticated request', () => {
    function failsAfterPassword(error: unknown, status: AccountServerStatus) {
      const deactivate = vi
        .fn()
        .mockRejectedValueOnce(uia(['m.login.password']))
        .mockRejectedValueOnce(error);
      return setup({ deactivate, status });
    }

    it('counts a 502 after the token died as deleted', async () => {
      const test = setup({
        status: 'unreachable',
        deactivate: vi.fn(async (auth: unknown) => {
          if (!auth) throw uia(['m.login.password']);
          test.killToken();
          throw new MatrixError({}, 502);
        }),
      });

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toMatchObject({ kind: 'deleted' });
      expect(test.release).toHaveBeenCalledWith({ deleted: true });
    });

    it.each([
      ['a 500', new MatrixError({ errcode: 'M_UNKNOWN' }, 500)],
      ['a non-Matrix HTTP error', new HTTPError('bad gateway', 502)],
    ])('asks the server after %s', async (_label, error) => {
      const gone = failsAfterPassword(error, 'gone');
      await expect(
        firstValueFrom(gone.workflow.delete(request(gone.stages))),
      ).resolves.toMatchObject({ kind: 'deleted' });
      TestBed.resetTestingModule();

      const active = failsAfterPassword(error, 'active');
      await expect(
        firstValueFrom(active.workflow.delete(request(active.stages))),
      ).resolves.toEqual({
        kind: 'kept',
        accountId: ALICE,
        reason: 'still-active',
      });
    });

    it('counts a token that died before a refused probe as deleted', async () => {
      const test = setup({
        deactivate: vi.fn(async () => {
          test.killToken();
          throw new MatrixError({ errcode: 'M_UNKNOWN' }, 500);
        }),
      });

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toMatchObject({ kind: 'deleted' });
    });
  });

  describe('an unconfirmed deletion', () => {
    function unconfirmed() {
      const deactivate = vi
        .fn()
        .mockRejectedValueOnce(uia(['m.login.password']))
        .mockRejectedValueOnce(new ConnectionError('reset'));
      return setup({ deactivate, status: 'unreachable' });
    }

    it('keeps holding the wipe', async () => {
      const test = unconfirmed();

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({ kind: 'unconfirmed', accountId: ALICE });
      expect(test.release).not.toHaveBeenCalled();
    });

    it('finishes the deletion when the token dies later, and says so', async () => {
      const test = unconfirmed();
      const late: unknown[] = [];
      test.workflow.lateDeletions.subscribe((result) => late.push(result));
      await firstValueFrom(test.workflow.delete(request(test.stages)));

      test.killToken();

      expect(test.accounts.removeDeletedAccount).toHaveBeenCalledWith(ALICE);
      expect(test.release).toHaveBeenCalledWith({ deleted: true });
      expect(late).toEqual([
        { kind: 'deleted', accountId: ALICE, cleanup: CLEANED },
      ]);
    });

    it('answers Check again from what it already finished', async () => {
      const test = unconfirmed();
      await firstValueFrom(test.workflow.delete(request(test.stages)));
      test.killToken();
      vi.mocked(test.matrix.accountStatus).mockClear();

      await expect(
        firstValueFrom(test.workflow.checkDeletion(ALICE)),
      ).resolves.toEqual({
        kind: 'deleted',
        accountId: ALICE,
        cleanup: CLEANED,
      });
      expect(test.matrix.accountStatus).not.toHaveBeenCalled();
    });

    it('is forgotten once the account leaves the device another way', async () => {
      const test = unconfirmed();
      const late: unknown[] = [];
      test.workflow.lateDeletions.subscribe((result) => late.push(result));
      await firstValueFrom(test.workflow.delete(request(test.stages)));
      test.wipeHolds();
      vi.mocked(test.client.deactivateAccount)
        .mockRejectedValueOnce(uia(['m.login.password']))
        .mockRejectedValueOnce(new ConnectionError('reset'));
      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toEqual({ kind: 'unconfirmed', accountId: ALICE });
      expect(test.release).not.toHaveBeenCalled();

      test.killToken();

      expect(test.accounts.removeDeletedAccount).toHaveBeenCalledWith(ALICE);
      expect(late).toEqual([
        { kind: 'deleted', accountId: ALICE, cleanup: CLEANED },
      ]);
    });

    it('leaves a later deletion to finish itself once the old one is forgotten', async () => {
      const test = unconfirmed();
      const late: unknown[] = [];
      test.workflow.lateDeletions.subscribe((result) => late.push(result));
      await firstValueFrom(test.workflow.delete(request(test.stages)));
      test.wipeHolds();
      vi.mocked(test.client.deactivateAccount)
        .mockRejectedValueOnce(uia(['m.login.password']))
        .mockImplementationOnce(async () => {
          test.killToken();
          return {};
        });

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toMatchObject({ kind: 'deleted' });

      expect(test.accounts.removeDeletedAccount).toHaveBeenCalledOnce();
      expect(late).toEqual([]);
    });

    it('lets go of the wipe once the account signs in again', async () => {
      const test = unconfirmed();
      const late: unknown[] = [];
      test.workflow.lateDeletions.subscribe((result) => late.push(result));
      await firstValueFrom(test.workflow.delete(request(test.stages)));

      test.signInAgain();
      test.killToken();

      expect(test.release).toHaveBeenCalledExactlyOnceWith({ deleted: false });
      expect(test.accounts.removeDeletedAccount).not.toHaveBeenCalled();
      expect(late).toEqual([]);
    });

    it('lets go of the wipe once the server says the account still exists', async () => {
      const test = unconfirmed();
      await firstValueFrom(test.workflow.delete(request(test.stages)));
      vi.mocked(test.matrix.accountStatus).mockReturnValue(of('active'));

      await firstValueFrom(test.workflow.checkDeletion(ALICE));

      expect(test.release).toHaveBeenCalledTimes(2);
      expect(test.release).toHaveBeenNthCalledWith(1, { deleted: false });
      expect(test.release).toHaveBeenNthCalledWith(2, { deleted: false });
    });
  });
});
