import { TestBed } from '@angular/core/testing';
import {
  type EngineFailure,
  type EngineResult,
  type MatrixRequestFailureMetadata,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import {
  Observable,
  Subject,
  type Subscriber,
  defer,
  firstValueFrom,
  of,
} from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_ENGINE,
  type AccountServerStatus,
  type ServerLogoutHoldUpdate,
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

type Deactivation = Promise<EngineResult<null>>;

const DEACTIVATED = engineOk(null);

/** The challenge the engine answers a request with when it needs these stages first. */
function uia(stages: string[] | null, session = 's1'): EngineResult<never> {
  return engineFail({
    kind: 'http',
    code: 'uia-required',
    diagnostic: { kind: 'http', httpStatus: 401 },
    params: {
      challenge: {
        flows: stages ? [{ stages }] : [],
        completed: [],
        session,
      },
    },
  });
}

/** A failed request as the engine reports it. */
function failed(
  kind: EngineFailure['kind'],
  extra: Omit<MatrixRequestFailureMetadata, 'kind'> = {},
  code: 'request-failed' | 'unsupported' | 'forbidden' = 'request-failed',
): EngineResult<never> {
  return engineFail({ kind, code, diagnostic: { kind, ...extra } });
}

const NETWORK = failed('network');
const UNKNOWN_TOKEN = failed('authentication', {
  httpStatus: 401,
  errcode: 'M_UNKNOWN_TOKEN',
});

function setup(
  options: {
    deactivate?: ReturnType<typeof vi.fn<(auth: unknown) => Deactivation>>;
    status?: AccountServerStatus;
    blocker?: string | null;
    live?: boolean;
  } = {},
) {
  const deactivate =
    options.deactivate ??
    vi.fn<(auth: unknown) => Deactivation>(async () => DEACTIVATED);
  let tokenDied = false;
  let holdCount = 0;
  const holds = new Map<string, Subscriber<ServerLogoutHoldUpdate>>();
  const release = vi.fn();
  const order: string[] = [];
  const engine = {
    accessToken: vi.fn(() =>
      of(
        options.live === false
          ? null
          : {
              homeserverUrl: 'https://example.org',
              accessToken: 'token',
              expiresAt: null,
              refreshable: false,
            },
      ),
    ),
    holdServerLogout: vi.fn(
      (_id: string) =>
        new Observable<ServerLogoutHoldUpdate>((subscriber) => {
          const holdId = `hold-${++holdCount}`;
          holds.set(holdId, subscriber);
          subscriber.next({ kind: 'held', holdId, tokenDied });
          return () => holds.delete(holdId);
        }),
    ),
    releaseServerLogoutHold: vi.fn((holdId: string, deleted: boolean) =>
      defer(() => {
        order.push(`release:${deleted}`);
        release({ deleted });
        holds.get(holdId)?.complete();
        return of(null);
      }),
    ),
    deactivateAccount: vi.fn((_id: string, erase: boolean, auth: unknown) =>
      defer(() => deactivate(auth)),
    ),
    accountStatus: vi.fn(() => of(options.status ?? 'active')),
  };
  TestBed.configureTestingModule({
    providers: [
      AccountDeletionWorkflow,
      { provide: SESSION_ENGINE, useValue: engine },
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
    engine,
    deactivate,
    accounts: TestBed.inject(AccountRuntimeService),
    stages,
    release,
    order,
    killToken: () => {
      tokenDied = true;
      for (const hold of [...holds.values()]) hold.next({ kind: 'token-died' });
    },
    signInAgain: () => {
      for (const hold of [...holds.values()]) {
        hold.next({ kind: 'signed-in-again' });
      }
    },
    /** The account left the device another way, which drops every hold on it. */
    wipeHolds: () => {
      for (const hold of [...holds.values()]) {
        hold.next({ kind: 'released' });
        hold.complete();
      }
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
    expect(test.engine.deactivateAccount).toHaveBeenCalledWith(
      ALICE,
      true,
      null,
    );
    expect(test.accounts.removeDeletedAccount).toHaveBeenCalledWith(ALICE);
    expect(test.order).toEqual(['cleanup', 'release:true']);
  });

  it('sends nothing until the engine has the hold in place', async () => {
    const test = setup();
    const held = new Subject<ServerLogoutHoldUpdate>();
    test.engine.holdServerLogout.mockReturnValue(held);
    const result = firstValueFrom(test.workflow.delete(request(test.stages)));
    await Promise.resolve();
    expect(test.deactivate).not.toHaveBeenCalled();

    held.next({ kind: 'held', holdId: 'late', tokenDied: false });

    await expect(result).resolves.toMatchObject({ kind: 'deleted' });
    expect(test.engine.releaseServerLogoutHold).toHaveBeenCalledWith(
      'late',
      true,
    );
  });

  it('passes erase false through', async () => {
    const test = setup();

    await firstValueFrom(test.workflow.delete(request(test.stages, false)));

    expect(test.engine.deactivateAccount).toHaveBeenCalledWith(
      ALICE,
      false,
      null,
    );
  });

  it('answers a password stage for the explicit account', async () => {
    const deactivate = vi
      .fn<(auth: unknown) => Deactivation>()
      .mockResolvedValueOnce(uia(['m.login.password']))
      .mockResolvedValueOnce(DEACTIVATED);
    const test = setup({ deactivate });

    await firstValueFrom(test.workflow.delete(request(test.stages)));

    expect(test.engine.deactivateAccount.mock.calls[1]).toEqual([
      ALICE,
      true,
      {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: ALICE },
        password: 'pw',
        session: 's1',
      },
    ]);
  });

  it('opens the fallback page for a stage it cannot render', async () => {
    const deactivate = vi
      .fn<(auth: unknown) => Deactivation>()
      .mockResolvedValueOnce(uia(['m.login.sso']))
      .mockResolvedValueOnce(DEACTIVATED);
    const test = setup({ deactivate });

    await firstValueFrom(test.workflow.delete(request(test.stages)));

    expect(test.stages.confirmInBrowser).toHaveBeenCalledWith({
      url: 'https://example.org/_matrix/client/v3/auth/m.login.sso/fallback/web?session=s1',
      pending: false,
    });
    expect(deactivate.mock.calls[1]).toEqual([{ session: 's1' }]);
  });

  it('reads and holds the account it was given', async () => {
    const test = setup();

    await firstValueFrom(test.workflow.delete(request(test.stages)));

    expect(test.engine.accessToken).toHaveBeenCalledWith(ALICE);
    expect(test.engine.holdServerLogout).toHaveBeenCalledWith(ALICE);
  });

  it.each([
    ['cancelled', null],
    ['attempts-exceeded', 'nope'],
  ] as const)(
    'keeps the account when authentication ends %s',
    async (reason, answer) => {
      const deactivate = vi
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValue(uia(['m.login.password']));
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
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValue(uia(null)),
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
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValue(
          failed(
            'http',
            { httpStatus: status, ...(errcode ? { errcode } : {}) },
            'unsupported',
          ),
        ),
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
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValue(
          failed(
            'permission',
            { httpStatus: 403, errcode: 'M_FORBIDDEN' },
            'forbidden',
          ),
        ),
    });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({ kind: 'kept', accountId: ALICE, reason: 'forbidden' });
  });

  it('reports rate limiting with the wait the server asked for', async () => {
    const test = setup({
      deactivate: vi.fn<(auth: unknown) => Deactivation>().mockResolvedValue(
        failed('rate-limit', {
          httpStatus: 429,
          errcode: 'M_LIMIT_EXCEEDED',
          retryAfterMs: 4000,
        }),
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
      deactivate: vi
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValue(NETWORK),
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
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValueOnce(uia(['m.login.password']))
        .mockResolvedValueOnce(NETWORK);
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
      test.deactivate
        .mockReset()
        .mockResolvedValueOnce(uia(['m.login.password']))
        .mockImplementationOnce(async () => {
          test.killToken();
          return NETWORK;
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
      test.deactivate.mockImplementation(async (auth: unknown) => {
        if (!auth) return uia(['m.login.password']);
        test.killToken();
        return UNKNOWN_TOKEN;
      });
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
      test.deactivate.mockImplementation(async (auth: unknown) =>
        auth ? NETWORK : uia(['m.login.password']),
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
    expect(test.engine.deactivateAccount).not.toHaveBeenCalled();
    expect(test.engine.holdServerLogout).not.toHaveBeenCalled();
  });

  it('sends nothing for an account without a live client', async () => {
    const test = setup({ live: false });

    await expect(
      firstValueFrom(test.workflow.delete(request(test.stages))),
    ).resolves.toEqual({
      kind: 'kept',
      accountId: ALICE,
      reason: 'account-unavailable',
    });
    expect(test.engine.holdServerLogout).not.toHaveBeenCalled();
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
      expect(test.engine.holdServerLogout).toHaveBeenCalledWith(ALICE);
    });
  });

  describe('an ambiguous failure of the authenticated request', () => {
    function failsAfterPassword(
      error: EngineResult<never>,
      status: AccountServerStatus,
    ) {
      const deactivate = vi
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValueOnce(uia(['m.login.password']))
        .mockResolvedValueOnce(error);
      return setup({ deactivate, status });
    }

    it('counts a 502 after the token died as deleted', async () => {
      const test = setup({
        status: 'unreachable',
        deactivate: vi.fn(async (auth: unknown) => {
          if (!auth) return uia(['m.login.password']);
          test.killToken();
          return failed('server', { httpStatus: 502 });
        }),
      });

      await expect(
        firstValueFrom(test.workflow.delete(request(test.stages))),
      ).resolves.toMatchObject({ kind: 'deleted' });
      expect(test.release).toHaveBeenCalledWith({ deleted: true });
    });

    it.each([
      ['a 500', failed('server', { httpStatus: 500, errcode: 'M_UNKNOWN' })],
      ['a non-Matrix HTTP error', failed('server', { httpStatus: 502 })],
      ['an unrecognised failure', failed('unexpected')],
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
          return failed('server', { httpStatus: 500, errcode: 'M_UNKNOWN' });
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
        .fn<(auth: unknown) => Deactivation>()
        .mockResolvedValueOnce(uia(['m.login.password']))
        .mockResolvedValueOnce(NETWORK);
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
      test.engine.accountStatus.mockClear();

      await expect(
        firstValueFrom(test.workflow.checkDeletion(ALICE)),
      ).resolves.toEqual({
        kind: 'deleted',
        accountId: ALICE,
        cleanup: CLEANED,
      });
      expect(test.engine.accountStatus).not.toHaveBeenCalled();
    });

    it('is forgotten once the account leaves the device another way', async () => {
      const test = unconfirmed();
      const late: unknown[] = [];
      test.workflow.lateDeletions.subscribe((result) => late.push(result));
      await firstValueFrom(test.workflow.delete(request(test.stages)));
      test.wipeHolds();
      test.deactivate
        .mockResolvedValueOnce(uia(['m.login.password']))
        .mockResolvedValueOnce(NETWORK);
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
      test.deactivate
        .mockResolvedValueOnce(uia(['m.login.password']))
        .mockImplementationOnce(async () => {
          test.killToken();
          return DEACTIVATED;
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
      test.engine.accountStatus.mockReturnValue(of('active'));

      await firstValueFrom(test.workflow.checkDeletion(ALICE));

      expect(test.release).toHaveBeenCalledTimes(2);
      expect(test.release).toHaveBeenNthCalledWith(1, { deleted: false });
      expect(test.release).toHaveBeenNthCalledWith(2, { deleted: false });
    });
  });
});
