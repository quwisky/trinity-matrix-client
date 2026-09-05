import { TestBed } from '@angular/core/testing';
import {
  SpaceRoomOrderService,
  type RoomOrderHydrationOutcome,
} from '@trinity/data-access/room-library';
import { firstValueFrom, of, Subject, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_STARTUP_PRODUCER_POLICIES } from '../application-startup.policy';
import { CapabilityHealthService } from '../capability-health.service';
import { RoomOrderHealthService } from './room-order-health.service';

describe('RoomOrderHealthService', () => {
  let source: Subject<RoomOrderHydrationOutcome>;
  let retry: ReturnType<typeof vi.fn>;
  let health: CapabilityHealthService;
  let coordinator: RoomOrderHealthService;

  beforeEach(() => {
    source = new Subject<RoomOrderHydrationOutcome>();
    retry = vi.fn((accountId: string) => of({ accountId, kind: 'ready' }));
    TestBed.configureTestingModule({
      providers: [
        RoomOrderHealthService,
        CapabilityHealthService,
        {
          provide: SpaceRoomOrderService,
          useValue: {
            knownAccountIds: () => ['@one:example.org', '@two:example.org'],
            hydrateKnownAccounts: () => source,
            retryHydration: retry,
          },
        },
      ],
    });
    health = TestBed.inject(CapabilityHealthService);
    coordinator = TestBed.inject(RoomOrderHealthService);
  });

  afterEach(() => vi.useRealTimers());

  it('isolates recovery to the defaulted Account and retires removed scopes', async () => {
    const hydration = firstValueFrom(coordinator.hydrate());
    source.next({
      kind: 'partial',
      accounts: [
        { accountId: '@one:example.org', kind: 'ready' },
        {
          accountId: '@two:example.org',
          kind: 'defaulted',
          diagnostic: { code: 'room-order-storage-unavailable' },
        },
      ],
    });
    source.complete();
    await hydration;

    const problem = health.problems()[0];
    expect(problem).toMatchObject({
      capability: 'room-library',
      operation: 'hydrate-order',
      code: 'room-order-storage-unavailable',
    });
    expect(JSON.stringify(problem)).not.toContain('@two:example.org');
    await firstValueFrom(health.recover(problem).pipe(toArray()));
    expect(retry).toHaveBeenCalledWith('@two:example.org');
    expect(health.problems()).toEqual([]);

    coordinator.reportRuntime({
      kind: 'reconciled',
      accounts: [{ accountId: '@one:example.org', kind: 'ready' }],
    });
    expect(health.health().every((entry) => entry.severity === 'none')).toBe(
      true,
    );
  });

  it('bounds observation while retaining the underlying startup read', async () => {
    vi.useFakeTimers();
    const hydration = firstValueFrom(coordinator.hydrate());

    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES['room-order'].budgetMs,
    );
    await expect(hydration).resolves.toMatchObject({ kind: 'partial' });
    expect(source.observed).toBe(true);
    expect(health.problems()).toHaveLength(2);

    source.next({
      kind: 'ready',
      accounts: [
        { accountId: '@one:example.org', kind: 'ready' },
        { accountId: '@two:example.org', kind: 'ready' },
      ],
    });
    source.complete();
    expect(health.problems()).toEqual([]);
  });

  it('invalidates a retained read when a stopped session restarts', async () => {
    vi.useFakeTimers();
    const first = firstValueFrom(coordinator.hydrate());
    await vi.advanceTimersByTimeAsync(
      APPLICATION_STARTUP_PRODUCER_POLICIES['room-order'].budgetMs,
    );
    await first;
    const stale = source;
    health.reset();
    source = new Subject<RoomOrderHydrationOutcome>();

    const restarted = firstValueFrom(coordinator.hydrate());
    expect(stale.observed).toBe(false);
    source.next({
      kind: 'ready',
      accounts: [
        { accountId: '@one:example.org', kind: 'ready' },
        { accountId: '@two:example.org', kind: 'ready' },
      ],
    });
    source.complete();
    await restarted;
    stale.next({ kind: 'partial', accounts: [] });

    expect(health.problems()).toEqual([]);
  });
});
