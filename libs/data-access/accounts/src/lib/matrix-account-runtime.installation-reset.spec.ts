import { NEVER, Subject, defer, firstValueFrom, of, throwError } from 'rxjs';
import { expect, it, vi } from 'vitest';
import type { AccountRecord } from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import type { InstallationResetOutcome } from './account-runtime.models';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import {
  deferred,
  prepareSuccessfulReset,
  setup,
  type AdapterTest,
} from './matrix-account-runtime.spec-harness';

it('resets only the approved installation storage scopes in order', async () => {
  const { adapter, matrix, storage, wipe, lifecycle } = setup();
  const order: string[] = [];
  vi.mocked(storage.list).mockReturnValue(of([]));
  vi.mocked(lifecycle.forgetPushHandoff).mockReturnValue(
    defer(() => {
      order.push('push-handoff');
      return of(void 0);
    }),
  );
  vi.mocked(lifecycle.unregisterNotifications).mockReturnValue(
    defer(() => {
      order.push('notifications');
      return of(void 0);
    }),
  );
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
  vi.mocked(lifecycle.stopDiagnosticLog).mockReturnValue(
    defer(() => {
      order.push('diagnostic-log');
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
  vi.mocked(lifecycle.resumeDiagnosticLog).mockReturnValue(
    defer(() => {
      order.push('resume-diagnostic-log');
      return of(void 0);
    }),
  );

  await expect(firstValueFrom(adapter.resetInstallation())).resolves.toEqual({
    kind: 'ready',
  });
  expect(order).toEqual([
    'push-handoff',
    'notifications',
    'sign-out',
    'stop',
    'diagnostic-log',
    'indexed-db',
    'secure-and-registry',
    'secure-storage',
    'preferences',
    'web-storage',
    'cache-storage',
    'service-worker',
    'resume-diagnostic-log',
  ]);
});

it('settles ready when the diagnostic log cannot be resumed, or never answers', async () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    prepareSuccessfulReset(test);
    vi.mocked(test.lifecycle.resumeDiagnosticLog).mockReturnValue(
      throwError(() => new Error('preferences unreadable')),
    );
    await expect(
      firstValueFrom(test.adapter.resetInstallation()),
    ).resolves.toEqual({ kind: 'ready' });

    vi.mocked(test.lifecycle.resumeDiagnosticLog).mockReturnValue(NEVER);
    const outcome = firstValueFrom(test.adapter.resetInstallation());
    await vi.advanceTimersByTimeAsync(
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.diagnosticLogStop,
    );
    await expect(outcome).resolves.toEqual({ kind: 'ready' });
  } finally {
    vi.useRealTimers();
  }
});

it('still wipes, with nothing to report, when the diagnostic log cannot be stopped', async () => {
  const test = setup();
  prepareSuccessfulReset(test);
  vi.mocked(test.lifecycle.stopDiagnosticLog).mockReturnValue(
    throwError(() => new Error('log database blocked')),
  );

  await expect(
    firstValueFrom(test.adapter.resetInstallation()),
  ).resolves.toEqual({ kind: 'ready' });
  expect(test.wipe.beginIndexedDbWipe).toHaveBeenCalledOnce();
});

it('wipes after its budget when stopping the diagnostic log never settles', async () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    prepareSuccessfulReset(test);
    vi.mocked(test.lifecycle.stopDiagnosticLog).mockReturnValue(NEVER);

    const outcome = firstValueFrom(test.adapter.resetInstallation());
    await vi.advanceTimersByTimeAsync(
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.diagnosticLogStop,
    );

    await expect(outcome).resolves.toEqual({ kind: 'ready' });
    expect(test.wipe.beginIndexedDbWipe).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('empties the drafts held in memory once the clients have stopped, so no later write restores them', async () => {
  const test = setup();
  prepareSuccessfulReset(test);

  await expect(
    firstValueFrom(test.adapter.resetInstallation()),
  ).resolves.toEqual({ kind: 'ready' });

  expect(test.lifecycle.clearDrafts).toHaveBeenCalledOnce();
  expect(
    vi.mocked(test.lifecycle.clearDrafts).mock.invocationCallOrder[0],
  ).toBeGreaterThan(vi.mocked(test.matrix.stop).mock.invocationCallOrder[0]);
});

it('asks for a restart when the drafts held in memory cannot be emptied', async () => {
  const test = setup();
  prepareSuccessfulReset(test);
  vi.mocked(test.lifecycle.clearDrafts).mockImplementation(() => {
    throw new Error('the draft store is gone');
  });

  await expect(
    firstValueFrom(test.adapter.resetInstallation()),
  ).resolves.toEqual({
    kind: 'partial-cleanup',
    issues: [{ scope: 'drafts', recovery: 'restart-application' }],
  });
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

it('reports a stalled registry read while retaining the prerequisite before cleanup', async () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    prepareSuccessfulReset(test);
    const registry = new Subject<AccountRecord[]>();
    vi.mocked(test.storage.list).mockReturnValue(registry);
    const outcomes: InstallationResetOutcome[] = [];

    test.adapter
      .resetInstallation()
      .subscribe((outcome) => outcomes.push(outcome));
    await vi.advanceTimersByTimeAsync(
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryRead,
    );

    expect(outcomes.at(-1)).toEqual({
      kind: 'uncertain-cleanup',
      issues: [],
      pending: [
        {
          scope: 'account-registry',
          recovery: 'retry-installation-reset',
        },
      ],
    });
    expect(test.matrix.signOutAll).not.toHaveBeenCalled();

    registry.next([]);
    registry.complete();
    await vi.runAllTimersAsync();
    expect(outcomes.at(-1)).toEqual({ kind: 'ready' });
  } finally {
    vi.useRealTimers();
  }
});

it('advances installation cleanup after a session-read budget without cancelling the read', async () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    const record: AccountRecord = {
      userId: '@saved:hs',
      baseUrl: 'https://hs',
      deviceId: 'DEVICE',
    };
    prepareSuccessfulReset(test, [record]);
    const sessionRead = new Subject<MatrixSession | null>();
    vi.mocked(test.storage.load).mockReturnValue(sessionRead);
    const outcomes: InstallationResetOutcome[] = [];

    test.adapter
      .resetInstallation()
      .subscribe((outcome) => outcomes.push(outcome));
    await vi.advanceTimersByTimeAsync(
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.sessionRead,
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
    expect(test.matrix.stop).toHaveBeenCalledOnce();
    expect(test.wipe.wipeSecureStorage).toHaveBeenCalledOnce();
    expect(sessionRead.observed).toBe(true);

    sessionRead.next(null);
    sessionRead.complete();
    await vi.runAllTimersAsync();
    expect(outcomes.at(-1)).toEqual({ kind: 'ready' });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    name: 'notification removal',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
    scope: 'notifications' as const,
    arrange: (test: AdapterTest, stalled: Subject<void>) =>
      vi
        .mocked(test.lifecycle.unregisterNotifications)
        .mockReturnValue(stalled),
    laterRan: (test: AdapterTest) =>
      expect(test.matrix.stop).toHaveBeenCalledOnce(),
  },
  {
    name: 'Matrix server logout',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
    scope: 'matrix-session' as const,
    arrange: (test: AdapterTest, stalled: Subject<void>) =>
      vi.mocked(test.matrix.signOutAll).mockReturnValue(stalled),
    laterRan: (test: AdapterTest) =>
      expect(test.matrix.stop).toHaveBeenCalledOnce(),
  },
  {
    name: 'Matrix stop',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
    scope: 'matrix-session' as const,
    arrange: (test: AdapterTest, stalled: Subject<void>) =>
      vi.mocked(test.matrix.stop).mockReturnValue(stalled),
    laterRan: (test: AdapterTest) =>
      expect(test.wipe.beginIndexedDbWipe).toHaveBeenCalledOnce(),
  },
  {
    name: 'Account registry write',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
    scope: 'account-registry' as const,
    arrange: (test: AdapterTest, stalled: Subject<void>) =>
      vi.mocked(test.storage.clearAll).mockReturnValue(stalled as never),
    laterRan: (test: AdapterTest) =>
      expect(test.wipe.wipeSecureStorage).toHaveBeenCalledOnce(),
  },
])(
  'advances later cleanup while stalled $name remains owned',
  async ({ budget, scope, arrange, laterRan }) => {
    vi.useFakeTimers();
    try {
      const test = setup();
      prepareSuccessfulReset(test);
      const stalled = new Subject<void>();
      arrange(test, stalled);
      const outcomes: InstallationResetOutcome[] = [];

      test.adapter
        .resetInstallation()
        .subscribe((outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(budget);

      expect(outcomes.at(-1)).toEqual({
        kind: 'uncertain-cleanup',
        issues: [],
        pending: [
          {
            scope,
            recovery:
              scope === 'account-registry'
                ? 'retry-installation-reset'
                : 'restart-application',
          },
        ],
      });
      laterRan(test);
      expect(stalled.observed).toBe(true);

      stalled.next();
      stalled.complete();
      await vi.runAllTimersAsync();
      expect(outcomes.at(-1)).toEqual({ kind: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  },
);

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

    adapter.resetInstallation().subscribe((outcome) => outcomes.push(outcome));
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

it.each([
  {
    name: 'Preferences',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.preferencesWipe,
    arrange: (test: AdapterTest, promise: Promise<boolean>) =>
      vi.mocked(test.wipe.wipePreferences).mockReturnValue(promise),
    laterRan: (test: AdapterTest) =>
      expect(test.wipe.wipeWebStorage).toHaveBeenCalledOnce(),
    scope: 'preferences' as const,
  },
  {
    name: 'raw web storage',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.webStorageWipe,
    arrange: (test: AdapterTest, promise: Promise<boolean>) =>
      vi.mocked(test.wipe.wipeWebStorage).mockReturnValue(promise),
    laterRan: (test: AdapterTest) =>
      expect(test.wipe.wipeCacheStorage).toHaveBeenCalledOnce(),
    scope: 'preferences' as const,
  },
  {
    name: 'cache storage',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.cacheStorageWipe,
    arrange: (test: AdapterTest, promise: Promise<boolean>) =>
      vi.mocked(test.wipe.wipeCacheStorage).mockReturnValue(promise),
    laterRan: (test: AdapterTest) =>
      expect(test.wipe.wipeServiceWorkerRegistrations).toHaveBeenCalledOnce(),
    scope: 'service-worker' as const,
  },
  {
    name: 'service-worker registration',
    budget: ACCOUNT_CLEANUP_STEP_BUDGET_MS.serviceWorkerRegistrationWipe,
    arrange: (test: AdapterTest, promise: Promise<boolean>) =>
      vi
        .mocked(test.wipe.wipeServiceWorkerRegistrations)
        .mockReturnValue(promise),
    laterRan: () => undefined,
    scope: 'service-worker' as const,
  },
])(
  'bounds a stalled $name wipe and retains its Promise to settlement',
  async ({ budget, arrange, laterRan, scope }) => {
    vi.useFakeTimers();
    try {
      const test = setup();
      prepareSuccessfulReset(test);
      const stalled = deferred<boolean>();
      arrange(test, stalled.promise);
      const outcomes: InstallationResetOutcome[] = [];

      test.adapter
        .resetInstallation()
        .subscribe((outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(budget);

      expect(outcomes.at(-1)).toEqual({
        kind: 'uncertain-cleanup',
        issues: [],
        pending: [{ scope, recovery: 'retry-installation-reset' }],
      });
      laterRan(test);

      stalled.resolve(true);
      await vi.runAllTimersAsync();
      expect(outcomes.at(-1)).toEqual({ kind: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  },
);

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
    adapter.resetInstallation().subscribe((outcome) => outcomes.push(outcome));

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
  // The retried preferences wipe may have returned the log's setting to its default.
  expect(lifecycle.resumeDiagnosticLog).toHaveBeenCalledOnce();
  expect(
    vi.mocked(lifecycle.resumeDiagnosticLog).mock.invocationCallOrder[0],
  ).toBeGreaterThan(
    vi.mocked(wipe.wipePreferences).mock.invocationCallOrder[0],
  );
});
