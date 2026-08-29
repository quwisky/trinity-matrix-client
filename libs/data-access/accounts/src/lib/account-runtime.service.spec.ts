import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NEVER, Observable, Subject, firstValueFrom, of, tap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_RESTORE_POLICY,
  ACCOUNT_RUNTIME_ADAPTER,
  type AccountRuntimeAdapter,
  type AdapterAccountRestoreOutcome,
  type SavedAccountsSnapshot,
} from './account-runtime.adapter';
import type { AccountRestoreRole } from './account-runtime.models';
import { AccountRuntimeService } from './account-runtime.service';

interface TestAdapter {
  readonly adapter: AccountRuntimeAdapter;
  readonly activeAccountId: ReturnType<typeof signal<string | null>>;
  readonly readSavedAccounts: ReturnType<typeof vi.fn>;
  readonly restoreAccount: ReturnType<typeof vi.fn>;
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
  return {
    activeAccountId,
    readSavedAccounts,
    restoreAccount,
    adapter: {
      activeAccountId: activeAccountId.asReadonly(),
      sweepOrphanedStores: () => of(void 0),
      readSavedAccounts,
      restoreAccount,
    },
  };
}

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
});
