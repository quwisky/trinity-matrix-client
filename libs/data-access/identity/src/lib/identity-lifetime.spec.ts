import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type CapabilityHealthFact,
} from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { NEVER, Observable, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdentityLifetime,
  type IdentityLifetimeEvent,
} from './identity-lifetime';
import { IdentityPresenceService } from './identity-presence.service';

describe('IdentityLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const demanded = signal(true);
  let runtime: ProjectionRuntime;
  let service: IdentityLifetime;
  let failAttach: boolean;
  let failRead: boolean;
  let stallRead: boolean;
  let invalidate: () => void;
  let release: () => void;
  let connections: number;
  let disconnections: number;
  let events: IdentityLifetimeEvent[];
  const latest = (): CapabilityHealthFact => {
    const event = events.filter((event) => event.kind === 'health').at(-1);
    if (!event || event.kind !== 'health') throw new Error('Missing health');
    return event.fact;
  };

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    demanded.set(true);
    failAttach = false;
    failRead = false;
    stallRead = false;
    connections = 0;
    disconnections = 0;
    events = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(IdentityMatrixPort, { activeAccountId }),
        MockProvider(IdentityPresenceService, {
          runProjection: () =>
            new Observable<void>((subscriber) => {
              connections += 1;
              if (failAttach) throw new Error('secret raw fault');
              const lease = runtime.activate({
                id: 'identity.presence',
                scope: { kind: 'active-account' },
                attach: (next) => {
                  invalidate = next;
                  return () => {
                    disconnections += 1;
                  };
                },
                reconcile: () =>
                  stallRead
                    ? NEVER
                    : failRead
                      ? throwError(() => new Error('secret response'))
                      : of(undefined),
                reset: () => undefined,
              });
              release = () => lease.release();
              subscriber.next();
              return release;
            }),
        }),
      ],
    });
    runtime = TestBed.inject(ProjectionRuntime);
    service = TestBed.inject(IdentityLifetime);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
  const run = () =>
    service.run(demanded).subscribe((event) => events.push(event));

  it('is cold, acknowledges once, and owns projection until teardown', () => {
    const source = service.run(demanded);
    expect(connections).toBe(0);
    const subscription = source.subscribe((event) => events.push(event));
    expect(latest()).toMatchObject({
      condition: 'available',
      ownership: 'retained',
      preparation: 'acknowledged',
    });
    expect(events.filter((event) => event.kind === 'prepared')).toHaveLength(1);
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    expect(disconnections).toBe(1);
  });

  it('acknowledges no Account and attaches when demand appears', () => {
    activeAccountId.set(null);
    const subscription = run();
    TestBed.tick();
    expect(latest()).toMatchObject({
      demanded: false,
      condition: 'not-applicable',
    });
    expect(connections).toBe(0);
    activeAccountId.set('@b:example.org');
    TestBed.tick();
    expect(latest().condition).toBe('available');
    demanded.set(false);
    TestBed.tick();
    expect(latest().demanded).toBe(false);
    expect(disconnections).toBe(1);
    subscription.unsubscribe();
  });

  it('observes late reconciliation failure and authoritative success without releasing ownership', async () => {
    const subscription = run();
    failRead = true;
    invalidate();
    await Promise.resolve();
    expect(latest()).toMatchObject({
      condition: 'degraded',
      ownership: 'retained',
    });
    failRead = false;
    invalidate();
    await Promise.resolve();
    expect(latest().condition).toBe('available');
    expect(connections).toBe(1);
    subscription.unsubscribe();
  });

  it('classifies unknown attachment faults and explicitly retries a released lifetime', async () => {
    failAttach = true;
    const subscription = run();
    const failed = latest();
    expect(failed).toMatchObject({
      condition: 'degraded',
      ownership: 'released',
    });
    expect(JSON.stringify(events)).not.toContain('secret');
    failAttach = false;
    expect(
      await firstValueFrom(service.recover(failed.context, failed.generation)),
    ).toEqual({ kind: 'success' });
    expect(latest().condition).toBe('available');
    expect(connections).toBe(2);
    subscription.unsubscribe();
  });

  it('does not confuse externally released ownership with a successful empty barrier', async () => {
    const subscription = run();
    release();
    const failed = latest();
    expect(failed.ownership).toBe('released');
    // Another activation with the same ID is not ownership held by this lifetime.
    const other = runtime.activate({
      id: 'identity.presence',
      scope: { kind: 'active-account' },
      attach: () => undefined,
      reconcile: () => of(undefined),
      reset: () => undefined,
    });
    expect(latest().condition).toBe('degraded');
    other.release();
    expect(
      await firstValueFrom(service.recover(failed.context, failed.generation)),
    ).toEqual({ kind: 'success' });
    expect(connections).toBe(2);
    subscription.unsubscribe();
  });

  it('rejects retry from an obsolete Account before effects flush, and after stop/restart', async () => {
    failAttach = true;
    const first = run();
    const failed = latest();
    activeAccountId.set('@b:example.org');
    expect(
      await firstValueFrom(service.recover(failed.context, failed.generation)),
    ).toEqual({ kind: 'unavailable' });
    TestBed.tick();
    expect(latest().context).not.toBe(failed.context);
    first.unsubscribe();
    const second = run();
    expect(
      await firstValueFrom(service.recover(failed.context, failed.generation)),
    ).toEqual({ kind: 'unavailable' });
    second.unsubscribe();
  });

  it('bounds preparation without completing a healthy retained lifetime', () => {
    vi.useFakeTimers();
    stallRead = true;
    const subscription = run();
    expect(latest().preparation).toBe('pending');
    vi.advanceTimersByTime(10_000);
    expect(latest()).toMatchObject({
      code: 'presence-preparation-timeout',
      ownership: 'retained',
    });
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
  });
});
