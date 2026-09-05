import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type ProjectionObservation,
} from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import {
  BehaviorSubject,
  NEVER,
  Observable,
  concat,
  defer,
  finalize,
  lastValueFrom,
  of,
} from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRuleHealth } from './notification-health.models';
import { NotificationLifetime } from './notification-lifetime';
import { RoomNotificationsService } from './room-notifications.service';

describe('NotificationLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const demand = signal(true);
  const connect = vi.fn();
  const disconnect = vi.fn();
  const retryProjection = vi.fn();
  const states = new BehaviorSubject<ProjectionObservation>({
    condition: 'available',
    generation: 1,
  });
  const runProjection = () =>
    defer(() => {
      connect();
      return concat(of(void 0), NEVER);
    }).pipe(finalize(disconnect));

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    demand.set(true);
    states.next({ condition: 'available', generation: 1 });
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        NotificationLifetime,
        MockProvider(MatrixClientService, {
          activeUserId: activeAccountId.asReadonly(),
        }),
        MockProvider(RoomNotificationsService, {
          runProjection,
          retryProjection,
        }),
        MockProvider(ProjectionRuntime, { observe: () => states }),
      ],
    });
  });

  it('is cold, distinguishes preparation from retained rule availability, and releases once', () => {
    const events: unknown[] = [];
    const source = TestBed.inject(NotificationLifetime).run(
      demand.asReadonly(),
    );

    expect(connect).not.toHaveBeenCalled();
    const lifetime = source.subscribe((event) => events.push(event));

    expect(connect).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ kind: 'prepared' });
    expect(events).toContainEqual({
      kind: 'health',
      fact: expect.objectContaining({
        capability: 'notifications',
        operation: 'room-rules',
        preparation: 'acknowledged',
        ownership: 'retained',
        condition: 'available',
        code: 'room-rules-ready',
      }),
    });

    lifetime.unsubscribe();
    lifetime.unsubscribe();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reports no-Account and no-demand dormancy as expected, not failed initialization', () => {
    activeAccountId.set(null);
    demand.set(false);
    const events: unknown[] = [];
    const lifetime = TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe((event) => events.push(event));

    expect(connect).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        kind: 'health',
        fact: expect.objectContaining({
          demanded: false,
          preparation: 'acknowledged',
          ownership: 'released',
          condition: 'not-applicable',
          code: 'room-rules-not-demanded',
        }),
      },
      { kind: 'prepared' },
    ]);

    activeAccountId.set('@b:example.org');
    demand.set(true);
    TestBed.tick();
    expect(connect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('separates a retained reconciliation failure from released ownership', () => {
    const facts: NotificationRuleHealth[] = [];
    const lifetime = TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe((event) => {
        if (event.kind === 'health') facts.push(event.fact);
      });

    states.next({ condition: 'failed', generation: 2 });
    expect(facts.at(-1)).toMatchObject({
      ownership: 'retained',
      condition: 'degraded',
      code: 'room-rules-reconciliation-failed',
    });

    lifetime.unsubscribe();
  });

  it('retries a retained failure in place and waits for authoritative success', async () => {
    const service = TestBed.inject(NotificationLifetime);
    const facts: NotificationRuleHealth[] = [];
    const lifetime = service.run(demand.asReadonly()).subscribe((event) => {
      if (event.kind === 'health') facts.push(event.fact);
    });
    states.next({ condition: 'failed', generation: 2 });
    const failed = facts.at(-1)!;

    const recovery = lastValueFrom(
      service.recover(failed.context, failed.generation),
    );
    expect(retryProjection).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(facts.at(-1)).toMatchObject({
      condition: 'recovering',
      generation: failed.generation + 1,
    });

    states.next({ condition: 'available', generation: 3 });
    await expect(recovery).resolves.toEqual({ kind: 'success' });
    expect(connect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('reports released ownership and rejects an obsolete Account target', async () => {
    const releasedProjection = () =>
      new Observable<void>((subscriber) => {
        subscriber.next();
        subscriber.complete();
      });
    TestBed.overrideProvider(RoomNotificationsService, {
      useValue: { runProjection: releasedProjection, retryProjection },
    });
    const service = TestBed.inject(NotificationLifetime);
    const facts: NotificationRuleHealth[] = [];
    const lifetime = service.run(demand.asReadonly()).subscribe((event) => {
      if (event.kind === 'health') facts.push(event.fact);
    });
    const released = facts.at(-1)!;
    expect(released).toMatchObject({
      ownership: 'released',
      condition: 'degraded',
      code: 'room-rules-ownership-released',
    });

    activeAccountId.set('@b:example.org');
    TestBed.tick();
    await expect(
      lastValueFrom(service.recover(released.context, released.generation)),
    ).resolves.toEqual({ kind: 'unavailable' });
    lifetime.unsubscribe();
  });

  it('bounds preparation without timing a healthy retained lifetime', () => {
    vi.useFakeTimers();
    states.next({ condition: 'reconciling', generation: 2 });
    const facts: NotificationRuleHealth[] = [];
    const lifetime = TestBed.inject(NotificationLifetime)
      .run(demand.asReadonly())
      .subscribe((event) => {
        if (event.kind === 'health') facts.push(event.fact);
      });

    vi.advanceTimersByTime(10_000);
    expect(facts.at(-1)).toMatchObject({
      ownership: 'retained',
      condition: 'degraded',
      code: 'room-rules-preparation-timeout',
    });
    states.next({ condition: 'available', generation: 3 });
    vi.advanceTimersByTime(20_000);
    expect(facts.at(-1)).toMatchObject({
      ownership: 'retained',
      condition: 'available',
      code: 'room-rules-ready',
    });
    lifetime.unsubscribe();
    vi.useRealTimers();
  });
});
