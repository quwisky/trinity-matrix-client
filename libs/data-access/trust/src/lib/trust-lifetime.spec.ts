import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type CapabilityHealthFact,
} from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { NEVER, Observable, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustLifetime, type TrustLifetimeEvent } from './trust-lifetime';
import { TrustService } from './trust.service';
import { TrustVerificationService } from './trust-verification.service';

describe('TrustLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  let runtime: ProjectionRuntime;
  let service: TrustLifetime;
  let healthFailure: boolean;
  let verificationFailure: boolean;
  let stallHealth: boolean;
  let healthConnections: number;
  let verificationConnections: number;
  let healthRetries: number;
  let verificationRetries: number;
  let releaseHealth: () => void;
  let invalidateHealth: () => void;
  let invalidateVerification: () => void;
  let events: TrustLifetimeEvent[];

  const latest = (): CapabilityHealthFact => {
    const event = events
      .filter((candidate) => candidate.kind === 'health')
      .at(-1);
    if (!event || event.kind !== 'health')
      throw new Error('Missing Trust health');
    return event.fact;
  };

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    healthFailure = false;
    verificationFailure = false;
    stallHealth = false;
    healthConnections = 0;
    verificationConnections = 0;
    healthRetries = 0;
    verificationRetries = 0;
    events = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(TrustCryptoPort, { activeAccountId }),
        MockProvider(TrustService, {
          runProjection: () =>
            projection('trust.health', {
              failed: () => healthFailure,
              stalled: () => stallHealth,
              connected: () => (healthConnections += 1),
              controls: (invalidate, release) => {
                invalidateHealth = invalidate;
                releaseHealth = release;
              },
            }),
          retryProjection: () => {
            healthRetries += 1;
            invalidateHealth();
          },
        }),
        MockProvider(TrustVerificationService, {
          runProjection: () =>
            projection('crypto.verification-requests', {
              failed: () => verificationFailure,
              stalled: () => false,
              connected: () => (verificationConnections += 1),
              controls: (invalidate) => {
                invalidateVerification = invalidate;
              },
            }),
          retryProjection: () => {
            verificationRetries += 1;
            invalidateVerification();
          },
        }),
      ],
    });
    runtime = TestBed.inject(ProjectionRuntime);
    service = TestBed.inject(TrustLifetime);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  const run = () => service.run().subscribe((event) => events.push(event));

  it('is cold, acknowledges once, and owns both Trust projections until teardown', () => {
    const source = service.run();
    expect(healthConnections).toBe(0);
    expect(verificationConnections).toBe(0);

    const subscription = source.subscribe((event) => events.push(event));

    expect(latest()).toMatchObject({
      condition: 'available',
      ownership: 'retained',
      preparation: 'acknowledged',
    });
    expect(events.filter((event) => event.kind === 'prepared')).toHaveLength(1);
    expect(healthConnections).toBe(1);
    expect(verificationConnections).toBe(1);
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
  });

  it('treats no-Account dormancy as expected and attaches when an Account appears', () => {
    activeAccountId.set(null);
    const subscription = run();
    TestBed.tick();

    expect(latest()).toMatchObject({
      demanded: false,
      condition: 'not-applicable',
      code: 'trust-dormant',
    });
    expect(healthConnections).toBe(0);

    activeAccountId.set('@b:example.org');
    TestBed.tick();
    expect(latest().condition).toBe('available');
    expect(healthConnections).toBe(1);
    subscription.unsubscribe();
  });

  it('reports an initial refresh failure and repairs the retained failed projection only', async () => {
    healthFailure = true;
    const subscription = run();
    const failed = latest();

    expect(failed).toMatchObject({
      condition: 'degraded',
      ownership: 'retained',
      preparation: 'failed',
      code: 'trust-reconciliation-failed',
    });
    healthFailure = false;

    await expect(
      firstValueFrom(service.recover(failed.context, failed.generation)),
    ).resolves.toEqual({ kind: 'success' });
    expect(healthRetries).toBe(1);
    expect(verificationRetries).toBe(0);
    expect(healthConnections).toBe(1);
    expect(latest().condition).toBe('available');
    subscription.unsubscribe();
  });

  it('reports a later event failure without releasing ownership and clears it on current success', async () => {
    const subscription = run();
    healthFailure = true;
    invalidateHealth();
    await Promise.resolve();

    expect(latest()).toMatchObject({
      condition: 'degraded',
      ownership: 'retained',
      preparation: 'acknowledged',
    });
    healthFailure = false;
    invalidateHealth();
    await Promise.resolve();
    expect(latest().condition).toBe('available');
    subscription.unsubscribe();
  });

  it('targets a retained verification projection failure without restarting Trust health', async () => {
    verificationFailure = true;
    const subscription = run();
    const failed = latest();
    verificationFailure = false;

    await expect(
      firstValueFrom(service.recover(failed.context, failed.generation)),
    ).resolves.toEqual({ kind: 'success' });
    expect(verificationRetries).toBe(1);
    expect(healthRetries).toBe(0);
    expect(healthConnections).toBe(1);
    expect(verificationConnections).toBe(1);
    subscription.unsubscribe();
  });

  it('recreates both Trust projections when owned lifetime was released', async () => {
    const subscription = run();
    releaseHealth();
    const failed = latest();
    expect(failed).toMatchObject({
      condition: 'degraded',
      ownership: 'released',
      code: 'trust-ownership-released',
    });

    await expect(
      firstValueFrom(service.recover(failed.context, failed.generation)),
    ).resolves.toEqual({ kind: 'success' });
    expect(healthConnections).toBe(2);
    expect(verificationConnections).toBe(2);
    expect(latest().condition).toBe('available');
    subscription.unsubscribe();
  });

  it('isolates Accounts and rejects recovery from an obsolete generation', async () => {
    healthFailure = true;
    const subscription = run();
    const failedA = latest();

    healthFailure = false;
    activeAccountId.set('@b:example.org');
    expect(
      await firstValueFrom(
        service.recover(failedA.context, failedA.generation),
      ),
    ).toEqual({ kind: 'unavailable' });
    TestBed.tick();
    expect(latest().context).not.toBe(failedA.context);
    expect(latest().condition).toBe('available');
    subscription.unsubscribe();
  });

  it('bounds preparation without completing the retained session lifetime', () => {
    vi.useFakeTimers();
    stallHealth = true;
    const subscription = run();
    expect(latest().preparation).toBe('pending');

    vi.advanceTimersByTime(10_000);

    expect(latest()).toMatchObject({
      condition: 'degraded',
      ownership: 'retained',
      code: 'trust-preparation-timeout',
    });
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
  });

  function projection(
    id: string,
    options: {
      failed: () => boolean;
      stalled: () => boolean;
      connected: () => void;
      controls: (invalidate: () => void, release: () => void) => void;
    },
  ): Observable<void> {
    return new Observable((subscriber) => {
      options.connected();
      let release = (): void => undefined;
      const lease = runtime.activate({
        id,
        scope: { kind: 'active-account' },
        attach: (invalidate) => {
          options.controls(invalidate, () => release());
          return () => undefined;
        },
        reconcile: () =>
          options.stalled()
            ? NEVER
            : options.failed()
              ? throwError(() => new Error('private Trust fault'))
              : of(undefined),
        reset: () => undefined,
      });
      release = () => lease.release();
      subscriber.next();
      return release;
    });
  }
});
