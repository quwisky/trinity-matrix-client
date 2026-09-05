import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import {
  NEVER,
  Observable,
  Subject,
  firstValueFrom,
  of,
  tap,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_RESTORE_POLICY,
  ACCOUNT_RUNTIME_ADAPTER,
  type AccountRuntimeAdapter,
  type AdapterAccountEstablishmentOutcome,
  type AdapterAccountRestoreOutcome,
  type AdapterAccountSwitchOutcome,
  type SavedAccountsSnapshot,
} from './account-runtime.adapter';
import { AuthenticatedAccountGrant } from './authenticated-account-grant';
import type {
  AccountEstablishmentIntent,
  AccountRestoreRole,
  AccountSignOutOutcome,
  InstallationResetOutcome,
} from './account-runtime.models';
import { AccountRuntimeService } from './account-runtime.service';

interface TestAdapter {
  readonly adapter: AccountRuntimeAdapter;
  readonly activeAccountId: ReturnType<typeof signal<string | null>>;
  readonly readSavedAccounts: ReturnType<typeof vi.fn>;
  readonly restoreAccount: ReturnType<typeof vi.fn>;
  readonly establishAccount: ReturnType<typeof vi.fn>;
  readonly prepareActiveAccount: ReturnType<typeof vi.fn>;
  readonly commitActiveAccount: ReturnType<typeof vi.fn>;
}

function testAdapter(
  snapshot: SavedAccountsSnapshot,
  restore: (
    accountId: string,
    role: AccountRestoreRole,
  ) => Observable<AdapterAccountRestoreOutcome> = () => of({ kind: 'ready' }),
): TestAdapter {
  const activeAccountId = signal<string | null>(null);
  const readSavedAccounts = vi.fn(() => of(snapshot));
  const restoreAccount = vi.fn((accountId: string, role: AccountRestoreRole) =>
    restore(accountId, role).pipe(
      tap((outcome) => {
        if (role === 'active' && outcome.kind === 'ready') {
          activeAccountId.set(accountId);
        }
      }),
    ),
  );
  const establishAccount = vi.fn(
    (_grant: AuthenticatedAccountGrant, _intent: AccountEstablishmentIntent) =>
      of<AdapterAccountEstablishmentOutcome>({ kind: 'ready' }),
  );
  const prepareActiveAccount = vi.fn(() =>
    of<AdapterAccountSwitchOutcome>({ kind: 'ready' }),
  );
  const commitActiveAccount = vi.fn((accountId: string) =>
    of<AdapterAccountSwitchOutcome>({ kind: 'ready' }).pipe(
      tap(() => activeAccountId.set(accountId)),
    ),
  );
  const signOutAccount = vi.fn((accountId: string) =>
    of({
      kind: 'ready' as const,
      accountId,
      activeAccountId: '@survivor:hs',
      remainingAccountIds: ['@survivor:hs'],
    }),
  );
  const retrySignOutCleanup = vi.fn((accountId: string) =>
    of({
      kind: 'ready' as const,
      accountId,
      activeAccountId: '@survivor:hs',
      remainingAccountIds: ['@survivor:hs'],
    }),
  );
  const resetInstallation = vi.fn(() => of({ kind: 'ready' as const }));
  const retryInstallationCleanup = vi.fn(() => of({ kind: 'ready' as const }));
  return {
    activeAccountId,
    readSavedAccounts,
    restoreAccount,
    establishAccount,
    prepareActiveAccount,
    commitActiveAccount,
    adapter: {
      activeAccountId: activeAccountId.asReadonly(),
      sweepOrphanedStores: () => of(void 0),
      readSavedAccounts,
      restoreAccount,
      establishAccount,
      prepareActiveAccount,
      commitActiveAccount,
      signOutAccount,
      retrySignOutCleanup,
      resetInstallation,
      retryInstallationCleanup,
    },
  };
}

