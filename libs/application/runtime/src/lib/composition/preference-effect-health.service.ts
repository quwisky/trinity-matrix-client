import { Injectable, inject } from '@angular/core';
import { AppearanceEffects } from '@trinity/application/appearance';
import type {
  CapabilityHealthFact,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { Observable, Subscription, defer, of } from 'rxjs';
import { CapabilityHealthService } from '../capability-health.service';

/** Owns the appearance effect and turns an operational fault into recoverable health. */
@Injectable({ providedIn: 'root' })
export class PreferenceEffectHealthService {
  private readonly appearanceEffects = inject(AppearanceEffects);
  private readonly health = inject(CapabilityHealthService);
  private readonly context = Symbol('appearance-effect');
  private active: Subscription | null = null;
  private generation = 0;

  run(): Observable<never> {
    return new Observable(() => {
      this.start();
      return () => {
        this.active?.unsubscribe();
        this.active = null;
      };
    });
  }

  private start(): void {
    this.active?.unsubscribe();
    const generation = ++this.generation;
    const owner = new Subscription();
    this.active = owner;
    this.report(generation, 'available', 'retained', 'appearance-effect-ready');
    owner.add(
      defer(() => this.appearanceEffects.run()).subscribe({
        complete: () => this.fail(generation, owner, 'appearance-effect-ended'),
        error: () =>
          this.fail(generation, owner, 'appearance-effect-unavailable'),
      }),
    );
  }

  private fail(generation: number, owner: Subscription, code: string): void {
    if (this.active !== owner || this.generation !== generation) return;
    this.active = null;
    owner.unsubscribe();
    this.report(generation, 'degraded', 'released', code);
  }

  private report(
    generation: number,
    condition: 'available' | 'degraded',
    ownership: 'retained' | 'released',
    code: string,
  ): void {
    this.health.report(
      {
        capability: 'preferences',
        operation: 'apply-appearance',
        context: this.context,
        generation,
        demanded: true,
        preparation: condition === 'available' ? 'acknowledged' : 'failed',
        ownership,
        condition,
        code,
      } satisfies CapabilityHealthFact,
      () => this.recover(generation),
    );
  }

  private recover(generation: number): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      if (this.generation !== generation || this.active) {
        return of({ kind: 'unavailable' } as const);
      }
      this.start();
      return of(
        this.active
          ? ({ kind: 'success' } as const)
          : ({ kind: 'failure' } as const),
      );
    });
  }
}
