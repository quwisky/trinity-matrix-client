import { TestBed } from '@angular/core/testing';
import { AppearanceEffects } from '@trinity/application/appearance';
import { Subject, toArray, firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import { PreferenceEffectHealthService } from './preference-effect-health.service';

describe('PreferenceEffectHealthService', () => {
  let source: Subject<never>;
  let run: ReturnType<typeof vi.fn>;
  let health: CapabilityHealthService;
  let lifetime: PreferenceEffectHealthService;

  beforeEach(() => {
    source = new Subject<never>();
    run = vi.fn(() => source);
    TestBed.configureTestingModule({
      providers: [
        PreferenceEffectHealthService,
        CapabilityHealthService,
        { provide: AppearanceEffects, useValue: { run } },
      ],
    });
    health = TestBed.inject(CapabilityHealthService);
    lifetime = TestBed.inject(PreferenceEffectHealthService);
  });

  it('degrades only appearance application and recovers without leaking the fault', async () => {
    const owner = lifetime.run().subscribe();
    source.error(new Error('secret preference value'));

    const problem = health.problems()[0];
    expect(problem).toMatchObject({
      capability: 'preferences',
      operation: 'apply-appearance',
      condition: 'degraded',
      ownership: 'released',
      code: 'appearance-effect-unavailable',
    });
    expect(JSON.stringify(problem)).not.toContain('secret preference value');

    source = new Subject<never>();
    await expect(
      firstValueFrom(health.recover(problem).pipe(toArray())),
    ).resolves.toEqual([{ kind: 'pending' }, { kind: 'success' }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(health.problems()).toEqual([]);
    owner.unsubscribe();
    expect(source.observed).toBe(false);
  });
});
