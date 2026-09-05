import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { signal } from '@angular/core';
import { NEVER, Subject, defer, firstValueFrom, of, throwError } from 'rxjs';
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
import type {
  AccountEstablishmentIntent,
  InstallationResetOutcome,
} from './account-runtime.models';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
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
  const wipeIndexedDb = vi.fn((_records: readonly never[]) =>
    Promise.resolve({ blocked: [], failed: [], enumerated: true }),
  );
  const wipeAdapter = {
    wipeIndexedDb,
    beginIndexedDbWipe: vi.fn((records: readonly never[]) => {
      const settlement = wipeIndexedDb(records);
      return { observation: settlement, settlement };
    }),
    wipeKeyValueStores: vi.fn(() =>
      Promise.resolve({
        secureStorage: true,
        preferences: true,
        webStorage: true,
      }),
    ),
    wipeServiceWorker: vi.fn(() =>
      Promise.resolve({ cacheStorage: true, registrations: true }),
    ),
    wipeSecureStorage: vi.fn(() => Promise.resolve(true)),
    wipePreferences: vi.fn(() => Promise.resolve(true)),
    wipeWebStorage: vi.fn(() => Promise.resolve(true)),
    wipeCacheStorage: vi.fn(() => Promise.resolve(true)),
    wipeServiceWorkerRegistrations: vi.fn(() => Promise.resolve(true)),
  };
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
      MockProvider(LocalDataWipeService, wipeAdapter),
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

  it('does not claim provider cleanup when an OIDC session cannot be read', async () => {
    const { adapter, matrix, storage, lifecycle, active } = setup('@oidc:hs');
    vi.mocked(matrix.clientFor).mockReturnValue({
      logout: vi.fn(() => Promise.resolve()),
    } as never);
    vi.mocked(storage.list).mockReturnValue(
      of([
        {
          userId: '@oidc:hs',
          baseUrl: 'https://hs',
          deviceId: 'A',
          oidc: { issuer: 'https://issuer' },
        } as never,
      ]),
    );
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
      kind: 'partial-cleanup',
      accountId: '@oidc:hs',
      activeAccountId: null,
      remainingAccountIds: [],
      issues: [{ scope: 'provider-session', recovery: 'restart-application' }],
    });
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
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
    vi.mocked(wipe.wipeSecureStorage).mockImplementation(async () => {
      order.push('secure-storage');
      return true;
    });
    vi.mocked(wipe.wipePreferences).mockImplementation(async () => {
      order.push('preferences');
      return true;
    });
    vi.mocked(wipe.wipeWebStorage).mockImplementation(async () => {
      order.push('web-storage');
      return true;
    });
    vi.mocked(wipe.wipeCacheStorage).mockImplementation(async () => {
      order.push('cache-storage');
      return true;
    });
    vi.mocked(wipe.wipeServiceWorkerRegistrations).mockImplementation(
      async () => {
        order.push('service-worker');
        return true;
      },
    );

    await expect(firstValueFrom(adapter.resetInstallation())).resolves.toEqual({
      kind: 'ready',
    });
    expect(order).toEqual([
      'sign-out',
      'stop',
      'indexed-db',
      'secure-and-registry',
      'secure-storage',
      'preferences',
      'web-storage',
      'cache-storage',
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

  it('reports key-value and service-worker residue by typed safe scope', async () => {
    const { adapter, matrix, storage, wipe } = setup();
    vi.mocked(storage.list).mockReturnValue(of([]));
    vi.mocked(matrix.signOutAll).mockReturnValue(of(void 0));
    vi.mocked(matrix.stop).mockReturnValue(of(void 0));
    vi.mocked(storage.clearAll).mockReturnValue(of([]));
    vi.mocked(wipe.wipeSecureStorage).mockResolvedValue(false);
    vi.mocked(wipe.wipePreferences).mockResolvedValue(false);
    vi.mocked(wipe.wipeWebStorage).mockResolvedValue(true);
    vi.mocked(wipe.wipeCacheStorage).mockResolvedValue(false);
    vi.mocked(wipe.wipeServiceWorkerRegistrations).mockResolvedValue(true);

    await expect(firstValueFrom(adapter.resetInstallation())).resolves.toEqual({
      kind: 'partial-cleanup',
      issues: [
        {
          scope: 'secure-storage',
          recovery: 'retry-installation-reset',
        },
        { scope: 'preferences', recovery: 'retry-installation-reset' },
        {
          scope: 'service-worker',
          recovery: 'retry-installation-reset',
        },
      ],
    });
  });

  it('keeps provider residue but clears a superseded secure-read failure', async () => {
    const { adapter, matrix, storage, wipe, lifecycle } = setup();
    vi.mocked(storage.list).mockReturnValue(
      of([
        {
          userId: '@oidc:hs',
          baseUrl: 'https://hs',
          deviceId: 'A',
          oidc: { issuer: 'https://issuer' },
        } as never,
      ]),
    );
    vi.mocked(storage.load).mockReturnValue(
      throwError(() => new Error('secure read failed')),
    );
    vi.mocked(matrix.signOutAll).mockReturnValue(of(void 0));
    vi.mocked(matrix.stop).mockReturnValue(of(void 0));
    vi.mocked(storage.clearAll).mockReturnValue(of([]));
    vi.mocked(wipe.wipeSecureStorage).mockResolvedValue(true);

    await expect(firstValueFrom(adapter.resetInstallation())).resolves.toEqual({
      kind: 'partial-cleanup',
      issues: [{ scope: 'provider-session', recovery: 'restart-application' }],
    });
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
  });

  it('continues later local scopes after the secure-store budget elapses', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, matrix, storage, wipe } = setup();
      vi.mocked(storage.list).mockReturnValue(of([]));
      vi.mocked(matrix.signOutAll).mockReturnValue(of(void 0));
      vi.mocked(matrix.stop).mockReturnValue(of(void 0));
      vi.mocked(storage.clearAll).mockReturnValue(of([]));
      vi.mocked(wipe.wipeSecureStorage).mockReturnValue(
        new Promise(() => undefined),
      );
      const outcomes: InstallationResetOutcome[] = [];

      adapter
        .resetInstallation()
        .subscribe((outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.secureStorageWipe,
      );

      expect(outcomes.at(-1)).toEqual({
        kind: 'uncertain-cleanup',
        issues: [],
        pending: [
          {
            scope: 'secure-storage',
            recovery: 'retry-installation-reset',
          },
        ],
      });
      expect(wipe.wipePreferences).toHaveBeenCalledOnce();
      expect(wipe.wipeWebStorage).toHaveBeenCalledOnce();
      expect(wipe.wipeCacheStorage).toHaveBeenCalledOnce();
      expect(wipe.wipeServiceWorkerRegistrations).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a provider-revocation timeout as provider residue', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, matrix, storage, lifecycle } = setup();
      vi.mocked(storage.list).mockReturnValue(
        of([{ userId: '@oidc:hs', baseUrl: 'https://hs', deviceId: 'A' }]),
      );
      vi.mocked(storage.load).mockReturnValue(
        of({
          userId: '@oidc:hs',
          baseUrl: 'https://hs',
          oidc: { issuer: 'https://issuer' },
        } as never),
      );
      vi.mocked(matrix.signOutAll).mockReturnValue(of(void 0));
      vi.mocked(lifecycle.revokeProviderSession).mockReturnValue(NEVER);
      vi.mocked(matrix.stop).mockReturnValue(of(void 0));
      vi.mocked(storage.clearAll).mockReturnValue(of([]));

      const outcome = firstValueFrom(adapter.resetInstallation());
      await vi.advanceTimersByTimeAsync(3_001);

      await expect(outcome).resolves.toEqual({
        kind: 'uncertain-cleanup',
        issues: [],
        pending: [
          {
            scope: 'provider-session',
            recovery: 'restart-application',
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles an IndexedDB deletion that completes after its reported timeout', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, matrix, storage, wipe } = setup();
      vi.mocked(storage.list).mockReturnValue(of([]));
      vi.mocked(matrix.signOutAll).mockReturnValue(of(void 0));
      vi.mocked(matrix.stop).mockReturnValue(of(void 0));
      vi.mocked(storage.clearAll).mockReturnValue(of([]));
      const late = new Subject<{
        blocked: readonly string[];
        failed: readonly string[];
        enumerated: boolean;
      }>();
      vi.mocked(wipe.beginIndexedDbWipe).mockReturnValue({
        observation: Promise.resolve({
          blocked: ['private-db-name'],
          failed: [],
          enumerated: true,
        }),
        settlement: firstValueFrom(late),
      });
      const outcomes: InstallationResetOutcome[] = [];
      adapter
        .resetInstallation()
        .subscribe((outcome) => outcomes.push(outcome));

      await vi.advanceTimersByTimeAsync(
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.databaseWipe,
      );
      expect(outcomes.at(-1)).toEqual({
        kind: 'uncertain-cleanup',
        issues: [],
        pending: [{ scope: 'indexed-db', recovery: 'restart-application' }],
      });
      expect(JSON.stringify(outcomes)).not.toContain('private-db-name');

      late.next({ blocked: [], failed: [], enumerated: true });
      late.complete();
      await vi.runAllTimersAsync();
      expect(outcomes.at(-1)).toEqual({ kind: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries only safe local installation residue', async () => {
    const { adapter, matrix, lifecycle, wipe } = setup();
    vi.mocked(wipe.wipePreferences).mockResolvedValue(true);
    vi.mocked(wipe.wipeWebStorage).mockResolvedValue(true);

    await expect(
      firstValueFrom(
        adapter.retryInstallationCleanup([
          {
            scope: 'preferences',
            recovery: 'retry-installation-reset',
          },
          { scope: 'provider-session', recovery: 'restart-application' },
        ]),
      ),
    ).resolves.toEqual({
      kind: 'partial-cleanup',
      issues: [{ scope: 'provider-session', recovery: 'restart-application' }],
    });
    expect(wipe.wipePreferences).toHaveBeenCalledOnce();
    expect(wipe.wipeWebStorage).toHaveBeenCalledOnce();
    expect(wipe.wipeSecureStorage).not.toHaveBeenCalled();
    expect(matrix.signOutAll).not.toHaveBeenCalled();
    expect(lifecycle.revokeProviderSession).not.toHaveBeenCalled();
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
