import { TestBed } from '@angular/core/testing';
import {
  HostBadgeService,
  HostUpdatesService,
  type HostCapabilitySupport,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { NEVER, lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import { HostSessionHealthService } from './host-session-health.service';

describe('HostSessionHealthService', () => {
  const badgeSupport = vi.fn<() => ReturnType<HostBadgeService['support']>>(
    () => of({ kind: 'supported' }),
  );
  const updateCheck = vi.fn<() => ReturnType<HostUpdatesService['check']>>(() =>
    of({ kind: 'completed' }),
  );

  function setup() {
    TestBed.configureTestingModule({
      providers: [
        HostSessionHealthService,
        MockProvider(HostBadgeService, { support: badgeSupport }),
        MockProvider(HostUpdatesService, { check: updateCheck }),
      ],
    });
    return {
      service: TestBed.inject(HostSessionHealthService),
      health: TestBed.inject(CapabilityHealthService),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('treats unsupported badge and updates as expected host states', async () => {
    const { service, health } = setup();
    service.badgeSupport({ kind: 'unavailable', reason: 'not-supported' });
    updateCheck.mockReturnValueOnce(
      of({ kind: 'unavailable', reason: 'not-implemented' }),
    );

    await lastValueFrom(service.checkUpdates());

    expect(health.problems()).toHaveLength(0);
    expect(health.health()).toEqual([
      expect.objectContaining({
        capability: 'badge',
        operation: 'support',
        condition: 'not-applicable',
      }),
      expect.objectContaining({
        capability: 'updates',
        operation: 'check',
        condition: 'not-applicable',
      }),
    ]);
  });

  it('keeps badge write failures contextual and does not infer persistent health', () => {
    const { service, health } = setup();
    const incident = service.badgeWrite({
      kind: 'rejected',
      diagnostic: { code: 'private-adapter-detail' },
    });

    expect(incident).toBe(true);
    expect(health.problems()).toHaveLength(0);
    expect(health.incidents()).toEqual([
      expect.objectContaining({
        capability: 'badge',
        operation: 'write',
        code: 'badge-write-failed',
      }),
    ]);
    expect(JSON.stringify(health.incidents())).not.toContain('private');
  });

  it('reports failed update checks as recoverable health and clears only on a real check', async () => {
    const { service, health } = setup();
    updateCheck.mockReturnValueOnce(
      of({ kind: 'rejected', diagnostic: { code: 'server-response' } }),
    );
    await lastValueFrom(service.checkUpdates());
    const problem = health.problems()[0]!;

    expect(problem).toMatchObject({
      capability: 'updates',
      operation: 'check',
      condition: 'degraded',
      code: 'update-check-failed',
    });
    expect(
      JSON.stringify(health.diagnostics('session', 1, '1', 'web')),
    ).not.toContain('server-response');

    updateCheck.mockReturnValueOnce(of({ kind: 'completed' }));
    await expect(lastValueFrom(health.recover(problem))).resolves.toEqual({
      kind: 'success',
    });
    expect(health.problems()).toHaveLength(0);
  });

  it('bounds update checks to one finite outcome and reports a timeout safely', async () => {
    vi.useFakeTimers();
    const { service, health } = setup();
    updateCheck.mockReturnValueOnce(NEVER);

    const timedOut = lastValueFrom(service.checkUpdates());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(timedOut).resolves.toBeUndefined();
    expect(health.problems()[0]).toMatchObject({
      capability: 'updates',
      operation: 'check',
      condition: 'degraded',
      code: 'update-check-failed',
    });

    updateCheck.mockReturnValueOnce(
      of(
        { kind: 'completed' as const },
        {
          kind: 'rejected' as const,
          diagnostic: { code: 'late-outcome' },
        },
      ),
    );
    await lastValueFrom(service.checkUpdates());
    expect(health.problems()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('rejects obsolete badge recovery without probing the host again', async () => {
    const { service, health } = setup();
    const rejected: HostCapabilitySupport = {
      kind: 'unavailable',
      reason: 'host-rejected',
    };
    service.badgeSupport(rejected);
    const old = health.problems()[0]!;
    service.badgeSupport(rejected);

    await expect(lastValueFrom(health.recover(old))).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(badgeSupport).not.toHaveBeenCalled();
  });

  it('accepts a support failure returned from a badge write as health, not an incident', () => {
    const { service, health } = setup();
    const outcome: HostOperationOutcome = {
      kind: 'unavailable',
      reason: 'host-rejected',
    };

    expect(service.badgeWrite(outcome)).toBe(false);
    expect(health.problems()[0]).toMatchObject({
      capability: 'badge',
      operation: 'support',
      condition: 'degraded',
    });
    expect(health.incidents()).toHaveLength(0);
  });
});
