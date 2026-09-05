import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationLifetime,
  NotificationLifetimeError,
} from './notification-lifetime';
import { RoomNotificationsService } from './room-notifications.service';

describe('NotificationLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const demand = signal(true);
  const connect = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    demand.set(true);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        NotificationLifetime,
        MockProvider(MatrixClientService, {
          activeUserId: activeAccountId.asReadonly(),
        }),
        MockProvider(RoomNotificationsService, { connect, disconnect }),
        MockProvider(ProjectionRuntime, {
          waitFor: () => of(readiness()),
        }),
      ],
    });
  });

  it('is cold and retains per-Room notification rules until teardown', () => {
    const source = TestBed.inject(NotificationLifetime).run(
      demand.asReadonly(),
    );
    const prepared = vi.fn();

    expect(connect).not.toHaveBeenCalled();
    const lifetime = source.subscribe(prepared);

    expect(prepared).toHaveBeenCalledWith(undefined);
    expect(connect).toHaveBeenCalledOnce();
    expect(lifetime.closed).toBe(false);

    lifetime.unsubscribe();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps Room-specific work dormant until Application Runtime demands it', () => {
    demand.set(false);
    const lifetime = TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe();

    expect(connect).not.toHaveBeenCalled();

    demand.set(true);
    TestBed.tick();
    expect(connect).toHaveBeenCalledOnce();

    demand.set(false);
    TestBed.tick();
    expect(disconnect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('reacquires notification rules when an Account appears after an empty set', () => {
    activeAccountId.set(null);
    const lifetime = TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe();

    expect(connect).not.toHaveBeenCalled();

    activeAccountId.set('@b:example.org');
    TestBed.tick();
    expect(connect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('keeps unexpected attachment defects on the error channel', () => {
    const defect = new Error('broken notification adapter');
    connect.mockImplementationOnce(() => {
      throw defect;
    });
    const error = vi.fn();

    TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe({ error });

    expect(error).toHaveBeenCalledWith(defect);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('classifies a transient Matrix attachment failure without leaking details', () => {
    connect.mockImplementationOnce(() => {
      throw new MatrixError(
        { errcode: 'M_UNKNOWN', error: 'private server response' },
        503,
      );
    });
    const error = vi.fn();

    TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe({ error });

    expect(error).toHaveBeenCalledWith(expect.any(NotificationLifetimeError));
    expect(error.mock.calls[0]?.[0].message).not.toContain('private');
  });
});

function readiness() {
  return {
    scope: { kind: 'active-account' } as const,
    durationMs: 0,
    projectionCount: 0,
    listenerCount: 0,
    retainedBytes: 0,
    acknowledgements: [],
  };
}
