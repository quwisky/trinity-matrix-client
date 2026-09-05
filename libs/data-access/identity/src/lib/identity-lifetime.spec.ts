import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { NEVER, concat, defer, finalize, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityLifetime } from './identity-lifetime';
import { IdentityPresenceService } from './identity-presence.service';

describe('IdentityLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const connect = vi.fn();
  const disconnect = vi.fn();
  const runProjection = () =>
    defer(() => {
      connect();
      return concat(of(void 0), NEVER);
    }).pipe(finalize(disconnect));

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        IdentityLifetime,
        MockProvider(IdentityMatrixPort, {
          activeAccountId: activeAccountId.asReadonly(),
        }),
        MockProvider(IdentityPresenceService, { runProjection }),
        MockProvider(ProjectionRuntime, {
          waitFor: () => of(readiness()),
        }),
      ],
    });
  });

  it('is cold and retains Identity presence until teardown', () => {
    const source = TestBed.inject(IdentityLifetime).run(signal(true));
    const prepared = vi.fn();

    expect(connect).not.toHaveBeenCalled();

    const lifetime = source.subscribe(prepared);

    expect(prepared).toHaveBeenCalledWith(undefined);
    expect(lifetime.closed).toBe(false);
    expect(connect).toHaveBeenCalledOnce();

    lifetime.unsubscribe();

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reacquires presence when an Account appears after an empty set', () => {
    activeAccountId.set(null);
    const lifetime = TestBed.inject(IdentityLifetime)
      .run(signal(true))
      .subscribe();
    TestBed.tick();

    expect(connect).not.toHaveBeenCalled();

    activeAccountId.set('@b:example.org');
    TestBed.tick();

    expect(connect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('uses the Observable error channel and cleans up a failed attachment', () => {
    const failure = new Error('broken Identity adapter');
    connect.mockImplementationOnce(() => {
      throw failure;
    });
    const error = vi.fn();

    TestBed.inject(IdentityLifetime).run(signal(true)).subscribe({ error });

    expect(error).toHaveBeenCalledWith(failure);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('stays dormant until Workspace demands presence', () => {
    const demanded = signal(false);
    const lifetime = TestBed.inject(IdentityLifetime)
      .run(demanded.asReadonly())
      .subscribe();

    expect(connect).not.toHaveBeenCalled();

    demanded.set(true);
    TestBed.tick();
    expect(connect).toHaveBeenCalledOnce();

    demanded.set(false);
    TestBed.tick();
    expect(disconnect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });
});

function readiness() {
  return {
    scope: { kind: 'active-account' } as const,
    durationMs: 0,
    projectionCount: 1,
    listenerCount: 1,
    retainedBytes: 0,
    acknowledgements: [],
  };
}
