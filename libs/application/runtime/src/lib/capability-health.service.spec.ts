import type { IdentityPresenceHealth } from '@trinity/data-access/identity';
import { TestBed } from '@angular/core/testing';
import { NEVER, Subject, firstValueFrom, of, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import { CapabilityHealthService } from './capability-health.service';

const fact = (
  context: symbol,
  overrides: Partial<IdentityPresenceHealth> = {},
): IdentityPresenceHealth => ({
  context,
  capability: 'identity',
  operation: 'presence',
  generation: 1,
  demanded: true,
  preparation: 'acknowledged',
  ownership: 'retained',
  condition: 'degraded',
  code: 'presence-reconciliation-failed',
  ...overrides,
});

describe('CapabilityHealthService', () => {
  let service: CapabilityHealthService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CapabilityHealthService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('isolates simultaneous Account scopes and deduplicates their publications', () => {
    const a = Symbol();
    const b = Symbol();
    const retry = () => of({ kind: 'success' } as const);
    service.report(fact(a), retry);
    service.report(fact(b), retry);
    const before = service.health();
    service.report(fact(a), retry);
    expect(service.health()).toBe(before);
    expect(service.problems()).toHaveLength(2);
    service.report(
      fact(a, { condition: 'available', code: 'presence-ready' }),
      retry,
    );
    expect(service.problems()).toHaveLength(1);
    expect(service.problems()[0]?.context).toBe(b);
  });

  it('preserves required failures through waiting and retires expected states', () => {
    const context = Symbol();
    const retry = () => NEVER;
    service.report(fact(context), retry);
    service.report(
      fact(context, { condition: 'waiting-for-precondition' }),
      retry,
    );
    expect(service.problems()).toHaveLength(1);
    service.report(fact(context, { condition: 'disabled' }), retry);
    expect(service.problems()).toHaveLength(0);
    service.report(
      fact(context, { condition: 'initializing', generation: 2 }),
      retry,
    );
    service.report(
      fact(context, { condition: 'degraded', generation: 1 }),
      retry,
    );
    expect(service.problems()).toHaveLength(0);
  });

  it('keeps contextual incidents separate and strips unexpected producer data', () => {
    const context = Symbol('@private:server');
    service.incident({
      context,
      capability: 'identity',
      operation: 'presence',
      code: 'presence-command-failed',
    });
    expect(service.problems()).toHaveLength(0);
    const tainted = {
      ...fact(context),
      accountId: '@private:server',
      token: 'secret-token',
      error: new Error('secret-response'),
    };
    service.report(tainted, () => NEVER);
    const json = JSON.stringify(
      service.diagnostics('session', 2, '0.1.0', 'web'),
    );
    expect(json).not.toMatch(/private|secret|accountId|context|token|error/);
    expect(json).toContain('scope-1');
    expect(JSON.stringify(service.health())).not.toContain('secret');
  });

  it('serializes conflicting recoveries and rejects superseded requests', async () => {
    const context = Symbol();
    const outcome = new Subject<CapabilityRecoveryOutcome>();
    const retry = vi.fn(() => outcome);
    service.report(fact(context), retry);
    const entry = service.problems()[0]!;
    const pending = firstValueFrom(
      service.recover(entry.reference, entry.generation).pipe(toArray()),
    );
    expect(
      await firstValueFrom(service.recover(entry.reference, entry.generation)),
    ).toEqual({ kind: 'transition-in-progress' });
    outcome.next({ kind: 'success' });
    expect(await pending).toEqual([{ kind: 'pending' }, { kind: 'success' }]);
    // Recovery success is not authoritative producer success.
    expect(service.problems()).toHaveLength(1);
    service.report(fact(context, { generation: 2 }), retry);
    expect(
      await firstValueFrom(service.recover(entry.reference, entry.generation)),
    ).toEqual({ kind: 'unavailable' });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('bounds stalled recovery and invalidates all registrations on stop', async () => {
    vi.useFakeTimers();
    service.report(fact(Symbol()), () => NEVER);
    const entry = service.problems()[0]!;
    const recovery = firstValueFrom(
      service.recover(entry.reference, entry.generation).pipe(toArray()),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await recovery).toEqual([{ kind: 'pending' }, { kind: 'failure' }]);
    service.reset();
    expect(
      await firstValueFrom(service.recover(entry.reference, entry.generation)),
    ).toEqual({ kind: 'unavailable' });
  });
});
