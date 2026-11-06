import { EMPTY, Observable, Subject, firstValueFrom, throwError } from 'rxjs';
import { afterEach, beforeEach } from 'vitest';
import { ProjectionRuntime } from './projection-runtime.service';
import type {
  ProjectionDefinition,
  ProjectionReconcileContext,
  ProjectionScope,
} from './projection-runtime.models';

afterEach(() => vi.restoreAllMocks());

const accountScope = (accountId: string): ProjectionScope => ({
  kind: 'exact-account',
  accountId,
});

function definition(
  overrides: Partial<ProjectionDefinition> = {},
): ProjectionDefinition {
  return {
    id: 'test.projection',
    scope: accountScope('@alice:example.org'),
    attach: () => undefined,
    reconcile: () => EMPTY,
    reset: () => undefined,
    resources: () => ({ listenerCount: 0, retainedBytes: 0 }),
    ...overrides,
  };
}

// A failed rebuild is these specs' subject; the runtime's development warning would only add noise.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('ProjectionRuntime', () => {
  it('accepts only the four bounded projection scopes', () => {
    const scopes = [
      { kind: 'active-account' },
      { kind: 'all-live-accounts' },
      { kind: 'exact-account', accountId: '@alice:example.org' },
      {
        kind: 'exact-conversation',
        accountId: '@alice:example.org',
        roomId: '!room:example.org',
      },
    ] satisfies readonly ProjectionScope[];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      'active-account',
      'all-live-accounts',
      'exact-account',
      'exact-conversation',
    ]);
  });

  it('matches a scope by value regardless of object property order', async () => {
    const runtime = new ProjectionRuntime();
    runtime.activate(
      definition({
        scope: {
          accountId: '@alice:example.org',
          kind: 'exact-account',
        },
      }),
    );

    await expect(
      firstValueFrom(runtime.waitFor(accountScope('@alice:example.org'))),
    ).resolves.toMatchObject({ projectionCount: 1 });
  });

  it('coalesces an invalidation burst into one reconciliation', async () => {
    const runtime = new ProjectionRuntime();
    let invalidate = (): void => undefined;
    const reconcile = vi.fn(() => EMPTY);
    runtime.activate(
      definition({
        attach: (next) => {
          invalidate = next;
        },
        reconcile,
      }),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);

    invalidate();
    invalidate();
    invalidate();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('prevents an obsolete generation from publishing after replacement', async () => {
    const runtime = new ProjectionRuntime();
    const published: string[] = [];
    const cancelOld = vi.fn();
    const oldReconciliation = new Observable<void>(() => cancelOld);
    const old = { context: null as ProjectionReconcileContext | null };
    runtime.activate(
      definition({
        reconcile: (context) => {
          old.context = context;
          return oldReconciliation;
        },
      }),
    );

    runtime.activate(
      definition({
        reconcile: (context) => {
          context.publish(() => published.push('new'));
          return EMPTY;
        },
      }),
    );
    old.context?.publish(() => published.push('old'));

    expect(published).toEqual(['new']);
    expect(cancelOld).toHaveBeenCalledOnce();
  });

  it('detaches listeners, cancels queued work, and resets on release', async () => {
    const runtime = new ProjectionRuntime();
    let invalidate = (): void => undefined;
    const detach = vi.fn();
    const reconcile = vi.fn(() => EMPTY);
    const reset = vi.fn();
    const lease = runtime.activate(
      definition({
        attach: (next) => {
          invalidate = next;
          return detach;
        },
        reconcile,
        reset,
        resources: () => ({ listenerCount: 3, retainedBytes: 24 }),
      }),
    );
    invalidate();
    lease.release();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(runtime.diagnostics()).toMatchObject({
      activeProjections: 0,
      listenerCount: 0,
      retainedBytes: 0,
    });
  });

  it('waits for the current generation and reports deterministic resources', async () => {
    const timestamps = [1, 14];
    vi.spyOn(performance, 'now').mockImplementation(
      () => timestamps.shift() ?? 14,
    );
    const runtime = new ProjectionRuntime();
    let context: ProjectionReconcileContext | null = null;
    const reconciliation = new Subject<void>();
    runtime.activate(
      definition({
        reconcile: (nextContext) => {
          context = nextContext;
          return reconciliation;
        },
        resources: () => ({ listenerCount: 2, retainedBytes: 12 }),
      }),
    );

    let settled = false;
    const readiness = firstValueFrom(
      runtime.waitFor(accountScope('@alice:example.org')),
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    reconciliation.complete();
    const result = await readiness;

    expect(result).toMatchObject({
      projectionCount: 1,
      listenerCount: 2,
      retainedBytes: 12,
      acknowledgements: [
        { projectionId: 'test.projection', generation: context!.generation },
      ],
    });
    expect(result.durationMs).toBe(13);
  });

  it('waits for a replacement generation instead of accepting an old acknowledgement', async () => {
    const runtime = new ProjectionRuntime();
    const oldReconciliation = new Subject<void>();
    const replacementReconciliation = new Subject<void>();
    runtime.activate(
      definition({
        reconcile: () => oldReconciliation,
      }),
    );
    const readiness = firstValueFrom(
      runtime.waitFor(accountScope('@alice:example.org')),
    );

    runtime.activate(
      definition({
        reconcile: () => replacementReconciliation,
      }),
    );
    oldReconciliation.complete();

    let settled = false;
    void readiness.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    replacementReconciliation.complete();
    await expect(readiness).resolves.toMatchObject({ projectionCount: 1 });
  });

  it('reattaches a scope and waits for every new generation', async () => {
    const runtime = new ProjectionRuntime();
    const detach = vi.fn();
    const reset = vi.fn();
    const reconciliations = [new Subject<void>(), new Subject<void>()];
    let attached = 0;
    runtime.activate(
      definition({
        scope: { kind: 'active-account' },
        attach: () => {
          attached += 1;
          return detach;
        },
        reconcile: () => reconciliations[attached - 1],
        reset,
      }),
    );
    reconciliations[0].complete();

    let settled = false;
    const transition = firstValueFrom(
      runtime.transition({ kind: 'active-account' }),
    ).then((readiness) => {
      settled = true;
      return readiness;
    });

    expect(attached).toBe(2);
    expect(detach).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    reconciliations[1].complete();
    await expect(transition).resolves.toMatchObject({ projectionCount: 1 });
  });

  it('reports a reconciliation defect through the readiness error channel', async () => {
    const runtime = new ProjectionRuntime();
    const defect = new Error('broken adapter');
    runtime.activate(
      definition({
        reconcile: () => throwError(() => defect),
      }),
    );

    await expect(
      firstValueFrom(runtime.waitFor(accountScope('@alice:example.org'))),
    ).rejects.toBe(defect);
  });

  it('warns in development mode, naming the projection and the error, when a rebuild fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new ProjectionRuntime();
    const defect = new Error('broken adapter');
    runtime.activate(definition({ reconcile: () => throwError(() => defect) }));
    await expect(
      firstValueFrom(runtime.waitFor(accountScope('@alice:example.org'))),
    ).rejects.toBe(defect);

    expect(warn).toHaveBeenCalledWith(
      '[projection] rebuild failed: test.projection',
      defect,
    );
  });

  it('isolates a named readiness barrier from failed sibling projections', async () => {
    const runtime = new ProjectionRuntime();
    const scope = { kind: 'active-account' } as const;
    runtime.activate(
      definition({
        id: 'owned.projection',
        scope,
      }),
    );
    runtime.activate(
      definition({
        id: 'failed.sibling',
        scope,
        reconcile: () => throwError(() => new Error('sibling failed')),
      }),
    );

    await expect(
      firstValueFrom(runtime.waitFor(scope, ['owned.projection'])),
    ).resolves.toMatchObject({
      projectionCount: 1,
      acknowledgements: [
        expect.objectContaining({ projectionId: 'owned.projection' }),
      ],
    });
    await expect(firstValueFrom(runtime.waitFor(scope))).rejects.toThrow(
      'sibling failed',
    );
  });

  describe('with a flush window', () => {
    afterEach(() => vi.useRealTimers());

    function windowed(overrides: Partial<ProjectionDefinition> = {}) {
      vi.useFakeTimers();
      const runtime = new ProjectionRuntime();
      const hooks = { invalidate: (): void => undefined, flush: () => {} };
      const reconcile = vi.fn<ProjectionDefinition['reconcile']>(() => EMPTY);
      const lease = runtime.activate(
        definition({
          coalesceMs: 100,
          attach: (invalidate, flush) => {
            hooks.invalidate = invalidate;
            hooks.flush = flush;
          },
          reconcile,
          ...overrides,
        }),
      );
      return { runtime, hooks, reconcile, lease };
    }

    it('reconciles invalidations spread over several tasks once, within the window', async () => {
      const { hooks, reconcile } = windowed();
      expect(reconcile).toHaveBeenCalledTimes(1); // the first build stays synchronous

      // The SDK awaits storage between rooms, so one sync spans several tasks.
      hooks.invalidate();
      await vi.advanceTimersByTimeAsync(30);
      hooks.invalidate();
      await vi.advanceTimersByTimeAsync(30);
      hooks.invalidate();
      expect(reconcile).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(40);
      expect(reconcile).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('reconciles at once when flushed, as at the end of a sync', async () => {
      const { hooks, reconcile } = windowed();
      hooks.invalidate();
      hooks.flush();
      expect(reconcile).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(2);
      hooks.flush(); // nothing pending
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('cancels the window timer on release', async () => {
      const { hooks, reconcile, lease } = windowed();
      hooks.invalidate();
      lease.release();

      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels the window timer on reattach and builds the new generation at once', async () => {
      const { runtime, hooks, reconcile } = windowed();
      hooks.invalidate();
      runtime.transition(accountScope('@alice:example.org')).subscribe();
      expect(reconcile).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('still drops a stale generation published after a later invalidation', async () => {
      const published: number[] = [];
      const contexts: ProjectionReconcileContext[] = [];
      const { hooks } = windowed({
        reconcile: (context) => {
          contexts.push(context);
          return new Observable<void>();
        },
      });
      hooks.invalidate();
      await vi.advanceTimersByTimeAsync(100);
      expect(contexts).toHaveLength(2);

      hooks.invalidate();
      expect(contexts[1].publish(() => published.push(2))).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(contexts[2].publish(() => published.push(3))).toBe(true);
      expect(published).toEqual([3]);
    });
  });
});
