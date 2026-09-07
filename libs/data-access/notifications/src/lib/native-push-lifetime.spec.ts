import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, lastValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NativePushHealth,
  NativePushLifetimeEvent,
} from './notification-health.models';
import { NativePushLifetime } from './native-push-lifetime';
import { PushGatewayService } from './push-gateway.service';
import {
  PushService,
  type NativePushEvent,
  type PushRuntimeStatus,
} from './push.service';

describe('NativePushLifetime', () => {
  const accountIds = signal<readonly string[]>(['@a:example.org']);
  const configured = signal(true);
  const disabled = signal(false);
  const runtimeStatus = signal<PushRuntimeStatus>({
    status: 'idle',
    code: 'push-registration-idle',
  });
  let prerequisite: ReturnType<PushService['runtimePrerequisite']> = 'ready';
  let streams: Subject<NativePushEvent>[] = [];
  const run = vi.fn(
    () =>
      new Observable<NativePushEvent>((subscriber) => {
        const stream = new Subject<NativePushEvent>();
        streams.push(stream);
        const subscription = stream.subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
  );
  const register = vi.fn(() => of(void 0));
  const retryRegistration = vi.fn(() => of(void 0));

  beforeEach(() => {
    vi.useRealTimers();
    accountIds.set(['@a:example.org']);
    configured.set(true);
    disabled.set(false);
    runtimeStatus.set({
      status: 'idle',
      code: 'push-registration-idle',
    });
    prerequisite = 'ready';
    streams = [];
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        NativePushLifetime,
        MockProvider(MatrixClientService, {
          accountIds: accountIds.asReadonly(),
        }),
        MockProvider(PushGatewayService, {
          configured: configured.asReadonly(),
          disabled: disabled.asReadonly(),
        }),
        MockProvider(PushService, {
          run,
          register,
          retryRegistration,
          runtimeStatus: runtimeStatus.asReadonly(),
          runtimePrerequisite: () => prerequisite,
        }),
      ],
    });
  });

  it('keeps unsupported native push as expected dormancy', () => {
    prerequisite = 'unsupported';
    const events: NativePushLifetimeEvent[] = [];
    const lifetime = TestBed.inject(NativePushLifetime)
      .run()
      .subscribe((event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        kind: 'health',
        fact: expect.objectContaining({
          demanded: false,
          condition: 'not-applicable',
          code: 'push-registration-unsupported',
        }),
      },
      { kind: 'prepared' },
    ]);
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('retries saved cleanup for a disabled gateway without attaching native listeners', () => {
    prerequisite = 'not-configured';
    configured.set(false);
    disabled.set(true);
    const lifetime = TestBed.inject(NativePushLifetime).run().subscribe();

    expect(retryRegistration).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('clears failed disabled-cleanup health after a successful Settings retry', async () => {
    prerequisite = 'not-configured';
    configured.set(false);
    disabled.set(true);
    runtimeStatus.set({
      status: 'degraded',
      code: 'push-pusher-registration-failed',
    });
    retryRegistration.mockReturnValueOnce(
      throwError(() => new Error('cleanup failed')),
    );
    const facts: NativePushHealth[] = [];
    const lifetime = TestBed.inject(NativePushLifetime)
      .run()
      .subscribe((event) => {
        if (event.kind === 'health') facts.push(event.fact);
      });
    TestBed.tick();
    expect(facts.at(-1)?.condition).toBe('degraded');

    await lastValueFrom(TestBed.inject(PushService).retryRegistration());
    runtimeStatus.set({ status: 'idle', code: 'push-registration-idle' });
    TestBed.tick();
    expect(facts.at(-1)).toMatchObject({
      condition: 'waiting-for-precondition',
      code: 'push-registration-not-configured',
      ownership: 'released',
    });
    expect(run).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('retains idle listeners without timing them after registration becomes healthy', () => {
    vi.useFakeTimers();
    const facts: NativePushHealth[] = [];
    const lifetime = TestBed.inject(NativePushLifetime)
      .run()
      .subscribe((event) => {
        if (event.kind === 'health') facts.push(event.fact);
      });

    runtimeStatus.set({
      status: 'available',
      code: 'push-registration-ready',
    });
    TestBed.tick();
    vi.advanceTimersByTime(30_000);

    expect(facts.at(-1)).toMatchObject({
      ownership: 'retained',
      condition: 'available',
      code: 'push-registration-ready',
    });
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
    vi.useRealTimers();
  });

  it('restarts a timed-out native registration during exact recovery', async () => {
    vi.useFakeTimers();
    const service = TestBed.inject(NativePushLifetime);
    const facts: NativePushHealth[] = [];
    const lifetime = service.run().subscribe((event) => {
      if (event.kind === 'health') facts.push(event.fact);
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const timedOut = facts.at(-1)!;
    expect(timedOut.code).toBe('push-registration-timeout');

    const recovery = lastValueFrom(
      service.recover(timedOut.context, timedOut.generation),
    );
    expect(retryRegistration).toHaveBeenCalledOnce();
    runtimeStatus.set({
      status: 'available',
      code: 'push-registration-ready',
    });
    TestBed.tick();

    await expect(recovery).resolves.toEqual({ kind: 'success' });
    lifetime.unsubscribe();
    vi.useRealTimers();
  });

  it('reattaches released listener ownership and rejects its obsolete recovery', async () => {
    const service = TestBed.inject(NativePushLifetime);
    const facts: NativePushHealth[] = [];
    const lifetime = service.run().subscribe((event) => {
      if (event.kind === 'health') facts.push(event.fact);
    });
    streams[0]?.complete();
    const released = facts.at(-1)!;

    const recovery = lastValueFrom(
      service.recover(released.context, released.generation),
    );
    expect(run).toHaveBeenCalledTimes(2);
    runtimeStatus.set({
      status: 'available',
      code: 'push-registration-ready',
    });
    TestBed.tick();
    await expect(recovery).resolves.toEqual({ kind: 'success' });

    await expect(
      lastValueFrom(service.recover(released.context, released.generation)),
    ).resolves.toEqual({ kind: 'unavailable' });
    lifetime.unsubscribe();
  });
});