function grant(accessToken = 'access'): AuthenticatedAccountGrant {
  return AuthenticatedAccountGrant.issue({
    baseUrl: 'https://hs',
    userId: '@new:hs',
    deviceId: 'DEVICE',
    accessToken,
  });
}

const activeIntent = {
  placement: 'active',
  liveAccounts: 'keep',
  accountRecord: 'upsert',
} satisfies AccountEstablishmentIntent;

function setup(test: TestAdapter, timeoutMs = 50): AccountRuntimeService {
  TestBed.configureTestingModule({
    providers: [
      AccountRuntimeService,
      { provide: ACCOUNT_RUNTIME_ADAPTER, useValue: test.adapter },
      {
        provide: ACCOUNT_RESTORE_POLICY,
        useValue: { timeoutMs, concurrency: 4 },
      },
    ],
  });
  return TestBed.inject(AccountRuntimeService);
}

describe('AccountRuntimeService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs out an explicit Account and reports the coherent surviving Account set', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs', '@survivor:hs'],
    });
    const runtime = setup(test);

    const outcome = await firstValueFrom(
      runtime.signOutAccount('@outgoing:hs'),
    );

    expect(test.adapter.signOutAccount).toHaveBeenCalledWith('@outgoing:hs');
    expect(outcome).toEqual({
      kind: 'ready',
      accountId: '@outgoing:hs',
      activeAccountId: '@survivor:hs',
      remainingAccountIds: ['@survivor:hs'],
    });
  });

  it('joins identical sign-out attempts and rejects a conflicting installation reset', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs'],
    });
    const pending = new Subject<
      ReturnType<AccountRuntimeAdapter['signOutAccount']> extends Observable<
        infer T
      >
        ? T
        : never
    >();
    vi.mocked(test.adapter.signOutAccount).mockReturnValue(pending);
    const runtime = setup(test);

    const first = firstValueFrom(runtime.signOutAccount('@outgoing:hs'));
    const second = firstValueFrom(runtime.signOutAccount('@outgoing:hs'));
    await expect(firstValueFrom(runtime.resetInstallation())).resolves.toEqual({
      kind: 'transition-in-progress',
      operation: 'signing-out-account',
    });
    expect(test.adapter.signOutAccount).toHaveBeenCalledOnce();

    pending.next({
      kind: 'ready',
      accountId: '@outgoing:hs',
      activeAccountId: null,
      remainingAccountIds: [],
    });
    pending.complete();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('keeps a destructive attempt owned after its UI observer detaches', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs'],
    });
    const pending = new Subject<AccountSignOutOutcome>();
    vi.mocked(test.adapter.signOutAccount).mockReturnValue(pending);
    const runtime = setup(test);

    const observer = runtime.signOutAccount('@outgoing:hs').subscribe();
    observer.unsubscribe();

    await expect(firstValueFrom(runtime.resetInstallation())).resolves.toEqual({
      kind: 'transition-in-progress',
      operation: 'signing-out-account',
    });
    expect(test.adapter.signOutAccount).toHaveBeenCalledOnce();

    pending.next({
      kind: 'ready',
      accountId: '@outgoing:hs',
      activeAccountId: null,
      remainingAccountIds: [],
    });
    pending.complete();
    expect(runtime.lifecycle()).toMatchObject({
      phase: 'settled',
      operation: 'signing-out-account',
    });
  });

  it('replays current uncertainty when a UI reopens the owned attempt', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs'],
    });
    const pending = new Subject<AccountSignOutOutcome>();
    vi.mocked(test.adapter.signOutAccount).mockReturnValue(pending);
    const runtime = setup(test);
    const first = firstValueFrom(runtime.signOutAccount('@outgoing:hs'));
    const uncertain = {
      kind: 'uncertain-cleanup' as const,
      accountId: '@outgoing:hs',
      issues: [],
      pending: [
        {
          scope: 'matrix-session' as const,
          recovery: 'retry-sign-out' as const,
        },
      ],
    };

    pending.next(uncertain);
    await expect(first).resolves.toEqual(uncertain);
    await expect(
      firstValueFrom(runtime.signOutAccount('@outgoing:hs')),
    ).resolves.toEqual(uncertain);
    expect(test.adapter.signOutAccount).toHaveBeenCalledOnce();

    pending.next({
      kind: 'ready',
      accountId: '@outgoing:hs',
      activeAccountId: null,
      remainingAccountIds: [],
    });
    pending.complete();
  });

  it('types an unexpected lifecycle adapter fault and releases its conflict', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs'],
    });
    vi.mocked(test.adapter.signOutAccount).mockReturnValue(
      throwError(() => new Error('adapter defect')),
    );
    const runtime = setup(test);

    await expect(
      firstValueFrom(runtime.signOutAccount('@outgoing:hs')),
    ).resolves.toEqual({
      kind: 'failed',
      accountId: '@outgoing:hs',
      failure: 'local-state-unavailable',
      recovery: 'retry-sign-out',
    });
    await expect(firstValueFrom(runtime.resetInstallation())).resolves.toEqual({
      kind: 'ready',
    });
  });

  it('types a synchronous adapter fault and releases its conflict', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs'],
    });
    vi.mocked(test.adapter.signOutAccount).mockImplementation(() => {
      throw new Error('adapter construction defect');
    });
    const runtime = setup(test);

    await expect(
      firstValueFrom(runtime.signOutAccount('@outgoing:hs')),
    ).resolves.toEqual({
      kind: 'failed',
      accountId: '@outgoing:hs',
      failure: 'local-state-unavailable',
      recovery: 'retry-sign-out',
    });
    await expect(firstValueFrom(runtime.resetInstallation())).resolves.toEqual({
      kind: 'ready',
    });
  });

  it('retries only settled installation residue after an owned partial attempt', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: null,
      accountIds: [],
    });
    vi.mocked(test.adapter.resetInstallation).mockReturnValueOnce(
      of({
        kind: 'partial-cleanup',
        issues: [
          {
            scope: 'preferences',
            recovery: 'retry-installation-reset',
          },
        ],
      }),
    );
    const runtime = setup(test);

    await firstValueFrom(runtime.resetInstallation());
    await firstValueFrom(runtime.resetInstallation());

    expect(test.adapter.resetInstallation).toHaveBeenCalledOnce();
    expect(test.adapter.retryInstallationCleanup).toHaveBeenCalledWith([
      { scope: 'preferences', recovery: 'retry-installation-reset' },
    ]);
  });

  it('retries only settled residue when Account removal is requested again', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@outgoing:hs',
      accountIds: ['@outgoing:hs', '@survivor:hs'],
    });
    vi.mocked(test.adapter.signOutAccount).mockReturnValueOnce(
      of({
        kind: 'partial-cleanup',
        accountId: '@outgoing:hs',
        activeAccountId: '@survivor:hs',
        remainingAccountIds: ['@survivor:hs'],
        issues: [{ scope: 'notifications', recovery: 'retry-sign-out' }],
      }),
    );
    const runtime = setup(test);

    await firstValueFrom(runtime.signOutAccount('@outgoing:hs'));
    await firstValueFrom(runtime.signOutAccount('@outgoing:hs'));

    expect(test.adapter.signOutAccount).toHaveBeenCalledOnce();
    expect(test.adapter.retrySignOutCleanup).toHaveBeenCalledWith(
      '@outgoing:hs',
      [{ scope: 'notifications', recovery: 'retry-sign-out' }],
    );
  });

  it('replays a settled reset instead of dispatching the destructive work again', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: null,
      accountIds: [],
    });
    const pending = new Subject<InstallationResetOutcome>();
    vi.mocked(test.adapter.resetInstallation).mockReturnValue(pending);
    const runtime = setup(test);
    const detached = runtime.resetInstallation().subscribe();
    detached.unsubscribe();

    pending.next({ kind: 'ready' });
    pending.complete();

    await expect(firstValueFrom(runtime.resetInstallation())).resolves.toEqual({
      kind: 'ready',
    });
    expect(test.adapter.resetInstallation).toHaveBeenCalledOnce();
  });

  it('starts the Active Account first while restoring saved Accounts concurrently', async () => {
    const active = new Subject<AdapterAccountRestoreOutcome>();
    const inactive = new Subject<AdapterAccountRestoreOutcome>();
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@inactive:hs', '@active:hs'],
      },
      (accountId) => (accountId === '@active:hs' ? active : inactive),
    );
    const runtime = setup(test);

    const resultPromise = firstValueFrom(runtime.restoreSavedAccounts());

    expect(test.restoreAccount.mock.calls).toEqual([
      ['@active:hs', 'active'],
      ['@inactive:hs', 'inactive'],
    ]);
    inactive.next({ kind: 'ready' });
    inactive.complete();
    active.next({ kind: 'ready' });
    active.complete();

    const result = await resultPromise;
    expect(result.kind).toBe('restored');
    expect(result.accounts.map((account) => account.accountId)).toEqual([
      '@active:hs',
      '@inactive:hs',
    ]);
    expect(result.metrics).toMatchObject({
      terminalAccounts: 2,
      totalAccounts: 2,
    });
    expect(runtime.hasActiveAccount()).toBe(true);
    expect(runtime.state()).toEqual({ phase: 'settled', result });
  });

  it('keeps an inactive transient failure distinct without blocking the Active Account', async () => {
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs', '@offline:hs'],
      },
      (accountId) =>
        of(
          accountId === '@active:hs'
            ? { kind: 'ready' as const }
            : {
                kind: 'failed' as const,
                failure: 'transient-network' as const,
              },
        ),
    );

    const result = await firstValueFrom(setup(test).restoreSavedAccounts());

    expect(result.kind).toBe('restored-with-inactive-failures');
    expect(result.accounts[1]).toMatchObject({
      accountId: '@offline:hs',
      role: 'inactive',
      kind: 'failed',
      failure: 'transient-network',
    });
  });

  it('retries only one failed inactive Account and joins its duplicate recovery', async () => {
    const recovery = new Subject<AdapterAccountRestoreOutcome>();
    let inactiveAttempt = 0;
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs', '@failed:hs', '@healthy:hs'],
      },
      (accountId) => {
        if (accountId === '@active:hs' || accountId === '@healthy:hs') {
          return of({ kind: 'ready' });
        }
        return inactiveAttempt++ === 0
          ? of({ kind: 'failed', failure: 'transient-network' })
          : recovery;
      },
    );
    const runtime = setup(test);
    await firstValueFrom(runtime.restoreSavedAccounts());

    const first = firstValueFrom(runtime.retryInactiveAccount('@failed:hs'));
    const duplicate = firstValueFrom(
      runtime.retryInactiveAccount('@failed:hs'),
    );

    expect(test.restoreAccount.mock.calls).toEqual([
      ['@active:hs', 'active'],
      ['@failed:hs', 'inactive'],
      ['@healthy:hs', 'inactive'],
      ['@failed:hs', 'inactive'],
    ]);
    recovery.next({ kind: 'ready' });
    recovery.complete();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ kind: 'ready', accountId: '@failed:hs' }),
      expect.objectContaining({ kind: 'ready', accountId: '@failed:hs' }),
    ]);
    expect(runtime.state()).toMatchObject({
      phase: 'settled',
      result: { kind: 'restored' },
    });
  });

  it('rejects recovery for a healthy or unknown inactive Account', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@active:hs',
      accountIds: ['@active:hs', '@healthy:hs'],
    });
    const runtime = setup(test);
    await firstValueFrom(runtime.restoreSavedAccounts());

    await expect(
      firstValueFrom(runtime.retryInactiveAccount('@healthy:hs')),
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(
      firstValueFrom(runtime.retryInactiveAccount('@unknown:hs')),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(test.restoreAccount).toHaveBeenCalledTimes(2);
  });

  it('settles independent inactive Account recoveries without serializing their scopes', async () => {
    const firstRecovery = new Subject<AdapterAccountRestoreOutcome>();
    const secondRecovery = new Subject<AdapterAccountRestoreOutcome>();
    const attempts = new Map<string, number>();
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs', '@first:hs', '@second:hs'],
      },
      (accountId) => {
        if (accountId === '@active:hs') return of({ kind: 'ready' });
        const attempt = attempts.get(accountId) ?? 0;
        attempts.set(accountId, attempt + 1);
        if (attempt === 0) {
          return of({ kind: 'failed', failure: 'transient-network' });
        }
        return accountId === '@first:hs' ? firstRecovery : secondRecovery;
      },
    );
    const runtime = setup(test);
    await firstValueFrom(runtime.restoreSavedAccounts());

    const first = firstValueFrom(runtime.retryInactiveAccount('@first:hs'));
    const second = firstValueFrom(runtime.retryInactiveAccount('@second:hs'));
    expect(firstRecovery.observed).toBe(true);
    expect(secondRecovery.observed).toBe(true);

    firstRecovery.next({ kind: 'ready' });
    firstRecovery.complete();
    await expect(first).resolves.toMatchObject({ kind: 'ready' });
    expect(runtime.state()).toMatchObject({
      phase: 'settled',
      result: { kind: 'restored-with-inactive-failures' },
    });

    secondRecovery.next({ kind: 'ready' });
    secondRecovery.complete();
    await expect(second).resolves.toMatchObject({ kind: 'ready' });
    expect(runtime.state()).toMatchObject({
      phase: 'settled',
      result: { kind: 'restored' },
    });
  });

  it.each([
    ['reauthentication-required', { kind: 'reauthentication-required' }],
    ['crypto-failure', { kind: 'failed', failure: 'crypto-failure' }],
    ['corrupt-local-state', { kind: 'failed', failure: 'corrupt-local-state' }],
  ] as const)(
    'reports an Active Account %s outcome without collapsing it into no-account',
    async (_name, outcome) => {
      const test = testAdapter(
        {
          kind: 'available',
          activeAccountId: '@active:hs',
          accountIds: ['@active:hs'],
        },
        () => of(outcome),
      );

      const result = await firstValueFrom(setup(test).restoreSavedAccounts());

      expect(result.kind).toBe('active-account-unavailable');
      expect(result.accounts[0]).toMatchObject(outcome);
    },
  );

  it('distinguishes an empty registry from corrupt local state', async () => {
    const empty = await firstValueFrom(
      setup(
        testAdapter({
          kind: 'available',
          activeAccountId: null,
          accountIds: [],
        }),
      ).restoreSavedAccounts(),
    );
    TestBed.resetTestingModule();
    const corrupt = await firstValueFrom(
      setup(
        testAdapter({ kind: 'corrupt-local-state' }),
      ).restoreSavedAccounts(),
    );

    expect(empty.kind).toBe('no-accounts');
    expect(corrupt.kind).toBe('local-state-unavailable');
  });

  it('treats a missing or duplicate Active Account pointer as corrupt state', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@missing:hs',
      accountIds: ['@same:hs', '@same:hs'],
    });

    const result = await firstValueFrom(setup(test).restoreSavedAccounts());

    expect(result.kind).toBe('local-state-unavailable');
    expect(test.restoreAccount).not.toHaveBeenCalled();
  });

  it('bounds every Account with one terminal timeout outcome', async () => {
    vi.useFakeTimers();
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs'],
      },
      () => NEVER,
    );
    const pending = firstValueFrom(setup(test, 25).restoreSavedAccounts());

    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.kind).toBe('active-account-unavailable');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      accountId: '@active:hs',
      kind: 'timed-out',
    });
  });

  it('retains committed outcomes and cancels uncommitted work coherently', () => {
    let inactiveCancelled = false;
    const inactive = new Observable<AdapterAccountRestoreOutcome>(() => () => {
      inactiveCancelled = true;
    });
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs', '@pending:hs'],
      },
      (accountId) =>
        accountId === '@active:hs' ? of({ kind: 'ready' }) : inactive,
    );
    const runtime = setup(test);

    const subscription = runtime.restoreSavedAccounts().subscribe();
    subscription.unsubscribe();

    expect(inactiveCancelled).toBe(true);
    expect(runtime.state()).toMatchObject({
      phase: 'cancelled',
      activeAccountId: '@active:hs',
      totalAccounts: 2,
      outcomes: [{ accountId: '@active:hs', kind: 'ready' }],
    });
    expect(runtime.hasActiveAccount()).toBe(true);
  });

  it('retries after a terminal failure instead of replaying it', async () => {
    let attempt = 0;
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs'],
      },
      () =>
        of(
          attempt++ === 0
            ? {
                kind: 'failed' as const,
                failure: 'transient-network' as const,
              }
            : { kind: 'ready' as const },
        ),
    );
    const runtime = setup(test);

    const first = await firstValueFrom(runtime.restoreSavedAccounts());
    const second = await firstValueFrom(runtime.restoreSavedAccounts());

    expect(first.kind).toBe('active-account-unavailable');
    expect(second.kind).toBe('restored');
    expect(test.restoreAccount).toHaveBeenCalledTimes(2);
  });

  it('reports adapter defects separately from cancellation', async () => {
    const test = testAdapter(
      {
        kind: 'available',
        activeAccountId: '@active:hs',
        accountIds: ['@active:hs'],
      },
      () =>
        new Observable((subscriber) => subscriber.error(new Error('defect'))),
    );
    const runtime = setup(test);

    await expect(
      firstValueFrom(runtime.restoreSavedAccounts()),
    ).rejects.toThrow('defect');
    expect(runtime.state()).toMatchObject({
      phase: 'failed',
      activeAccountId: '@active:hs',
      totalAccounts: 1,
      outcomes: [],
    });
  });

  it('joins repeated identical Account establishment while it is in flight', async () => {
    const pending = new Subject<AdapterAccountEstablishmentOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: null,
      accountIds: [],
    });
    test.establishAccount.mockReturnValue(pending);
    const runtime = setup(test);
    const firstGrant = grant();
    const secondGrant = grant();

    const first = firstValueFrom(
      runtime.establishAuthenticatedAccount(firstGrant, activeIntent),
    );
    const second = firstValueFrom(
      runtime.establishAuthenticatedAccount(secondGrant, activeIntent),
    );

    expect(test.establishAccount).toHaveBeenCalledOnce();
    expect(runtime.state()).toEqual({
      phase: 'establishing',
      accountId: '@new:hs',
      placement: 'active',
    });
    pending.next({ kind: 'ready' });
    pending.complete();

    await expect(first).resolves.toEqual({
      kind: 'ready',
      accountId: '@new:hs',
      placement: 'active',
    });
    await expect(second).resolves.toEqual({
      kind: 'ready',
      accountId: '@new:hs',
      placement: 'active',
    });
    expect(runtime.state()).toEqual({
      phase: 'establishment-settled',
      outcome: {
        kind: 'ready',
        accountId: '@new:hs',
        placement: 'active',
      },
    });
  });

  it('returns transition-in-progress for a conflicting Account establishment', async () => {
    const pending = new Subject<AdapterAccountEstablishmentOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: null,
      accountIds: [],
    });
    test.establishAccount.mockReturnValue(pending);
    const runtime = setup(test);
    const first = runtime
      .establishAuthenticatedAccount(grant('first'), activeIntent)
      .subscribe();

    await expect(
      firstValueFrom(
        runtime.establishAuthenticatedAccount(grant('second'), activeIntent),
      ),
    ).resolves.toEqual({
      kind: 'transition-in-progress',
      accountId: '@new:hs',
      placement: 'active',
    });
    expect(test.establishAccount).toHaveBeenCalledOnce();

    first.unsubscribe();
  });

  it('does not race saved-Account restoration with establishment', async () => {
    const pending = new Subject<AdapterAccountEstablishmentOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: null,
      accountIds: [],
    });
    test.establishAccount.mockReturnValue(pending);
    const runtime = setup(test);
    const establishment = runtime
      .establishAuthenticatedAccount(grant(), activeIntent)
      .subscribe();

    const restore = await firstValueFrom(runtime.restoreSavedAccounts());

    expect(restore.kind).toBe('transition-in-progress');
    expect(test.readSavedAccounts).not.toHaveBeenCalled();
    establishment.unsubscribe();
  });

  it('prepares, commits, and acknowledges an Active Account switch', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs', '@next:hs'],
    });
    test.activeAccountId.set('@old:hs');
    const runtime = setup(test);

    const result = await firstValueFrom(
      runtime.switchActiveAccount('@next:hs'),
    );

    expect(test.prepareActiveAccount).toHaveBeenCalledWith('@next:hs');
    expect(test.commitActiveAccount).toHaveBeenCalledWith('@next:hs');
    expect(result).toMatchObject({
      kind: 'ready',
      accountId: '@next:hs',
      metrics: { projectionCount: 0 },
    });
    expect(runtime.activeAccountId()).toBe('@next:hs');
    expect(runtime.state()).toEqual({
      phase: 'switch-settled',
      outcome: result,
    });
  });

  it('joins an identical switch and rejects a conflicting rapid switch', async () => {
    const preparation = new Subject<AdapterAccountSwitchOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs', '@next:hs'],
    });
    test.activeAccountId.set('@old:hs');
    test.prepareActiveAccount.mockReturnValue(preparation);
    const runtime = setup(test);

    const first = firstValueFrom(runtime.switchActiveAccount('@next:hs'));
    const repeated = firstValueFrom(runtime.switchActiveAccount('@next:hs'));
    await expect(
      firstValueFrom(runtime.switchActiveAccount('@other:hs')),
    ).resolves.toEqual({
      kind: 'transition-in-progress',
      accountId: '@other:hs',
      operation: 'switching-account',
    });
    expect(test.prepareActiveAccount).toHaveBeenCalledOnce();

    preparation.next({ kind: 'ready' });
    preparation.complete();
    await expect(first).resolves.toMatchObject({ kind: 'ready' });
    await expect(repeated).resolves.toMatchObject({ kind: 'ready' });
    expect(test.commitActiveAccount).toHaveBeenCalledOnce();
  });

  it('cancels preparation without committing the Active Account', () => {
    const preparation = new Subject<AdapterAccountSwitchOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs', '@next:hs'],
    });
    test.activeAccountId.set('@old:hs');
    test.prepareActiveAccount.mockReturnValue(preparation);
    const runtime = setup(test);

    const subscription = runtime.switchActiveAccount('@next:hs').subscribe();
    subscription.unsubscribe();

    expect(test.commitActiveAccount).not.toHaveBeenCalled();
    expect(runtime.state()).toEqual({
      phase: 'switch-cancelled',
      accountId: '@next:hs',
    });
  });

  it('announces the exact boundary where adapter preparation hands off to commit', async () => {
    const preparation = new Subject<AdapterAccountSwitchOutcome>();
    const onCommitStarted = vi.fn();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs', '@next:hs'],
    });
    test.activeAccountId.set('@old:hs');
    test.prepareActiveAccount.mockReturnValue(preparation);
    test.commitActiveAccount.mockImplementation((accountId: string) => {
      expect(onCommitStarted).toHaveBeenCalledOnce();
      return of<AdapterAccountSwitchOutcome>({ kind: 'ready' }).pipe(
        tap(() => test.activeAccountId.set(accountId)),
      );
    });
    const runtime = setup(test);

    const outcome = firstValueFrom(
      runtime.switchActiveAccount('@next:hs', {
        prepare: () => of(void 0),
        onCommitStarted,
      }),
    );
    expect(onCommitStarted).not.toHaveBeenCalled();

    preparation.next({ kind: 'ready' });
    preparation.complete();

    await expect(outcome).resolves.toMatchObject({ kind: 'ready' });
    expect(onCommitStarted).toHaveBeenCalledOnce();
  });

  it('finishes a committed switch after its caller unsubscribes', () => {
    const commit = new Subject<AdapterAccountSwitchOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs', '@next:hs'],
    });
    test.activeAccountId.set('@old:hs');
    test.commitActiveAccount.mockImplementation((accountId: string) =>
      commit.pipe(
        tap((outcome) => {
          if (outcome.kind === 'ready') test.activeAccountId.set(accountId);
        }),
      ),
    );
    const runtime = setup(test);

    const subscription = runtime.switchActiveAccount('@next:hs').subscribe();
    subscription.unsubscribe();
    commit.next({ kind: 'ready' });
    commit.complete();

    expect(runtime.activeAccountId()).toBe('@next:hs');
    expect(runtime.state()).toMatchObject({
      phase: 'switch-settled',
      outcome: { kind: 'ready', accountId: '@next:hs' },
    });
  });

  it('joins an identical switch after activation while readiness is pending', async () => {
    const barrier = new Subject<void>();
    let reconciliation = 0;
    const commit = new Subject<AdapterAccountSwitchOutcome>();
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs', '@next:hs'],
    });
    test.activeAccountId.set('@old:hs');
    test.commitActiveAccount.mockImplementation((accountId: string) =>
      commit.pipe(
        tap((outcome) => {
          if (outcome.kind === 'ready') test.activeAccountId.set(accountId);
        }),
      ),
    );
    const runtime = setup(test);
    TestBed.inject(ProjectionRuntime).activate({
      id: 'test.visible-projection',
      scope: { kind: 'active-account' },
      attach: () => undefined,
      reset: () => undefined,
      reconcile: () => (++reconciliation === 1 ? of(void 0) : barrier),
    });

    const first = firstValueFrom(runtime.switchActiveAccount('@next:hs'));
    commit.next({ kind: 'ready' });
    commit.complete();
    expect(runtime.activeAccountId()).toBe('@next:hs');
    let repeatedSettled = false;
    const repeated = firstValueFrom(
      runtime.switchActiveAccount('@next:hs'),
    ).then((outcome) => {
      repeatedSettled = true;
      return outcome;
    });

    await Promise.resolve();
    expect(repeatedSettled).toBe(false);
    expect(test.prepareActiveAccount).toHaveBeenCalledOnce();
    barrier.complete();

    await expect(first).resolves.toMatchObject({
      kind: 'ready',
      metrics: { projectionCount: 1 },
    });
    await expect(repeated).resolves.toMatchObject({
      kind: 'ready',
      metrics: { projectionCount: 1 },
    });
  });

  it('settles an unavailable target as a typed failure', async () => {
    const test = testAdapter({
      kind: 'available',
      activeAccountId: '@old:hs',
      accountIds: ['@old:hs'],
    });
    test.activeAccountId.set('@old:hs');
    test.prepareActiveAccount.mockReturnValue(
      of({ kind: 'failed', failure: 'account-unavailable' }),
    );
    const runtime = setup(test);

    await expect(
      firstValueFrom(runtime.switchActiveAccount('@missing:hs')),
    ).resolves.toEqual({
      kind: 'failed',
      accountId: '@missing:hs',
      failure: 'account-unavailable',
    });
    expect(test.commitActiveAccount).not.toHaveBeenCalled();
  });
});
