import { TestBed } from '@angular/core/testing';
import {
  NEVER,
  Observable,
  Subject,
  concat,
  firstValueFrom,
  map,
  of,
  timer,
} from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import {
  APPLICATION_RUNTIME_ADAPTER,
  type ApplicationRuntimeAdapter,
} from './application-runtime.adapter';
import type {
  ApplicationSessionEvent,
  ApplicationStartOutcome,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';
import { ApplicationRuntimeService } from './application-runtime.service';
import {
  APPLICATION_STARTUP_PRODUCER_POLICIES,
  APPLICATION_STARTUP_WATCHDOG_BUDGET_MS,
} from './application-startup.policy';

const ready = (): ApplicationStartupStageOutcome => ({ kind: 'ready' });

describe('ApplicationRuntimeService', () => {
  let order: string[];
  let preferenceLifetime: Subject<never>;
  let preferenceLifetimeStopped: Mock<() => void>;
  let session: Subject<ApplicationSessionEvent>;
  let sessionPreparation: ApplicationSessionEvent;
  let sessionStopped: Mock<() => void>;
  let adapter: ApplicationRuntimeAdapter;
  let runtime: ApplicationRuntimeService;

  beforeEach(() => {
    order = [];
    preferenceLifetime = new Subject<never>();
    preferenceLifetimeStopped = vi.fn<() => void>();
    session = new Subject<ApplicationSessionEvent>();
    sessionPreparation = { kind: 'prepared' };
    sessionStopped = vi.fn<() => void>();
    const stage = (name: string) =>
      vi.fn(() => {
        order.push(name);
        return of(ready());
      });
    adapter = {
      negotiateHost: stage('host-negotiation'),
      hydratePreferences: stage('preference-hydration'),
      restoreAccounts: stage('account-restoration'),
      establishSessionCapabilities: stage('session-capabilities'),
      restoreWorkspace: stage('workspace-restoration'),
      awaitReadiness: stage('readiness'),
      recover: vi.fn(() => of({ kind: 'ready' as const })),
      runPreferenceLifetime: vi.fn<() => Observable<never>>(
        () =>
          new Observable<never>((subscriber) => {
            order.push('preference-lifetime');
            const subscription = preferenceLifetime.subscribe(subscriber);
            return () => {
              subscription.unsubscribe();
              preferenceLifetimeStopped();
            };
          }),
      ),
      runSession: vi.fn<ApplicationRuntimeAdapter['runSession']>(
        (readiness) =>
          new Observable<ApplicationSessionEvent>((subscriber) => {
            order.push('session-preparation');
            subscriber.next(sessionPreparation);
            if (sessionPreparation.kind === 'blocked') {
              subscriber.complete();
              return sessionStopped;
            }
            const readinessSubscription = readiness.subscribe(() =>
              order.push('session-ready'),
            );
            const subscription = session.subscribe(subscriber);
            return () => {
              readinessSubscription.unsubscribe();
              subscription.unsubscribe();
              sessionStopped();
            };
          }),
      ),
    };
    TestBed.configureTestingModule({
      providers: [
        ApplicationRuntimeService,
        { provide: APPLICATION_RUNTIME_ADAPTER, useValue: adapter },
      ],
    });
    runtime = TestBed.inject(ApplicationRuntimeService);
  });

  afterEach(() => vi.useRealTimers());

  it('times out a required stage and rejects its obsolete late result', async () => {
    vi.useFakeTimers();
    const lateHost = new Subject<ApplicationStartupStageOutcome>();
    vi.mocked(adapter.negotiateHost).mockReturnValueOnce(lateHost);
    const lifetime = runtime.run().subscribe();

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES['host-contract'].budgetMs,
    );

    const blocked = runtime.state();
    expect(blocked).toMatchObject({
      phase: 'blocked',
      failure: {
        stage: 'host-negotiation',
        diagnostic: { code: 'host-negotiation-timeout' },
      },
    });
    lateHost.next({ kind: 'ready' });
    lateHost.complete();
    expect(runtime.state()).toBe(blocked);
    expect(adapter.hydratePreferences).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('uses the overall watchdog for an unbounded compatible stage', async () => {
    vi.useFakeTimers();
    vi.mocked(adapter.hydratePreferences).mockReturnValueOnce(NEVER);
    const lifetime = runtime.run().subscribe();

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_WATCHDOG_BUDGET_MS - 1,
    );

    expect(runtime.state()).toMatchObject({
      phase: 'starting',
      stage: 'preference-hydration',
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      failure: {
        stage: 'preference-hydration',
        diagnostic: { code: 'application-startup-watchdog-expired' },
      },
    });
    expect(adapter.restoreAccounts).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('keeps the watchdog open through every stage near its declared deadline', async () => {
    vi.useFakeTimers();
    const delayedReady = (budgetMs: number) =>
      timer(budgetMs - 1).pipe(map(() => ready()));
    vi.mocked(adapter.negotiateHost).mockReturnValueOnce(
      delayedReady(
        APPLICATION_STARTUP_PRODUCER_POLICIES['host-contract'].budgetMs,
      ),
    );
    vi.mocked(adapter.hydratePreferences).mockReturnValueOnce(
      delayedReady(
        APPLICATION_STARTUP_PRODUCER_POLICIES['preference-hydration'].budgetMs,
      ),
    );
    vi.mocked(adapter.restoreAccounts).mockReturnValueOnce(
      delayedReady(
        APPLICATION_STARTUP_PRODUCER_POLICIES['account-registry'].budgetMs,
      ),
    );
    vi.mocked(adapter.runSession).mockReturnValueOnce(
      concat(
        timer(
          APPLICATION_STARTUP_PRODUCER_POLICIES['room-library'].budgetMs - 1,
        ).pipe(map(() => ({ kind: 'prepared' as const }))),
        NEVER,
      ),
    );
    vi.mocked(adapter.restoreWorkspace).mockReturnValueOnce(
      delayedReady(APPLICATION_STARTUP_PRODUCER_POLICIES.workspace.budgetMs),
    );
    vi.mocked(adapter.awaitReadiness).mockReturnValueOnce(
      delayedReady(APPLICATION_STARTUP_PRODUCER_POLICIES.readiness.budgetMs),
    );
    const lifetime = runtime.run().subscribe();

    for (const [producer, stage] of [
      ['host-contract', 'preference-hydration'],
      ['preference-hydration', 'account-restoration'],
      ['account-registry', 'session-capabilities'],
      ['room-library', 'workspace-restoration'],
      ['workspace', 'readiness'],
    ] as const) {
      await vi.advanceTimersByTimeAsync(
        APPLICATION_STARTUP_PRODUCER_POLICIES[producer].budgetMs - 1,
      );
      expect(runtime.state()).toMatchObject({ phase: 'starting', stage });
    }

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES.readiness.budgetMs - 1,
    );

    expect(runtime.state().phase).toBe('ready');
    lifetime.unsubscribe();
  });

  it('does not apply preparation deadlines to the retained healthy session', async () => {
    vi.useFakeTimers();
    const lifetime = runtime.run().subscribe();
    expect(runtime.state().phase).toBe('ready');
    expect(session.observed).toBe(true);

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_WATCHDOG_BUDGET_MS * 2,
    );

    expect(runtime.state().phase).toBe('ready');
    expect(session.observed).toBe(true);
    lifetime.unsubscribe();
  });

  it('classifies a readiness deadline without retaining the prepared session', async () => {
    vi.useFakeTimers();
    vi.mocked(adapter.awaitReadiness).mockReturnValueOnce(NEVER);
    const lifetime = runtime.run().subscribe();
    expect(runtime.state()).toMatchObject({
      phase: 'starting',
      stage: 'readiness',
    });
    expect(session.observed).toBe(true);

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES.readiness.budgetMs,
    );

    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      failure: {
        stage: 'readiness',
        diagnostic: { code: 'application-readiness-timeout' },
      },
    });
    expect(session.observed).toBe(false);
    expect(sessionStopped).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('classifies an unknown late adapter fault and recovers through the same runtime owner', async () => {
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));
    session.error(new Error('token=secret server response'));
    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      failure: {
        recovery: 'retry-startup',
        diagnostic: { code: 'application-adapter-failed' },
      },
    });
    expect(lifetime.closed).toBe(false);
    expect(JSON.stringify(runtime.state())).not.toContain('secret');
    session = new Subject<ApplicationSessionEvent>();
    expect(await firstValueFrom(runtime.recover())).toEqual({
      kind: 'accepted',
    });
    expect(runtime.state().phase).toBe('ready');
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'ready',
      'blocked',
      'ready',
    ]);
    lifetime.unsubscribe();
  });

  it('reattaches a failed preference lifetime when unknown-fault recovery restarts the session', async () => {
    const lifetime = runtime.run().subscribe();
    preferenceLifetime.error(new Error('private preference fault'));
    expect(runtime.state().phase).toBe('blocked');
    expect(lifetime.closed).toBe(false);
    preferenceLifetime = new Subject<never>();
    await firstValueFrom(runtime.recover());
    expect(runtime.state().phase).toBe('ready');
    expect(preferenceLifetime.observed).toBe(true);
    expect(adapter.runPreferenceLifetime).toHaveBeenCalledTimes(2);
    lifetime.unsubscribe();
  });

  it('classifies a synchronous preference adapter fault without publishing readiness', () => {
    vi.mocked(adapter.runPreferenceLifetime).mockImplementationOnce(() => {
      throw new Error('private fault');
    });
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));
    expect(runtime.state().phase).toBe('blocked');
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['blocked']);
    lifetime.unsubscribe();
  });

  it('rejects a late recovery result after stop and a new blocked attempt', async () => {
    sessionPreparation = {
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'blocked' },
    };
    const first = runtime.run().subscribe();
    const outcome = new Subject<{ kind: 'ready' }>();
    vi.mocked(adapter.recover).mockReturnValue(outcome);
    const pending = firstValueFrom(runtime.recover());
    await firstValueFrom(runtime.stop());
    const second = runtime.run().subscribe();
    const blocked = runtime.state();
    outcome.next({ kind: 'ready' });
    expect(await pending).toEqual({
      kind: 'unavailable',
      reason: 'transition-in-progress',
    });
    expect(runtime.state()).toBe(blocked);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('starts cleanly through every accepted stage before owning the session', async () => {
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));

    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    expect(order).toEqual([
      'host-negotiation',
      'preference-hydration',
      'preference-lifetime',
      'account-restoration',
      'session-capabilities',
      'session-preparation',
      'workspace-restoration',
      'readiness',
      'session-ready',
    ]);
    expect(outcomes).toEqual([
      {
        kind: 'ready',
        attempt: 1,
        warnings: [],
        settlements: [
          expect.objectContaining({
            producer: 'host-contract',
            status: 'ready',
          }),
          expect.objectContaining({
            producer: 'preference-hydration',
            status: 'ready',
          }),
          expect.objectContaining({
            producer: 'account-registry',
            status: 'ready',
          }),
          expect.objectContaining({
            producer: 'room-library',
            status: 'ready',
          }),
          expect.objectContaining({ producer: 'room-order', status: 'ready' }),
          expect.objectContaining({
            producer: 'browser-storage-persistence',
            status: 'ready',
          }),
          expect.objectContaining({ producer: 'workspace', status: 'ready' }),
          expect.objectContaining({ producer: 'readiness', status: 'ready' }),
        ],
      },
    ]);
    expect(adapter.runSession).toHaveBeenCalledOnce();
    expect(adapter.runPreferenceLifetime).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('preserves partial-account and optional-capability warnings', async () => {
    vi.mocked(adapter.restoreAccounts).mockReturnValueOnce(
      of({
        kind: 'ready',
        warnings: [
          {
            stage: 'account-restoration',
            scope: 'accounts',
            diagnostic: { code: 'inactive-account-restore-failed' },
            recovery: 'retry-startup',
          },
        ],
      }),
    );
    vi.mocked(adapter.establishSessionCapabilities).mockReturnValueOnce(
      of({
        kind: 'ready',
        warnings: [
          {
            stage: 'session-capabilities',
            scope: 'push',
            diagnostic: { code: 'push-registration-failed' },
            recovery: 'retry-startup',
          },
        ],
      }),
    );

    const lifetime = runtime.run().subscribe();
    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    const state = runtime.state();
    expect(state.phase === 'ready' ? state.warnings : []).toEqual([
      expect.objectContaining({ scope: 'accounts' }),
      expect.objectContaining({ scope: 'push' }),
    ]);
    lifetime.unsubscribe();
  });

  it('blocks a required failure with typed recovery and retries in order', async () => {
    vi.mocked(adapter.restoreAccounts)
      .mockReturnValueOnce(
        of({
          kind: 'blocked',
          recovery: 'reauthenticate',
          diagnostic: { code: 'active-account-unavailable' },
        }),
      )
      .mockImplementation(() => {
        order.push('account-restoration');
        return of(ready());
      });
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));
    await vi.waitFor(() => expect(runtime.state().phase).toBe('blocked'));

    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      attempt: 1,
      failure: {
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      },
    });
    await expect(firstValueFrom(runtime.recover())).resolves.toEqual({
      kind: 'accepted',
    });
    expect(adapter.recover).toHaveBeenCalledWith('reauthenticate');
    await vi.waitFor(() =>
      expect(outcomes.at(-1)).toMatchObject({ kind: 'ready', attempt: 2 }),
    );
    expect(adapter.negotiateHost).toHaveBeenCalledOnce();
    expect(adapter.hydratePreferences).toHaveBeenCalledOnce();
    expect(adapter.restoreAccounts).toHaveBeenCalledTimes(2);
    expect(adapter.runSession).toHaveBeenCalledOnce();
    expect(adapter.runPreferenceLifetime).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('records session warnings without ending the application lifetime', async () => {
    const lifetime = runtime.run().subscribe();
    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    session.next({
      kind: 'warning',
      warning: {
        stage: 'session',
        scope: 'badge',
        diagnostic: { code: 'badge-update-failed' },
        recovery: 'retry-startup',
      },
    });

    expect(runtime.state()).toMatchObject({
      phase: 'ready',
      warnings: [expect.objectContaining({ scope: 'badge' })],
    });
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('turns a post-readiness required foundation failure into its typed blocker', async () => {
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));
    expect(runtime.state().phase).toBe('ready');

    session.next({
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'room-library-projection-preparation-failed' },
    });
    session.complete();

    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      failure: {
        stage: 'session-capabilities',
        diagnostic: { code: 'room-library-projection-preparation-failed' },
      },
    });
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'ready',
      'blocked',
    ]);
    expect(sessionStopped).toHaveBeenCalledOnce();
    expect(lifetime.closed).toBe(false);
    session = new Subject<ApplicationSessionEvent>();
    await expect(firstValueFrom(runtime.recover())).resolves.toEqual({
      kind: 'accepted',
    });
    expect(runtime.state()).toMatchObject({ phase: 'ready', attempt: 2 });
    expect(adapter.runSession).toHaveBeenCalledTimes(2);
    expect(adapter.runPreferenceLifetime).toHaveBeenCalledOnce();
    expect(adapter.negotiateHost).toHaveBeenCalledOnce();
    expect(adapter.hydratePreferences).toHaveBeenCalledOnce();
    expect(adapter.restoreAccounts).toHaveBeenCalledOnce();
    expect(adapter.establishSessionCapabilities).toHaveBeenCalledTimes(2);
    expect(adapter.restoreWorkspace).toHaveBeenCalledTimes(2);
    expect(adapter.awaitReadiness).toHaveBeenCalledTimes(2);
    lifetime.unsubscribe();
  });

  it('blocks failed session preparation before Workspace and retries cleanly', async () => {
    sessionPreparation = {
      kind: 'blocked',
      recovery: 'retry-startup',
      diagnostic: { code: 'room-library-projection-preparation-failed' },
    };
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));

    await vi.waitFor(() => expect(runtime.state().phase).toBe('blocked'));

    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      failure: {
        stage: 'session-capabilities',
        diagnostic: { code: 'room-library-projection-preparation-failed' },
      },
    });
    expect(adapter.establishSessionCapabilities).toHaveBeenCalledOnce();
    expect(adapter.restoreWorkspace).not.toHaveBeenCalled();
    expect(sessionStopped).toHaveBeenCalledOnce();
    expect(runtime.state()).toMatchObject({
      settlements: [
        expect.objectContaining({ producer: 'host-contract', status: 'ready' }),
        expect.objectContaining({
          producer: 'preference-hydration',
          status: 'ready',
        }),
        expect.objectContaining({
          producer: 'account-registry',
          status: 'ready',
        }),
        expect.objectContaining({
          producer: 'room-library',
          status: 'blocked',
        }),
        expect.objectContaining({ producer: 'room-order', status: 'ready' }),
        expect.objectContaining({
          producer: 'browser-storage-persistence',
          status: 'ready',
        }),
        expect.objectContaining({
          producer: 'workspace',
          status: 'dependency-skipped',
        }),
        expect.objectContaining({
          producer: 'readiness',
          status: 'dependency-skipped',
        }),
      ],
    });

    sessionPreparation = { kind: 'prepared' };
    await expect(firstValueFrom(runtime.recover())).resolves.toEqual({
      kind: 'accepted',
    });
    await vi.waitFor(() =>
      expect(outcomes.at(-1)).toMatchObject({ kind: 'ready', attempt: 2 }),
    );

    expect(adapter.runSession).toHaveBeenCalledTimes(2);
    expect(adapter.establishSessionCapabilities).toHaveBeenCalledTimes(2);
    expect(adapter.restoreWorkspace).toHaveBeenCalledOnce();
    expect(adapter.negotiateHost).toHaveBeenCalledOnce();
    expect(adapter.hydratePreferences).toHaveBeenCalledOnce();
    expect(adapter.restoreAccounts).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('releases prepared projections when Workspace blocks and reacquires them on retry', async () => {
    vi.mocked(adapter.restoreWorkspace).mockReturnValueOnce(
      of({
        kind: 'blocked',
        recovery: 'retry-startup',
        diagnostic: { code: 'workspace-navigation-failed' },
      }),
    );
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));

    await vi.waitFor(() => expect(runtime.state().phase).toBe('blocked'));
    expect(runtime.state()).toMatchObject({
      phase: 'blocked',
      failure: {
        stage: 'workspace-restoration',
        diagnostic: { code: 'workspace-navigation-failed' },
      },
    });
    expect(sessionStopped).toHaveBeenCalledOnce();

    await expect(firstValueFrom(runtime.recover())).resolves.toEqual({
      kind: 'accepted',
    });
    await vi.waitFor(() =>
      expect(outcomes.at(-1)).toMatchObject({ kind: 'ready', attempt: 2 }),
    );
    expect(adapter.runSession).toHaveBeenCalledTimes(2);
    expect(adapter.restoreWorkspace).toHaveBeenCalledTimes(2);

    lifetime.unsubscribe();
    expect(sessionStopped).toHaveBeenCalledTimes(2);
  });

  it('tears down session ownership and can restart after shutdown', async () => {
    const first = runtime.run().subscribe();
    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    await expect(firstValueFrom(runtime.stop())).resolves.toEqual({
      kind: 'stopped',
    });
    expect(first.closed).toBe(true);
    expect(preferenceLifetimeStopped).toHaveBeenCalledOnce();
    expect(sessionStopped).toHaveBeenCalledOnce();
    expect(runtime.state()).toEqual({ phase: 'stopped' });

    const second = runtime.run().subscribe();
    await vi.waitFor(() =>
      expect(runtime.state()).toMatchObject({ phase: 'ready', attempt: 2 }),
    );
    expect(adapter.runSession).toHaveBeenCalledTimes(2);
    expect(adapter.runPreferenceLifetime).toHaveBeenCalledTimes(2);
    second.unsubscribe();
    expect(preferenceLifetimeStopped).toHaveBeenCalledTimes(2);
    expect(sessionStopped).toHaveBeenCalledTimes(2);
  });
});
