import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { signal } from '@angular/core';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  AccountAlreadyStoredError,
  LocalDataWipeService,
  SessionStorageService,
} from '@trinity/platform-native';
import {
  ACCOUNT_LIFECYCLE_PORT,
  type AccountLifecyclePort,
} from './account-lifecycle.port';
import { AuthenticatedAccountGrant } from './authenticated-account-grant';
import type { AccountEstablishmentIntent } from './account-runtime.models';
import { MatrixAccountRuntimeAdapter } from './matrix-account-runtime.adapter';

const session = {
  baseUrl: 'https://hs',
  userId: '@new:hs',
  deviceId: 'DEVICE',
  accessToken: 'access',
};

const activeIntent = {
  placement: 'active',
  liveAccounts: 'replace',
  accountRecord: 'upsert',
} satisfies AccountEstablishmentIntent;

function setup(activeAccountId: string | null = '@old:hs') {
  const active = signal(activeAccountId);
  const lifecycle: AccountLifecyclePort = {
    registerNotifications: vi.fn(() => of(void 0)),
    unregisterNotifications: vi.fn(() => of(void 0)),
    revokeProviderSession: vi.fn(() => of(void 0)),
    releaseSharedCaches: vi.fn(),
    clearDrafts: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      MatrixAccountRuntimeAdapter,
      MockProvider(MatrixClientService, {
        activeUserId: active.asReadonly(),
        clientFor: vi.fn(() => ({}) as never),
        rollbackAccountStart: vi.fn(() => of(void 0)),
      }),
      MockProvider(SessionStorageService),
      MockProvider(LocalDataWipeService, {
        wipeIndexedDb: vi.fn(() =>
          Promise.resolve({ blocked: [], failed: [], enumerated: true }),
        ),
        wipeKeyValueStores: vi.fn(() => Promise.resolve()),
        wipeServiceWorker: vi.fn(() => Promise.resolve()),
      }),
      { provide: ACCOUNT_LIFECYCLE_PORT, useValue: lifecycle },
    ],
  });
  return {
    adapter: TestBed.inject(MatrixAccountRuntimeAdapter),
    matrix: TestBed.inject(MatrixClientService),
    storage: TestBed.inject(SessionStorageService),
    wipe: TestBed.inject(LocalDataWipeService),
    lifecycle,
    active,
  };
}

describe('MatrixAccountRuntimeAdapter', () => {
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
    vi.mocked(matrix.reset).mockImplementation(() => {
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
    expect(matrix.reset).toHaveBeenCalledOnce();
    expect(lifecycle.releaseSharedCaches).toHaveBeenCalledOnce();
    expect(storage.clear).toHaveBeenCalledOnce();
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

  it('resets only the approved installation storage scopes in order', async () => {
    const { adapter, matrix, storage, wipe } = setup();
    const order: string[] = [];
    vi.mocked(storage.list).mockReturnValue(of([]));
    vi.mocked(matrix.signOutAll).mockReturnValue(
      defer(() => {
        order.push('sign-out');
        return of(void 0);
      }),
    );
    vi.mocked(matrix.stop).mockReturnValue(
      defer(() => {
        order.push('stop');
        return of(void 0);
      }),
    );
    vi.mocked(wipe.wipeIndexedDb).mockImplementation(() => {
      order.push('indexed-db');
      return Promise.resolve({ blocked: [], failed: [], enumerated: true });
    });
    vi.mocked(storage.clearAll).mockReturnValue(
      defer(() => {
        order.push('secure-and-registry');
        return of([]);
      }),
    );
    vi.mocked(wipe.wipeKeyValueStores).mockImplementation(() => {
      order.push('preferences');
      return Promise.resolve();
    });
    vi.mocked(wipe.wipeServiceWorker).mockImplementation(() => {
      order.push('service-worker');
      return Promise.resolve();
    });

    await expect(firstValueFrom(adapter.resetInstallation())).resolves.toEqual({
      kind: 'ready',
    });
    expect(order).toEqual([
      'sign-out',
      'stop',
      'indexed-db',
      'secure-and-registry',
      'preferences',
      'service-worker',
    ]);
  });

  it('reports cleanup failures by safe scope without leaking database names', async () => {
    const { adapter, matrix, storage, wipe } = setup();
    vi.mocked(storage.list).mockReturnValue(of([]));
    vi.mocked(matrix.signOutAll).mockReturnValue(of(void 0));
    vi.mocked(matrix.stop).mockReturnValue(of(void 0));
    vi.mocked(wipe.wipeIndexedDb).mockResolvedValue({
      blocked: ['secret-account-db'],
      failed: [],
      enumerated: true,
    });
    vi.mocked(storage.clearAll).mockReturnValue(of([]));

    const outcome = await firstValueFrom(adapter.resetInstallation());

    expect(outcome).toEqual({
      kind: 'partial-cleanup',
      issues: [{ scope: 'indexed-db', recovery: 'restart-application' }],
    });
    expect(JSON.stringify(outcome)).not.toContain('secret-account-db');
  });
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
    expect(
      storage.restoreActiveAfterFailedEstablishment,
    ).not.toHaveBeenCalled();
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
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        intent,
      ),
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
});
