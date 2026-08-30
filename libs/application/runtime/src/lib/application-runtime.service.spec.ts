import { TestBed } from '@angular/core/testing';
import { Observable, Subject, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  APPLICATION_RUNTIME_ADAPTER,
  type ApplicationRuntimeAdapter,
} from './application-runtime.adapter';
import type {
  ApplicationRuntimeWarning,
  ApplicationStartOutcome,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';
import { ApplicationRuntimeService } from './application-runtime.service';

const ready = (): ApplicationStartupStageOutcome => ({ kind: 'ready' });

describe('ApplicationRuntimeService', () => {
  let order: string[];
  let session: Subject<ApplicationRuntimeWarning>;
  let sessionStopped: Mock<() => void>;
  let adapter: ApplicationRuntimeAdapter;
  let runtime: ApplicationRuntimeService;

  beforeEach(() => {
    order = [];
    session = new Subject<ApplicationRuntimeWarning>();
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
      runSession: vi.fn<() => Observable<ApplicationRuntimeWarning>>(
        () =>
          new Observable<ApplicationRuntimeWarning>((subscriber) => {
            const subscription = session.subscribe(subscriber);
            return () => {
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

  it('starts cleanly through every accepted stage before owning the session', async () => {
    const outcomes: ApplicationStartOutcome[] = [];
    const lifetime = runtime
      .run()
      .subscribe((outcome) => outcomes.push(outcome));

    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    expect(order).toEqual([
      'host-negotiation',
      'preference-hydration',
      'account-restoration',
      'session-capabilities',
      'workspace-restoration',
      'readiness',
    ]);
    expect(outcomes).toEqual([{ kind: 'ready', attempt: 1, warnings: [] }]);
    expect(adapter.runSession).toHaveBeenCalledOnce();
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
    expect(adapter.negotiateHost).toHaveBeenCalledTimes(2);
    expect(adapter.runSession).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('records session warnings without ending the application lifetime', async () => {
    const lifetime = runtime.run().subscribe();
    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    session.next({
      stage: 'session',
      scope: 'badge',
      diagnostic: { code: 'badge-update-failed' },
      recovery: 'retry-startup',
    });

    expect(runtime.state()).toMatchObject({
      phase: 'ready',
      warnings: [expect.objectContaining({ scope: 'badge' })],
    });
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('tears down session ownership and can restart after shutdown', async () => {
    const first = runtime.run().subscribe();
    await vi.waitFor(() => expect(runtime.state().phase).toBe('ready'));

    await expect(firstValueFrom(runtime.stop())).resolves.toEqual({
      kind: 'stopped',
    });
    expect(first.closed).toBe(true);
    expect(sessionStopped).toHaveBeenCalledOnce();
    expect(runtime.state()).toEqual({ phase: 'stopped' });

    const second = runtime.run().subscribe();
    await vi.waitFor(() =>
      expect(runtime.state()).toMatchObject({ phase: 'ready', attempt: 2 }),
    );
    expect(adapter.runSession).toHaveBeenCalledTimes(2);
    second.unsubscribe();
    expect(sessionStopped).toHaveBeenCalledTimes(2);
  });
});
