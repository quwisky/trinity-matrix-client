import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, concat, defer, finalize, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveAccountProjectionLifetime } from './active-account-projection-lifetime';
import { ProjectionRuntime } from './projection-runtime.service';

describe('ActiveAccountProjectionLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const demanded = signal(true);
  const connect = vi.fn();
  const disconnect = vi.fn();
  const runProjection = () =>
    defer(() => {
      connect();
      return concat(of(void 0), NEVER);
    }).pipe(finalize(disconnect));
  const waitFor = vi.fn(() => of(readiness()));

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    demanded.set(true);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ActiveAccountProjectionLifetime,
        MockProvider(ProjectionRuntime, { waitFor }),
      ],
    });
  });

  it('is cold, waits for projection readiness, and releases exactly once', () => {
    const barrier = new Subject<ReturnType<typeof readiness>>();
    waitFor.mockReturnValueOnce(barrier);
    const source = TestBed.inject(ActiveAccountProjectionLifetime).run({
      activeAccountId: activeAccountId.asReadonly(),
      runProjection,
    });
    const prepared = vi.fn();

    expect(connect).not.toHaveBeenCalled();
    const lifetime = source.subscribe(prepared);
    expect(connect).toHaveBeenCalledOnce();
    expect(prepared).not.toHaveBeenCalled();

    barrier.next(readiness());
    barrier.complete();
    expect(prepared).toHaveBeenCalledWith(undefined);

    lifetime.unsubscribe();
    lifetime.unsubscribe();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('stays dormant without demand and follows later demand changes', () => {
    demanded.set(false);
    const prepared = vi.fn();
    const lifetime = TestBed.inject(ActiveAccountProjectionLifetime)
      .run({
        activeAccountId: activeAccountId.asReadonly(),
        demanded: demanded.asReadonly(),
        runProjection,
      })
      .subscribe(prepared);

    expect(prepared).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();

    demanded.set(true);
    TestBed.tick();
    expect(connect).toHaveBeenCalledOnce();

    demanded.set(false);
    TestBed.tick();
    expect(disconnect).toHaveBeenCalledOnce();

    demanded.set(true);
    TestBed.tick();
    expect(connect).toHaveBeenCalledTimes(2);

    lifetime.unsubscribe();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('lets Projection Runtime own direct Account switches and reacquires after empty', () => {
    const lifetime = TestBed.inject(ActiveAccountProjectionLifetime)
      .run({
        activeAccountId: activeAccountId.asReadonly(),
        runProjection,
      })
      .subscribe();

    activeAccountId.set('@b:example.org');
    TestBed.tick();
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();

    activeAccountId.set(null);
    TestBed.tick();
    expect(disconnect).toHaveBeenCalledOnce();

    activeAccountId.set('@c:example.org');
    TestBed.tick();
    expect(connect).toHaveBeenCalledTimes(2);

    lifetime.unsubscribe();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('uses the Observable error channel for attachment and readiness failures', () => {
    const attachmentFailure = new Error('broken attachment');
    connect.mockImplementationOnce(() => {
      throw attachmentFailure;
    });
    const attachmentError = vi.fn();

    TestBed.inject(ActiveAccountProjectionLifetime)
      .run({
        activeAccountId: activeAccountId.asReadonly(),
        runProjection,
      })
      .subscribe({ error: attachmentError });

    expect(attachmentError).toHaveBeenCalledWith(attachmentFailure);
    expect(disconnect).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    const barrier = new Subject<ReturnType<typeof readiness>>();
    waitFor.mockReturnValueOnce(barrier);
    const readinessError = vi.fn();
    TestBed.inject(ActiveAccountProjectionLifetime)
      .run({
        activeAccountId: activeAccountId.asReadonly(),
        runProjection,
      })
      .subscribe({ error: readinessError });
    const failure = new Error('broken reconciliation');

    barrier.error(failure);

    expect(readinessError).toHaveBeenCalledWith(failure);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('rejects a projection lifetime that completes instead of staying open', () => {
    const error = vi.fn();

    TestBed.inject(ActiveAccountProjectionLifetime)
      .run({
        activeAccountId: activeAccountId.asReadonly(),
        runProjection: () => of(void 0),
      })
      .subscribe({ error });

    expect(error).toHaveBeenCalledWith(
      new Error('Projection lifetime ended before release.'),
    );
  });
});

function readiness() {
  return {
    scope: { kind: 'active-account' } as const,
    durationMs: 0,
    projectionCount: 1,
    listenerCount: 1,
    retainedBytes: 0,
    acknowledgements: [{ projectionId: 'example', generation: 1 }],
  };
}
