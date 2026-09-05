import { TestBed } from '@angular/core/testing';
import { NEVER, Subject, firstValueFrom, of, throwError, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import {
  PREFERENCE_STARTUP_PRODUCERS,
  PREFERENCE_STARTUP_PRODUCER_POLICIES,
  type PreferenceStartupSources,
} from './preference-startup.policy';
import { PreferenceStartupHealthService } from './preference-startup-health.service';

function readySources(): PreferenceStartupSources {
  return Object.fromEntries(
    PREFERENCE_STARTUP_PRODUCERS.map((producer) => [
      producer,
      () => of({ kind: 'ready' as const }),
    ]),
  ) as unknown as PreferenceStartupSources;
}

describe('PreferenceStartupHealthService', () => {
  let health: CapabilityHealthService;
  let service: PreferenceStartupHealthService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    health = TestBed.inject(CapabilityHealthService);
    service = TestBed.inject(PreferenceStartupHealthService);
  });

  afterEach(() => vi.useRealTimers());

  it('keeps the complete producer inventory on one stable storage contract', () => {
    expect(Object.keys(PREFERENCE_STARTUP_PRODUCER_POLICIES)).toEqual(
      PREFERENCE_STARTUP_PRODUCERS,
    );
    expect(
      Object.entries(PREFERENCE_STARTUP_PRODUCER_POLICIES).map(
        ([producer, producerPolicy]) => ({
          producer,
          operation: producerPolicy.operation,
          context: producerPolicy.context,
          storage: producerPolicy.storage,
          budgetMs: producerPolicy.budgetMs,
        }),
      ),
    ).toEqual(
      PREFERENCE_STARTUP_PRODUCERS.map((producer) => ({
        producer,
        operation: `hydrate-${producer}`,
        context: 'installation',
        storage: 'device-preferences',
        budgetMs: 10_000,
      })),
    );
  });

  it('settles every initializer when one rejects and keeps its declared default', async () => {
    const sources = readySources();
    const sibling = vi.fn(() => of({ kind: 'ready' as const }));
    const secret = 'access_token=do-not-export';
    sources['shell-layout'] = () =>
      throwError(() => new Error(`storage failed ${secret}`));
    sources['feature-flags'] = sibling;

    await expect(firstValueFrom(service.hydrate(sources))).resolves.toEqual({
      kind: 'ready',
      settlements: [
        {
          producer: 'preference-hydration',
          stage: 'preference-hydration',
          status: 'degraded',
          diagnostic: { code: 'preference-hydration-degraded' },
        },
      ],
    });
    expect(sibling).toHaveBeenCalledOnce();
    expect(health.problems()).toEqual([
      expect.objectContaining({
        capability: 'preferences',
        operation: 'hydrate-shell-layout',
        condition: 'degraded',
        code: 'shell-layout-hydration-failed',
      }),
    ]);
    expect(
      JSON.stringify(health.diagnostics('startup', 1, '0.1.0', 'web')),
    ).not.toContain(secret);
  });

  it('blocks only explicit evidence that no safe baseline exists', async () => {
    const sources = readySources();
    sources.appearance = () =>
      of({
        kind: 'blocked',
        code: 'appearance-safe-baseline-unavailable',
      });

    await expect(firstValueFrom(service.hydrate(sources))).resolves.toEqual({
      kind: 'blocked',
      recovery: 'reset-preferences',
      diagnostic: { code: 'appearance-safe-baseline-unavailable' },
      settlements: [
        {
          producer: 'preference-hydration',
          stage: 'preference-hydration',
          status: 'blocked',
          diagnostic: { code: 'appearance-safe-baseline-unavailable' },
        },
      ],
    });
  });

  it('bounds observation but joins retained work before exact recovery', async () => {
    vi.useFakeTimers();
    const sources = readySources();
    const late = new Subject<{ readonly kind: 'ready' }>();
    const source = vi.fn(() => late);
    sources.shortcuts = source;

    const hydration = firstValueFrom(service.hydrate(sources));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(hydration).resolves.toMatchObject({ kind: 'ready' });
    const problem = health.problems()[0]!;
    expect(problem).toMatchObject({
      operation: 'hydrate-shortcuts',
      code: 'shortcuts-hydration-timeout',
    });

    const recovery = firstValueFrom(health.recover(problem).pipe(toArray()));
    expect(source).toHaveBeenCalledOnce();
    late.next({ kind: 'ready' });
    late.complete();

    await expect(recovery).resolves.toEqual([
      { kind: 'pending' },
      { kind: 'success' },
    ]);
    expect(source).toHaveBeenCalledOnce();
    expect(health.problems()).toEqual([]);
  });

  it('uses the producer supplied recovery without resetting healthy siblings', async () => {
    const sources = readySources();
    const recover = vi.fn(() => of({ kind: 'ready' as const }));
    const healthy = vi.fn(() => of({ kind: 'ready' as const }));
    sources.appearance = () =>
      of({
        kind: 'defaulted',
        code: 'appearance-preference-hydration-partial',
        recover,
      });
    sources.privacy = healthy;
    await firstValueFrom(service.hydrate(sources));
    const problem = health.problems()[0]!;

    await expect(
      firstValueFrom(health.recover(problem).pipe(toArray())),
    ).resolves.toEqual([{ kind: 'pending' }, { kind: 'success' }]);
    expect(recover).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('contains a producer that never emits within its own finite budget', async () => {
    vi.useFakeTimers();
    const sources = readySources();
    sources.gifs = () => NEVER;

    const hydration = firstValueFrom(service.hydrate(sources));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(hydration).resolves.toMatchObject({ kind: 'ready' });
    expect(health.problems()[0]).toMatchObject({
      operation: 'hydrate-gifs',
      code: 'gifs-hydration-timeout',
    });
  });
});
